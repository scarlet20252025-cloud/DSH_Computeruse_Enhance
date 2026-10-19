/**
 * dsh-computer-use 宿主端入口。
 *
 * 把 ZCode「Computer Use / 电脑控制」那套能力重建为 DSH 插件：以 25 个与上游同名的
 * 工具面对模型暴露桌面应用、窗口与界面元素的读取与操作（含截图、鼠标、键盘、剪贴板），
 * 后端是长驻的 Windows PowerShell 5.1 进程（见 docs/native-protocol.md）。
 *
 * 为什么不用 `defineTool`：`@deepseek-ai/dsh-tools` 不在插件可解析的模块路径上
 * （实测 `createRequire(profile/index.js).resolve('@deepseek-ai/dsh-tools')` 失败），
 * 所以这里用注册表接受的**原始 JSON Schema 定义**直接 `ctx.tools.register()`——
 * 这正是 MCP 服务器发现工具后注册的方式，属于官方扩展点而非绕过。
 * 参数校验由 src/schema.js 按同一套子集语义补上。
 *
 * 后端不可用（没有 PowerShell、被策略拦、脚本被删）时**不阻断开载**：
 * 工具照常注册，调用时报明确原因，`request_access` 给出可读的环境自述——
 * 这比整个插件加载失败更容易排查。
 */
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { NativeBridge, BridgeError, BridgeUnavailableError } from './bridge.js'
import {
  AccessDeniedError,
  classifyCaller,
  decideAccess,
  describeSettings,
  interpretApprovalOutcome,
  parseCommandArguments,
  settingsPayload,
} from './access.js'
import {
  DEFAULT_CONFIG,
  configPath,
  framesDir,
  indicatorScriptPath,
  nativeScriptPath,
  normalizeConfig,
  readConfig,
  writeConfig,
} from './config.js'
import { OperationIndicator, detectLocale } from './indicator.js'
import { createToolDefinitions } from './tools.js'
import { assertArgs, coerceArgs, toLosslessJson } from './schema.js'
import { ensureSkillInstalled } from './skill.js'

/** Loader 显示的插件名。 */
export const name = 'dsh-computer-use'

/** 只需要工具注册表；attachments / llm 是可选加成，用 ctx.get 探测。 */
export const inject = ['tools']

/**
 * 注册前的统一包装：访问闸门 + 参数校验（含无损宽化）+ 输出清洗 + 操作指示器。
 *
 * 导出是为了让测试走**与生产完全相同的路径**——真机验证（`dsh headless` 里让模型
 * 真的点一次按钮）抓到的 `tool "left_click" returned invalid output: value is not
 * lossless JSON` 就发生在这里：当时测试只调 handler 本身，绕过了这一层。
 *
 * 闸门放在最前面：被拒绝的调用**不该**点亮操作指示器（屏幕上什么都没发生，
 * 却让用户看到「DSH 正在操作电脑」，那是在骗人）。
 * @param definition 工具定义（`parameters` + `execute`）
 * @param [indicator] 操作指示器；`note()` 是同步 fire-and-forget，不会拖慢工具
 * @param [resolveToolName] 从入参解析出用于文案的动作名（`single` 模式下动作在 `args.action`）
 * @param [access] 访问闸门：`{read(), approval?}`；缺失时按「全自动 + 不允许子代理」处理
 * @returns 注册用的 execute；入参先宽化校验，返回值先清洗成无损 JSON
 */
export function createGuardedExecute(definition, indicator, resolveToolName, access) {
  const args = definition.parameters
  const invoke = definition.execute
  const toolName = definition.name
  return async function guardedExecute(rawArgs, exec) {
    const coerced = coerceArgs(args, rawArgs ?? {})
    assertArgs(args, coerced)
    const label = resolveToolName === undefined ? toolName : resolveToolName(coerced)

    await enforceAccess({ access, label, exec })

    // 指示器在动作**开始前**就亮起（用户要看到的是「正在操作」，不是「刚操作过」）。
    // `stop_computer_control` 例外：它表达的是控制权已交还，指示器会立刻收起。
    indicator?.note?.(label, { terminal: label === 'stop_computer_control' })
    // DSH 会拒绝含 undefined 的返回值，而副作用此时已经发生——那种失败最难排查
    // （看起来像工具失败，实际桌面已经动了），所以清洗必须在这一层兜住。
    return toLosslessJson(await invoke(coerced, exec))
  }
}

/**
 * 执行访问闸门；不放行就抛 {@link AccessDeniedError}（不返回「成功但被拒绝」的结果，
 * 因为那样模型会以为动作完成了）。
 *
 * 「需要询问」走 DSH 原生审批：`ctx.approval.request()` 会在用户客户端弹出标准审批面板，
 * 我们不需要（也无法）自己画一个。`allowed-once` 之外的任何结果都按拒绝处理。
 * @param options.access 闸门（`{read(), approval?}`）
 * @param options.label 工具/动作名（进审批面板与错误消息）
 * @param options.exec 工具执行上下文
 */
async function enforceAccess({ access, label, exec }) {
  if (access === undefined || typeof access.read !== 'function') return
  const settings = access.read()
  const caller = classifyCaller(exec)
  const decision = decideAccess({
    mode: settings.accessMode,
    allowSubagents: settings.allowSubagents,
    caller,
  })
  if (decision.effect === 'deny') throw new AccessDeniedError(decision.code, decision.message)
  if (decision.effect !== 'ask') return

  const approval = access.approval
  if (approval === undefined || typeof approval.request !== 'function') {
    throw new AccessDeniedError(
      'CUA_APPROVAL_UNAVAILABLE',
      '电脑操控设置为「需要询问」，但当前 DSH 环境没有可用的审批服务，按最小授权拒绝。' +
        '请在输入框那一行的「电脑操控」菜单里改为「全自动」，或检查 DSH 的权限预设。',
    )
  }
  let outcome
  try {
    outcome = await approval.request({
      agent: exec?.agent,
      toolName: label,
      ...(exec?.callId === undefined ? {} : { callId: exec.callId }),
      reason: `电脑操控请求执行「${label}」：它会真的移动鼠标/敲键盘或读取屏幕内容。`,
      ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
    })
  } catch (error) {
    throw new AccessDeniedError(
      'CUA_APPROVAL_FAILED',
      `电脑操控的审批请求失败（${error instanceof Error ? error.message : String(error)}），已按拒绝处理。`,
    )
  }
  const verdict = interpretApprovalOutcome(outcome)
  if (verdict.allowed !== true) throw new AccessDeniedError('CUA_APPROVAL_DENIED', verdict.message)
}

/**
 * @param {object} ctx cordis 上下文
 * @param {object} [inlineConfig] profile 里给本插件的 `config:` 覆盖
 */
export async function apply(ctx, inlineConfig) {
  const log = createLogger(ctx)

  // 文件配置是基线，profile 内联配置覆盖它（与 dsh-remind 的约定一致）。
  const fileConfig = await readConfig()
  const config = normalizeConfig({ ...fileConfig, ...(inlineConfig ?? {}) })
  if (config.enabled !== true) {
    log.info('dsh-computer-use is disabled by configuration; no tools registered')
    return
  }

  const bridge = new NativeBridge({
    scriptPath: nativeScriptPath(),
    defaultTimeoutMs: config.requestTimeoutMs,
    startupTimeoutMs: config.startupTimeoutMs,
    maxRestarts: config.maxRestarts,
    onDiagnostic: config.debug ? (line) => log.warn(`[native] ${line}`) : () => {},
  })

  // 操作指示器：屏幕最前端、点击穿透、不抢焦点、不进截图的小卡片。
  // 它纯粹是给用户的可见性保证，因此任何失败都只记日志，绝不冒泡到工具调用。
  const indicator = new OperationIndicator({
    enabled: config.indicator === true,
    scriptPath: indicatorScriptPath(),
    locale: config.indicatorLocale === 'auto' ? detectLocale() : config.indicatorLocale,
    showAction: config.indicatorShowAction,
    autoHideMs: config.indicatorAutoHideMs,
    log,
  })

  const imageRouteCache = new Map()

  // 访问设置的**活状态**：`/computer-use` 命令改它、闸门每次调用读它，
  // 所以菜单里一改就立即生效，不需要重启 DSH。
  const accessState = { accessMode: config.accessMode, allowSubagents: config.allowSubagents }
  const access = {
    read: () => ({ ...accessState }),
    /** 审批服务：DSH 原生。拿不到服务时闸门会按最小授权拒绝（见 enforceAccess）。 */
    get approval() {
      try {
        return typeof ctx.get === 'function' ? ctx.get('approval') : ctx.approval
      } catch {
        return undefined
      }
    },
  }

  const runtime = {
    longTimeoutMs: config.screenshotTimeoutMs,

    /** 后端调用：把非结构化失败也翻成可读错误。 */
    async call(cmd, args = {}, exec = {}, budget = 'default') {
      const timeoutMs = budget === 'long' ? config.screenshotTimeoutMs : config.requestTimeoutMs
      try {
        return await bridge.call(cmd, args, { timeoutMs, signal: exec?.signal })
      } catch (error) {
        if (error instanceof BridgeError || error instanceof BridgeUnavailableError) throw error
        if (error?.name === 'AbortError') throw error
        throw new BridgeUnavailableError(
          `computer-use backend call ${cmd} failed: ${error instanceof Error ? error.message : String(error)}`,
          error,
        )
      }
    },

    /** 只读可用性探测，供 request_access 使用。 */
    async probe() {
      const result = await bridge.probe(Math.min(config.startupTimeoutMs, 12000))
      if (result.ok !== true) log.warn(`computer-use backend unavailable: ${result.reason}`)
      return result
    },

    /**
     * 访问设置自报（`request_access` 用）。
     * 让模型知道「此刻允不允许」，也让诊断有据可查：界面改了设置，这里立刻能看到。
     */
    accessReport() {
      return {
        mode: accessState.accessMode,
        allowSubagents: accessState.allowSubagents === true,
        label: describeSettings(accessState),
      }
    },

    /** 截图默认参数。 */
    defaultScreenshotArgs() {      return {
        ...(config.screenshotMaxWidth > 0 ? { max_width: config.screenshotMaxWidth } : {}),
        format: config.screenshotFormat,
        ...(config.screenshotFormat === 'jpeg' ? { quality: config.screenshotQuality } : {}),
      }
    },

    /** 单张截图的字节预算（超出会降级重拍）。 */
    screenshotBudget() {
      return config.screenshotMaxBytes
    },

    /** 降级到 JPEG 时用的质量。 */
    jpegQuality() {
      return config.screenshotQuality
    },

    /** 栅格落盘（可关）。 */
    async saveFrame(base64, { mediaType, frameId, zoomed }) {
      if (config.saveFrames !== true || typeof base64 !== 'string' || base64 === '') return undefined
      try {
        const dir = await framesDir()
        await mkdir(dir, { recursive: true })
        const ext = mediaType === 'image/jpeg' ? 'jpg' : 'png'
        const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
        const path = join(dir, `frame-${stamp}-${frameId ?? 'noframe'}${zoomed ? '-zoom' : ''}.${ext}`)
        await writeFile(path, Buffer.from(base64, 'base64'))
        void pruneFrames(dir, config.keepFrames, log)
        return path
      } catch (error) {
        log.warn(`could not save screenshot frame: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    },

    /**
     * 把截图挂成原生图像块（等价于内置 read_image 的做法）。
     * 任何一步不满足就返回 undefined，让调用方退回纯文本信封——
     * 截图本身仍然有用，不该因为附加失败而整体失败。
     */
    async attachImage(base64, mediaType, savedPath, exec) {
      if (typeof base64 !== 'string' || base64 === '') return undefined
      const attachments = ctx.get?.('attachments')
      if (attachments === undefined || attachments === null) return undefined
      try {
        const limits = attachments.imageLimits
        if (Array.isArray(limits?.mediaTypes) && !limits.mediaTypes.includes(mediaType)) return undefined
        const bytes = Buffer.from(base64, 'base64')
        if (Number.isFinite(limits?.maxImageBytes) && bytes.byteLength > limits.maxImageBytes) return undefined
        if (Number.isFinite(limits?.maxMessageImageBytes) && bytes.byteLength > limits.maxMessageImageBytes) return undefined
        if ((await supportsImageRoute(exec)) !== true) return undefined
        const ref = await attachments.saveImage({
          data: bytes,
          mediaType,
          name: savedPath === undefined ? 'computer-use-screenshot.png' : basename(savedPath),
        })
        return {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
        }
      } catch (error) {
        log.warn(`could not attach screenshot image: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    },
  }

  /**
   * 路由是否声明了图像输入。与内置 read_image 的门禁同源：
   * 文本路由不附加图像块，避免持久历史里出现模型读不了的块。
   */
  async function supportsImageRoute(exec) {
    const llm = ctx.get?.('llm')
    const routed = exec?.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec?.agent?.options?.provider
    const model = routed?.model ?? exec?.agent?.options?.model
    if (llm === undefined || llm === null || provider === undefined || model === undefined) return false
    const key = `${provider}:${model}`
    const cached = imageRouteCache.get(key)
    if (cached !== undefined && Date.now() - cached.at < 30000) return cached.value
    let value = false
    try {
      const info = await llm.resolveModelInfo(provider, model, exec?.signal)
      value = Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
    } catch {
      value = false
    }
    imageRouteCache.set(key, { at: Date.now(), value })
    return value
  }

  const { native, single } = createToolDefinitions(runtime)
  const definitions = config.tools === 'single' ? [single.definition] : native

  const disposers = []
  // `single` 模式下模型的 tool 名是 computer_use，真正执行的动作在 args.action 里；
  // 指示器要显示的是**那个动作**（"· 点击" 而不是 "· computer_use"）。
  const resolveToolName =
    config.tools === 'single'
      ? (rawArgs) => (typeof rawArgs?.action === 'string' ? rawArgs.action : 'computer_use')
      : undefined
  for (const definition of definitions) {
    const guarded = {
      ...definition,
      execute: createGuardedExecute(definition, indicator, resolveToolName, access),
    }
    const dispose = ctx.tools.register(guarded)
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  // 「电脑操控」设置命令：GUI 输入框那一行的菜单就是提交它来实现的，
  // 也可以手打（`/computer-use mode ask`）。设置写进插件自己的 config.json，
  // 并同步更新内存活状态——两者一致才能既持久化又立即生效。
  registerAccessCommand({ ctx, accessState, log })

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const disposer of disposers.reverse()) {
      try {
        disposer()
      } catch {
        /* 注册表可能已经随作用域销毁 */
      }
    }
    void bridge.dispose()
    // 指示器必须跟着走：插件卸载后还挂在屏幕最前端，就是在向用户撒谎。
    void indicator.dispose()
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
  else if (typeof ctx.on === 'function') ctx.on('dispose', dispose)

  // 回合结束即收起（上游语义：turn 终态隐藏浮层，而不是等 30s 兜底）。
  // 事件是**可选加成**：作用域不同可能收不到，收不到时 30s 兜底仍然管用。
  // 刚发生过动作就判 idle 的情况要忽略——那多半是另一个 agent/会话的 idle，
  // 不该把正在进行的浮层收掉。
  // 接线与开关**解耦**：监听器总是挂上，禁用在控制器内部是 no-op，
  // 这样「有没有接线」不会被「有没有开浮层」污染（测试也就不会因为接线而拉起进程）。
  if (typeof ctx.on === 'function') {
    ctx.on('agent/status', (payload) => {
      if (payload?.status !== 'idle') return
      if (Date.now() - indicator.lastActivityAt < 1500) return
      void indicator.hide()
    })
  }

  log.info(
    `dsh-computer-use ready: ${definitions.length} tool${definitions.length === 1 ? '' : 's'} registered (mode=${config.tools})`,
  )

  // 技能自安装：装到用户技能根，watcher 会把它带进下一次会话目录，无需重启。
  if (config.installSkill === true) {
    const skill = await ensureSkillInstalled(log)
    log.info(`computer-use skill: ${skill.status} (${skill.path})`)
  }

  // 指示器预热：WPF 冷启动要 1-2 秒，不预热的话第一次动作亮得很迟（用户会以为没生效）。
  if (config.indicator === true) void indicator.warmUp()

  // 后端是懒启动的（首次调用才拉起），但启动失败要尽早在日志里说清楚，
  // 否则用户只会在第一次动作时看到一个泛泛的错误。
  if (config.warmup === true) void warmUp()
  async function warmUp() {
    const result = await bridge.probe(8000)
    if (result.ok === true) {
      log.info(
        `computer-use backend ready: ${result.info?.protocol ?? 'dsh-cua/1'} ps=${result.info?.psVersion ?? '?'} dpiAware=${result.info?.dpiAware === true}`,
      )
    } else {
      log.warn(`computer-use backend is not available yet: ${result.reason}`)
    }
  }
}

/** 取一个可用的日志器；取不到就退回 console。 */
function createLogger(ctx) {
  let base
  try {
    base = ctx?.logger
    if (typeof base === 'function') base = base('dsh-computer-use')
  } catch {
    base = undefined
  }
  if (base === null || base === undefined || typeof base.info !== 'function') base = console
  const emit = (level, message) => {
    try {
      base[level]?.(message)
    } catch {
      /* 日志失败不影响主流程 */
    }
  }
  return {
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    error: (message) => emit('error', message),
  }
}

/**
 * 注册 `/computer-use` 命令（GUI 菜单与手打共用同一条落盘路径）。
 *
 * 为什么要走命令而不是让客户端直接写文件：客户端插件跑在浏览器里，碰不到文件系统；
 * 而「设置必须真的落到宿主侧」是这次需求的核心——界面上禁用了、宿主却照旧执行，
 * 那是最糟的假装安全。所以客户端只提交一条命令，由宿主校验、写盘、并同步内存状态。
 *
 * 幂等且容错：拿不到 commands 服务时只记一条日志，插件其余功能照常。
 * @param options.ctx cordis 上下文
 * @param options.accessState 内存活状态（闸门读的就是它）
 * @param options.log 日志器
 * @returns 注销函数（拿不到命令服务时返回 undefined）
 */
function registerAccessCommand({ ctx, accessState, log }) {
  const commands = (() => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('commands') : ctx.commands
    } catch {
      return undefined
    }
  })()
  if (commands === undefined || typeof commands.register !== 'function') {
    log?.warn?.('commands service unavailable; /computer-use settings command not registered')
    return undefined
  }

  const handler = async ({ rawInput }) => {
    const parsed = parseCommandArguments(rawInput)
    if (parsed.ok !== true) {
      return { kind: 'error', text: `${parsed.message}\n用法：/computer-use [mode auto|ask|off] [subagents on|off]` }
    }
    try {
      if (parsed.patch !== undefined) {
        const next = { ...accessState, ...parsed.patch }
        // 落盘在前：写失败就什么都不改，避免「界面显示已禁用、重启后又变回来」。
        const fileConfig = await readConfig()
        await writeConfig({ ...fileConfig, accessMode: next.accessMode, allowSubagents: next.allowSubagents })
        accessState.accessMode = next.accessMode
        accessState.allowSubagents = next.allowSubagents
        log?.info?.(`computer-use access updated: ${describeSettings(next)}`)
      }
    } catch (error) {
      return { kind: 'error', text: `写入配置失败：${error instanceof Error ? error.message : String(error)}` }
    }
    if (parsed.json === true) return { kind: 'success', text: settingsPayload(accessState) }
    return { kind: 'success', text: describeSettings(accessState) }
  }

  try {
    const dispose = commands.register({
      name: 'computer-use',
      description: '电脑操控设置：全自动 / 需要询问 / 禁用，以及是否允许子代理调用',
      // 不把参数记进对话记录：设置点击属于配置操作，不该刷屏（`settingsPayload` 的
      // JSON 也只给客户端读，不给人看）。
      recordInput: false,
      handler,
    })
    return dispose
  } catch (error) {
    log?.warn?.(`could not register /computer-use command: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** 截图产物轮转：按修改时间保留最新 keep 个。失败只记日志。 */
async function pruneFrames(dir, keep, log) {
  if (!Number.isFinite(keep) || keep <= 0) return
  try {
    const names = await readdir(dir)
    if (names.length <= keep) return
    const entries = []
    for (const entry of names) {
      const full = join(dir, entry)
      try {
        const info = await stat(full)
        entries.push({ full, mtimeMs: info.mtimeMs })
      } catch {
        /* 并发删除 */
      }
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const stale of entries.slice(keep)) {
      await rm(stale.full, { force: true })
    }
  } catch (error) {
    log?.warn?.(`could not prune screenshot frames: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 供测试与排查使用：暴露默认配置。 */
export { DEFAULT_CONFIG }
