/**
 * 测试公共设施。
 *
 * 关键能力：**加载官方 DSH 实现**。`tools/ref-extract-validator.mjs` 会把
 * `@deepseek-ai/dsh-tools`（及传递依赖）从 app.asar 提取到 `.ref/dsh/`，
 * 于是测试可以用真正的 `assertSupportedJsonSchema` / `ToolRuntime` 来核对我们
 * 的工具定义，而不是拿一份自己仿造的检查器自证。
 * 没提取过时相关断言自动 skip，测试本身仍然可跑。
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
export const repoRoot = join(here, '..')
export const refRoot = join(repoRoot, '.ref', 'dsh')

/**
 * 本机 DSH 的 app.asar 路径。
 *
 * 写死一个路径会在换机器/换安装位置时静默退化：测试只是 **skip**，不报错，
 * 于是"官方实现交叉验证"这条最强的防线悄悄消失了。所以这里按候选列表探测，
 * 全都不存在时返回 `undefined`，由调用方决定 skip 并在 skip 信息里报出探测过的路径。
 */
export function asarPath() {
  const candidates = [
    process.env.DSH_ASAR,
    // 官方安装器默认位置（本机就是这里）
    'E:\\DSH\\resources\\app.asar',
    // 早期文档里写过的位置，保留以兼容别的机器
    'E:\\DSH-DeskTop\\resources\\app.asar',
    process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, 'Programs', 'DSH', 'resources', 'app.asar'),
    process.env.PROGRAMFILES === undefined ? undefined : join(process.env.PROGRAMFILES, 'DSH', 'resources', 'app.asar'),
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '' && existsSync(candidate)) return candidate
  }
  return undefined
}

/** 探测过的 app.asar 候选路径（写进 skip 信息，便于一眼看出为什么没跑）。 */
export function asarCandidates() {
  return [
    'env DSH_ASAR',
    'E:\\DSH\\resources\\app.asar',
    'E:\\DSH-DeskTop\\resources\\app.asar',
    '%LOCALAPPDATA%\\Programs\\DSH\\resources\\app.asar',
    '%PROGRAMFILES%\\DSH\\resources\\app.asar',
  ]
}

/** `.ref/dsh` 是否已提取（决定官方校验器断言是否可跑）。 */
export function refAvailable() {
  return existsSync(join(refRoot, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
}

/** 从 `.ref/dsh` 的扁平 node_modules 里加载官方 DSH 包。 */
export async function loadDshPackage(specifier) {
  const require = createRequire(join(refRoot, 'index.js'))
  const resolved = require.resolve(specifier)
  return await import(pathToFileURL(resolved).href)
}

/** 上游 Computer Use 的工具名集合（ZCode cuaSummaryMessages.ts 的键）。 */
export const UPSTREAM_TOOL_NAMES = [
  'request_access',
  'list_apps',
  'list_windows',
  'get_app_state',
  'screenshot',
  'zoom',
  'open_application',
  'left_click',
  'double_click',
  'triple_click',
  'right_click',
  'middle_click',
  'scroll',
  'left_click_drag',
  'mouse_move',
  'type',
  'set_value',
  'select_text',
  'key',
  'hold_key',
  'perform_action',
  'wait',
  'read_clipboard',
  'write_clipboard',
  'stop_computer_control',
]

/** 只读工具（不得注入输入）。 */
export const READ_ONLY_TOOL_NAMES = new Set([
  'request_access',
  'list_apps',
  'list_windows',
  'get_app_state',
  'screenshot',
  'zoom',
  'read_clipboard',
])

/**
 * 造一个记录调用的假后端。
 * @param responder `(cmd, args) => data | Promise<data>`，抛错即模拟后端失败
 */
export function createFakeCall(responder = () => ({})) {
  const calls = []
  const call = async (cmd, args = {}, exec = {}, budget = 'default') => {
    calls.push({ cmd, args, budget })
    return await responder(cmd, args, exec)
  }
  return { call, calls }
}

/**
 * 造一个工具运行时（tools.js 需要的形状），后端用假 call。
 */
export function createFakeRuntime({ responder, attachments, calls, config } = {}) {
  const recorder = calls ?? []
  const runtime = {
    longTimeoutMs: 60000,
    async call(cmd, args = {}, exec = {}, budget = 'default') {
      recorder.push({ cmd, args, budget })
      return await (responder ?? (() => ({})))(cmd, args, exec)
    },
    defaultScreenshotArgs: () => ({ max_width: 1600, format: 'png' }),
    screenshotBudget: () => 524288,
    jpegQuality: () => 80,
    async saveFrame() {
      return undefined
    },
    async attachImage() {
      return attachments
    },
    async probe() {
      return { ok: true, info: { protocol: 'dsh-cua/1', dpiAware: true, psVersion: '5.1.0' } }
    },
    calls: recorder,
  }
  return runtime
}

/** 一个可注入 spawnImpl 的假子进程。 */
export class FakeChild extends EventEmitter {
  /**
   * @param options.autoShutdown 收到 shutdown 请求时自动应答并退出（默认 true）——
   *   否则每次 dispose 都要等满 shutdown 超时，测试会平白慢 3 秒。
   */
  constructor(options = {}) {
    super()
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    this.writes = []
    this.killed = false
    this.autoShutdown = options.autoShutdown !== false
    this.stdout.setEncoding = () => {}
    this.stderr.setEncoding = () => {}
    this.stdin = {
      write: (chunk) => {
        const text = String(chunk)
        this.writes.push(text)
        if (this.autoShutdown) {
          queueMicrotask(() => {
            let request
            try {
              request = JSON.parse(text.trim())
            } catch {
              return
            }
            if (request.cmd !== 'shutdown') return
            this.emitLine({ id: request.id, ok: true, data: { stopped: true } })
            this.emit('exit', 0, null)
          })
        }
        return true
      },
      end: () => {},
    }
  }

  /** 模拟后端输出一行 NDJSON。 */
  emitLine(payload) {
    this.stdout.emit('data', `${JSON.stringify(payload)}\n`)
  }

  emitStderr(text) {
    this.stderr.emit('data', text)
  }

  kill() {
    this.killed = true
    this.emit('exit', null, 'SIGTERM')
  }

  /** 解析最后一行的请求。 */
  lastRequest() {
    const raw = this.writes.at(-1)
    return raw === undefined ? undefined : JSON.parse(raw.trim())
  }
}

/**
 * 造一个记录注册的假 cordis 上下文。
 * @param options.services `ctx.get(name)` 的返回值表
 * @param options.logger 注入的日志器（默认静默）
 */
export function createFakeContext({ services = {}, logger } = {}) {
  const registrations = []
  const effects = []
  const listeners = new Map()
  const logged = []
  const silentLogger = {
    info: (m) => logged.push(['info', m]),
    warn: (m) => logged.push(['warn', m]),
    error: (m) => logged.push(['error', m]),
  }
  const ctx = {
    logger: logger ?? silentLogger,
    tools: {
      register(definition) {
        registrations.push(definition)
        // 与官方注册表同源的准入检查：output 必须有 schema 与 render。
        const output = definition.output
        if (output === undefined || typeof output.render !== 'function') {
          throw new TypeError(`tool "${definition.name}" must declare output { schema, render, presentationMeta? }`)
        }
        return () => {
          const index = registrations.indexOf(definition)
          if (index >= 0) registrations.splice(index, 1)
        }
      },
    },
    get(name) {
      return services[name]
    },
    effect(fn) {
      effects.push(fn)
      return () => {}
    },
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => {}
    },
    registrations,
    effects,
    listeners,
    logged,
    /** 触发所有 effect 的清理函数。 */
    dispose() {
      for (const fn of effects) {
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanup()
      }
      for (const fn of listeners.get('dispose') ?? []) fn()
    },
  }
  return ctx
}
