/**
 * 操作指示器控制器：Computer Use 一动，屏幕最前端就出现「DSH 正在操作电脑」。
 *
 * 行为对齐上游 ZCode 的 `windowsCuaOperationIndicator`（Electron 版）：
 *  - 有活跃操作时置顶显示，全部结束后离场；
 *  - **30s 兜底自动隐藏**（上游常量 `AUTO_HIDE_MS`）——显式隐藏路径失约时也不能让浮层
 *    无限期停在屏幕上，因为它声称的是「正在操作电脑」，留着就等于对用户撒谎；
 *  - 隐藏失败要抛给上层处理（上游会销毁窗口重建），绝不假装隐藏成功；
 *  - 每次活动都刷新计时器，所以长任务中途不会熄灭。
 *
 * 与上游的差异：上游由 Electron 主进程直接开 BrowserWindow；DSH 插件拿不到宿主窗口，
 * 所以由 `src/native/indicator.ps1` 这个长驻 WPF 进程持有浮窗，Node 侧只发 show/update/hide。
 * 为了让第一次 `show` 不卡在冷启动（PowerShell + WPF 起进程约 1-2 秒），插件加载时会预热。
 *
 * 关键性质（由 `tools/indicator-smoke.mjs` 在真机上核验，不是靠信任）：
 * 点击穿透、不抢焦点、不出现在截图里。抢焦点会让键盘注入打进浮层，Computer Use 直接失效；
 * 出现在截图里会让模型每张截图都被自己的浮层污染。
 */
import { NativeBridge } from './bridge.js'

/** 中文动作词：`showAction` 打开时拼在文案后面，让用户知道正在做什么。 */
const ZH_ACTIONS = {
  request_access: '检查环境',
  list_apps: '查看应用',
  list_windows: '查看窗口',
  get_app_state: '读取界面',
  screenshot: '截屏',
  zoom: '放大屏幕',
  open_application: '启动应用',
  left_click: '点击',
  double_click: '双击',
  triple_click: '三击',
  right_click: '右键',
  middle_click: '中键点击',
  mouse_move: '移动指针',
  left_click_drag: '拖拽',
  scroll: '滚动',
  type: '输入文字',
  key: '按键',
  hold_key: '按住按键',
  set_value: '填写内容',
  select_text: '选择文本',
  perform_action: '执行控件动作',
  wait: '等待界面',
  read_clipboard: '读取剪贴板',
  write_clipboard: '写入剪贴板',
  stop_computer_control: '交还控制权',
}

/** 英文动作词。 */
const EN_ACTIONS = {
  request_access: 'checking environment',
  list_apps: 'listing apps',
  list_windows: 'listing windows',
  get_app_state: 'reading the interface',
  screenshot: 'capturing the screen',
  zoom: 'zooming',
  open_application: 'opening an app',
  left_click: 'clicking',
  double_click: 'double-clicking',
  triple_click: 'triple-clicking',
  right_click: 'right-clicking',
  middle_click: 'middle-clicking',
  mouse_move: 'moving the pointer',
  left_click_drag: 'dragging',
  scroll: 'scrolling',
  type: 'typing',
  key: 'pressing a key',
  hold_key: 'holding a key',
  set_value: 'filling a field',
  select_text: 'selecting text',
  perform_action: 'activating a control',
  wait: 'waiting',
  read_clipboard: 'reading the clipboard',
  write_clipboard: 'writing the clipboard',
  stop_computer_control: 'releasing control',
}

const COPY = {
  'zh-CN': { base: 'DSH 正在操作电脑', actions: ZH_ACTIONS },
  'en-US': { base: 'DSH is controlling your computer', actions: EN_ACTIONS },
}

/**
 * 按运行环境猜语言；配置可覆盖。
 *
 * 语义刻意分成两档：`DSH_LOCALE` / `LC_ALL` / `LANG` 一旦设了就**权威**
 * （`LANG=en_US.UTF-8` 就是英文，不该被系统区域改回去）；
 * 三者都没设时才去问 `Intl` 的系统区域。
 */
export function detectLocale() {
  const explicit = process.env.DSH_LOCALE ?? process.env.LC_ALL ?? process.env.LANG
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return /zh/iu.test(explicit) ? 'zh-CN' : 'en-US'
  }
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().locale ?? ''
    if (/^zh/iu.test(resolved)) return 'zh-CN'
  } catch {
    /* 取不到就用英文 */
  }
  return 'en-US'
}

/** 拼出要显示的文案。 */
export function indicatorText(toolName, { locale = 'zh-CN', showAction = true } = {}) {
  const copy = COPY[locale] ?? COPY['zh-CN']
  if (showAction !== true || toolName === undefined) return copy.base
  const action = copy.actions[toolName]
  return action === undefined ? copy.base : `${copy.base} · ${action}`
}

/**
 * @typedef {object} IndicatorOptions
 * @property {string|URL} scriptPath 指示器脚本路径
 * @property {boolean} [enabled] 总开关
 * @property {string} [locale] `zh-CN` | `en-US`
 * @property {boolean} [showAction] 是否在文案里带上当前动作
 * @property {number} [autoHideMs] 无活动多久后自动隐藏
 * @property {number} [startupTimeoutMs] 预热时等待 ready 的上限
 * @property {{info: Function, warn: Function}} [log]
 * @property {Function} [createBridge] 测试注入：返回一个 NativeBridge 兼容对象
 */

export class OperationIndicator {
  #bridge
  #enabled
  #locale
  #showAction
  #autoHideMs
  #log
  #hideTimer
  #visible = false
  #lastTool
  #lastActivityAt = 0
  #failed = false
  #disposed = false
  #warm = null

  constructor(options = {}) {
    this.#enabled = options.enabled !== false
    this.#locale = options.locale ?? 'zh-CN'
    this.#showAction = options.showAction !== false
    // 下限只在这里做「别是 0/负数」的防御；真正的取值范围由 config 归一化负责
    // （否则这一层会悄悄吃掉测试注入的短值，让计时相关的回归测试失去意义）。
    this.#autoHideMs = Number.isFinite(options.autoHideMs) ? Math.max(1, options.autoHideMs) : 30000
    this.#log =
      options.log ?? {
        info: () => {},
        warn: () => {},
      }
    const createBridge =
      options.createBridge ??
      ((bridgeOptions) => new NativeBridge(bridgeOptions))
    this.#bridge = createBridge({
      scriptPath: options.scriptPath,
      defaultTimeoutMs: 8000,
      startupTimeoutMs: options.startupTimeoutMs ?? 15000,
      maxRestarts: 2,
      onDiagnostic: (line) => this.#log.warn?.(`[indicator] ${line}`),
    })
  }

  /** 当前是否可见（本地视图，不代表原生窗口状态）。 */
  get visible() {
    return this.#visible
  }

  /**
   * 最近一次操作活动的时间戳（毫秒）。
   * 给「回合结束即收起」用：收到 idle 时要判断它是不是紧跟在动作之后的抖动
   * （另一个 agent 的 idle 不该把正在进行的浮层收掉）。
   */
  get lastActivityAt() {
    return this.#lastActivityAt
  }

  /** 预热：把进程拉起来，让第一次 show 不必等冷启动。失败只记日志。 */
  async warmUp() {
    if (this.#enabled !== true || this.#disposed === true) return
    if (this.#warm !== null) return await this.#warm
    this.#warm = (async () => {
      try {
        const info = await this.#bridge.ensureStarted()
        this.#log.info?.(
          `computer-use indicator ready: ${info?.protocol ?? 'dsh-cua-indicator/1'} ps=${info?.psVersion ?? '?'}`,
        )
      } catch (error) {
        this.#failed = true
        this.#log.warn?.(
          `computer-use indicator unavailable (desktop control still works): ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    })()
    await this.#warm
  }

  /**
   * 记一次操作活动。**刻意不返回 promise**：指示器是装饰性的，
   * 它的任何失败都不允许影响工具执行或让调用方多等一次往返。
   */
  note(toolName, options = {}) {
    if (this.#enabled !== true || this.#disposed === true) return
    this.#lastTool = toolName
    this.#lastActivityAt = Date.now()
    if (options.terminal === true) {
      // `stop_computer_control` 的语义是「控制权已交还」，浮层必须立刻走。
      void this.hide()
      return
    }
    void this.#refresh()
  }

  /**
   * 用指定文案显示浮层（文档预览/排查用；正常路径是 `note()` 按动作生成文案）。
   * @param text 要显示的完整文案
   */
  async showText(text) {
    if (this.#enabled !== true || this.#disposed === true) return
    this.#lastActivityAt = Date.now()
    try {
      await this.#bridge.call('show', { text }, { timeoutMs: 8000 })
      this.#visible = true
      this.#scheduleHide()
    } catch (error) {
      this.#noteFailure(error)
    }
  }

  /** 立即隐藏（幂等）。 */
  async hide() {
    this.#cancelHide()
    this.#visible = false
    if (this.#enabled !== true || this.#disposed === true) return
    try {
      await this.#bridge.call('hide', {}, { timeoutMs: 5000 })
    } catch (error) {
      this.#noteFailure(error)
    }
  }

  /** 状态查询：给 request_access 之类的诊断用（失败不影响主流程）。 */
  async status() {
    if (this.#enabled !== true) return { enabled: false }
    try {
      const data = await this.#bridge.call('ping', {}, { timeoutMs: 5000 })
      return { enabled: true, ...data }
    } catch (error) {
      return { enabled: true, available: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 关闭指示器进程（幂等）。 */
  async dispose() {
    if (this.#disposed === true) return
    this.#disposed = true
    this.#cancelHide()
    this.#visible = false
    try {
      await this.#bridge.dispose()
    } catch {
      /* 关不掉就算了，进程会随宿主退出 */
    }
  }

  async #refresh() {
    try {
      if (this.#visible !== true) {
        await this.#bridge.call('show', { text: this.#text() }, { timeoutMs: 8000 })
        this.#visible = true
      } else {
        await this.#bridge.call('update', { text: this.#text() }, { timeoutMs: 5000 })
      }
      this.#scheduleHide()
    } catch (error) {
      this.#noteFailure(error)
    }
  }

  #text() {
    return indicatorText(this.#lastTool, { locale: this.#locale, showAction: this.#showAction })
  }

  #scheduleHide() {
    this.#cancelHide()
    const timer = setTimeout(() => {
      this.#hideTimer = undefined
      // 兜底边界：即使没有任何终态信号，也不能让浮层无限期停留。
      void this.hide()
    }, this.#autoHideMs)
    if (typeof timer.unref === 'function') timer.unref()
    this.#hideTimer = timer
  }

  #cancelHide() {
    if (this.#hideTimer === undefined) return
    clearTimeout(this.#hideTimer)
    this.#hideTimer = undefined
  }

  #noteFailure(error) {
    if (this.#failed === true) return
    this.#failed = true
    this.#log.warn?.(
      `computer-use indicator failed (desktop control is unaffected): ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}
