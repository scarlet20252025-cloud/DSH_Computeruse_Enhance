/**
 * 原生后端客户端：一个长驻的 Windows PowerShell 5.1 进程，NDJSON 双向通信。
 *
 * 形态与 ZCode 的 Computer Use Helper 同构（长驻 helper + 行分隔 JSON 协议 +
 * 每次请求一个响应），但传输层从「Unix socket + 原生 Helper」换成
 * 「子进程 stdin/stdout + PowerShell」，原因见 docs/native-protocol.md：
 * Windows 上没有随包发布的原生 Helper，而 System.Drawing / UI Automation
 * 在 5.1 宿主里开箱可用。
 *
 * 设计要点：
 *  1. 协议是**串行**的：一次只允许一个在飞请求，队列化。
 *  2. 调用超时 = 进程不可信。超时后不猜测响应归属，直接 kill 并在下次调用时重启，
 *     否则一条迟到的响应会错配到下一条请求上（比报错危险得多）。
 *  3. 崩溃/被杀可自愈：`maxRestarts` 次内自动重启；超出后给出明确不可用原因。
 *  4. 可注入 `spawnImpl`，便于单测不启动真实 PowerShell。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 原生后端返回的结构化错误。 */
export class BridgeError extends Error {
  /**
   * @param code 协议错误码（docs/native-protocol.md §5）
   * @param message 人类可读说明
   * @param details 附加结构化信息
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

/** 后端不可用（未启动失败、重启耗尽、平台不支持）。 */
export class BridgeUnavailableError extends Error {
  constructor(message, cause) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'BridgeUnavailableError'
    this.code = 'BACKEND_UNAVAILABLE'
  }
}

const MAX_STDERR_LINES = 60

/**
 * @typedef {object} BridgeOptions
 * @property {string|URL} scriptPath 原生脚本路径
 * @property {string} [executable] PowerShell 可执行文件，默认 `powershell.exe`
 * @property {number} [defaultTimeoutMs] 单次调用默认超时
 * @property {number} [startupTimeoutMs] 等待 ready 横幅的上限
 * @property {number} [maxRestarts] 自动重启次数上限
 * @property {(message: string) => void} [onDiagnostic] 后端 stderr 诊断回调
 * @property {Function} [spawnImpl] 测试注入点，签名同 child_process.spawn
 * @property {NodeJS.ProcessEnv} [env]
 */

export class NativeBridge {
  #scriptPath
  #executable
  #defaultTimeoutMs
  #startupTimeoutMs
  #maxRestarts
  #onDiagnostic
  #spawnImpl
  #env
  #child
  #stdoutBuffer = ''
  #pending = null
  #ready = null
  #queue = Promise.resolve()
  #restarts = 0
  #disposed = false
  #stderrLines = []
  #readyInfo = null
  #exitInfo = null

  constructor(options = {}) {
    // 必须是文件系统路径字符串：把 URL 直接交给 spawn 会让 PowerShell 收到
    // `file:///E:/…` 并以「不支持给定路径的格式」立刻退出（端到端测试抓到的真 bug，
    // 单元测试因为用的是字符串路径而漏掉了）。
    this.#scriptPath = options.scriptPath instanceof URL
      ? fileURLToPath(options.scriptPath)
      : String(options.scriptPath ?? '')
    this.#executable = options.executable ?? 'powershell.exe'
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30000
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 20000
    this.#maxRestarts = options.maxRestarts ?? 3
    this.#onDiagnostic = options.onDiagnostic ?? (() => {})
    this.#spawnImpl = options.spawnImpl ?? nodeSpawn
    this.#env = options.env
  }

  /** 最近一次就绪横幅里的后端自述（协议/版本/DPI/屏幕）。 */
  get readyInfo() {
    return this.#readyInfo
  }

  /** 后端是否是活着的（已就绪且子进程未退出）。 */
  get alive() {
    return this.#child !== undefined && this.#child !== null && this.#exitInfo === null
  }

  /** 后端诊断尾部（stderr），用于把「为什么不可用」讲清楚。 */
  get diagnostics() {
    return this.#stderrLines.join('\n')
  }

  /**
   * 确保后端进程已启动并就绪；并发调用共享同一次启动。
   * @returns 就绪横幅的 data 部分
   */
  async ensureStarted() {
    if (this.#disposed) throw new BridgeUnavailableError('computer-use backend has been disposed')
    if (this.alive && this.#readyInfo !== null) return this.#readyInfo
    if (this.#ready !== null) return await this.#ready
    if (this.#restarts > this.#maxRestarts) {
      throw new BridgeUnavailableError(
        `computer-use backend crashed ${this.#restarts} times and will not be restarted automatically` +
          (this.#stderrLines.length > 0 ? `\nlast diagnostics:\n${this.diagnostics}` : ''),
      )
    }
    this.#ready = this.#start().finally(() => {
      this.#ready = null
    })
    return await this.#ready
  }

  async #start() {
    if (this.#scriptPath === '') throw new BridgeUnavailableError('native script path is not configured')
    this.#stdoutBuffer = ''
    this.#exitInfo = null
    this.#stderrLines = []

    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      this.#scriptPath,
    ]

    let child
    try {
      child = this.#spawnImpl(this.#executable, args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(this.#env === undefined ? {} : { env: this.#env }),
      })
    } catch (error) {
      throw new BridgeUnavailableError(
        `cannot start computer-use backend (${this.#executable}): ${error instanceof Error ? error.message : String(error)}`,
        error,
      )
    }
    this.#child = child

    const banner = new Promise((resolve, reject) => {
      this.#bannerResolve = resolve
      this.#bannerReject = reject
    })
    const timer = setTimeout(() => {
      this.#failStart(new BridgeUnavailableError(
        `computer-use backend did not report ready within ${this.#startupTimeoutMs} ms` +
          (this.#stderrLines.length > 0 ? `\nlast diagnostics:\n${this.diagnostics}` : ''),
      ))
    }, this.#startupTimeoutMs)
    // **不要 unref**：调用方正在等这个定时器给出的失败结果。
    // unref 的语义是「不阻止进程退出」，于是在没有别的句柄的进程里，事件循环先空掉、
    // 进程带着未 settle 的 await 退出：
    //   `Promise resolution is still pending but the event loop has already resolved`
    // 这个缺陷在本地被其它句柄掩盖，是 CI（windows-latest / Node 22）先暴露出来的。
    // 复盘：docs/reverse-engineering.md「CI 抓到的第一个真 bug」。

    child.stdout?.setEncoding?.('utf8')
    child.stdout?.on?.('data', (chunk) => this.#onStdout(chunk))
    child.stderr?.setEncoding?.('utf8')
    child.stderr?.on?.('data', (chunk) => this.#onStderr(chunk))
    child.on?.('error', (error) => {
      this.#failStart(new BridgeUnavailableError(
        `computer-use backend process error: ${error instanceof Error ? error.message : String(error)}`,
        error,
      ))
    })
    child.on?.('exit', (code, signal) => {
      this.#exitInfo = { code, signal }
      // 重启计数只统计「曾经就绪的进程意外死亡」，并且 dispose 期间不算。
      if (this.#disposed !== true && this.#readyInfo !== null) this.#restarts += 1
      const reason = new BridgeUnavailableError(
        `computer-use backend exited (code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''})` +
          (this.#stderrLines.length > 0 ? `\nlast diagnostics:\n${this.diagnostics}` : ''),
      )
      if (this.#pending !== null) {
        const pending = this.#pending
        this.#pending = null
        pending.reject(reason)
      }
      if (this.#bannerReject !== undefined && this.#bannerResolve !== undefined && this.#readyInfo === null) {
        this.#failStart(reason)
      }
    })

    try {
      const info = await banner
      clearTimeout(timer)
      this.#readyInfo = info
      return info
    } catch (error) {
      clearTimeout(timer)
      this.#kill()
      throw error
    }
  }

  #bannerResolve
  #bannerReject

  #failStart(error) {
    const reject = this.#bannerReject
    this.#bannerResolve = undefined
    this.#bannerReject = undefined
    if (reject !== undefined) reject(error)
  }

  #onStderr(chunk) {
    const text = String(chunk)
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      this.#stderrLines.push(trimmed)
      if (this.#stderrLines.length > MAX_STDERR_LINES) this.#stderrLines.shift()
      try {
        this.#onDiagnostic(trimmed)
      } catch {
        /* 诊断回调失败不影响协议 */
      }
    }
  }

  #onStdout(chunk) {
    this.#stdoutBuffer += String(chunk)
    for (;;) {
      const newline = this.#stdoutBuffer.indexOf('\n')
      if (newline < 0) break
      const line = this.#stdoutBuffer.slice(0, newline).replace(/\r$/u, '')
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1)
      const trimmed = line.trim()
      if (trimmed === '') continue
      let payload
      try {
        payload = JSON.parse(trimmed)
      } catch {
        this.#onDiagnostic(`non-JSON line on backend stdout: ${trimmed.slice(0, 400)}`)
        continue
      }
      this.#dispatch(payload)
    }
  }

  #dispatch(payload) {
    if (payload.event === 'ready' && payload.id === null) {
      const resolve = this.#bannerResolve
      this.#bannerResolve = undefined
      this.#bannerReject = undefined
      if (resolve !== undefined) resolve(payload.data ?? {})
      return
    }
    const pending = this.#pending
    if (pending === null) {
      this.#onDiagnostic(`unexpected backend response: ${JSON.stringify(payload).slice(0, 300)}`)
      return
    }
    if (payload.id !== pending.id) {
      pending.reject(new BridgeError('PROTOCOL_MISMATCH', `backend response id ${String(payload.id)} does not match request ${pending.id}`))
      this.#pending = null
      pending.settle()
      return
    }
    this.#pending = null
    pending.settle()
    if (payload.ok === true) {
      pending.resolve(payload.data ?? {})
    } else {
      const error = payload.error ?? {}
      pending.reject(new BridgeError(
        typeof error.code === 'string' ? error.code : 'INTERNAL',
        typeof error.message === 'string' ? error.message : 'computer-use backend reported a failure',
        error.details,
      ))
    }
  }

  #kill() {
    const child = this.#child
    this.#child = undefined
    if (child === undefined || child === null) return
    try {
      child.stdin?.end?.()
    } catch {
      /* 已经关了 */
    }
    try {
      child.kill?.()
    } catch {
      /* 已经退了 */
    }
  }

  /**
   * 发一条请求并等响应。
   * @param {string} cmd 协议方法名
   * @param {object} [args] 方法参数
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   * @returns {Promise<object>} 响应 data
   */
  async call(cmd, args = {}, options = {}) {
    const run = async () => {
      const info = await this.ensureStarted()
      if (options.signal?.aborted === true) throw abortError(options.signal)
      const id = `${Date.now().toString(36)}-${(this.#idCounter += 1).toString(36)}`
      const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs
      return await new Promise((resolve, reject) => {
        let settled = false
        const settle = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          options.signal?.removeEventListener?.('abort', onAbort)
        }
        const timer = setTimeout(() => {
          if (settled) return
          settle()
          // 超时后进程状态不可知：直接换掉它，避免迟到响应错配到下一条请求。
          this.#pending = null
          this.#kill()
          reject(new BridgeError('TIMEOUT', `computer-use backend did not answer ${cmd} within ${timeoutMs} ms`))
        }, timeoutMs)
        // **不要 unref**：超时的 reject 正是调用方在等的结果。见 #start 里同一处注释。
        const onAbort = () => {
          if (settled) return
          settle()
          this.#pending = null
          this.#kill()
          reject(abortError(options.signal))
        }
        options.signal?.addEventListener?.('abort', onAbort, { once: true })
        this.#pending = {
          id,
          resolve: (data) => {
            settle()
            resolve(data)
          },
          reject: (error) => {
            settle()
            reject(error)
          },
          settle,
        }
        try {
          this.#child?.stdin?.write?.(`${JSON.stringify({ id, cmd, args })}\n`)
        } catch (error) {
          this.#pending = null
          settle()
          reject(new BridgeUnavailableError(
            `cannot write to computer-use backend: ${error instanceof Error ? error.message : String(error)}`,
            error,
          ))
        }
      })
    }
    // 串行化：协议一次只承载一个请求。
    const queued = this.#queue.then(run, run)
    this.#queue = queued.then(() => undefined, () => undefined)
    return await queued
  }

  /** 只读探测：后端是否可用（不抛异常）。 */
  async probe(timeoutMs) {
    try {
      const info = await this.ensureStarted()
      await this.call('ping', {}, { timeoutMs: timeoutMs ?? 8000 })
      return { ok: true, info }
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        code: error?.code,
      }
    }
  }

  /** 关闭后端并释放资源（幂等）。 */
  async dispose() {
    if (this.#disposePromise === undefined) this.#disposePromise = this.#disposeOnce()
    return await this.#disposePromise
  }

  async #disposeOnce() {
    const child = this.#child
    if (child !== undefined && child !== null && this.#exitInfo === null) {
      // 先礼貌关闭（这必须在 #disposed 置位之前，否则 ensureStarted 会拒绝这次请求）。
      // 预算刻意收紧：dispose 是同步生命周期回调里 fire-and-forget 出去的，
      // 等太久会让「调用方进程先退出」变成「后端进程被遗留」。
      try {
        await this.call('shutdown', {}, { timeoutMs: 1500 })
      } catch {
        /* 关不掉就直接 kill */
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(undefined), 600)
        // 同上：这 600ms 是 dispose 的兜底上限，不能被 unref 掉，
        // 否则进程可能在等它的过程中就直接退出了。
        if (this.#exitInfo !== null) {
          clearTimeout(timer)
          resolve(undefined)
          return
        }
        child.once?.('exit', () => {
          clearTimeout(timer)
          resolve(undefined)
        })
      })
    }
    this.#disposed = true
    this.#kill()
  }

  #disposePromise
  #idCounter = 0
}

/** 把 AbortSignal 的 reason 转成标准 abort 错误。 */
export function abortError(signal) {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  return new DOMException('The operation was aborted.', 'AbortError')
}
