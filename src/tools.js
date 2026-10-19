/**
 * 工具表：与 ZCode Computer Use 一一对应的 25 个动作。
 *
 * 工具名取自上游 `packages/ui/src/ToolCallBlocks/renderers/cuaSummaryMessages.ts`
 * （即 `CUA_TOOL_SUMMARY_IDS` 的键集合）。参数命名尽量对齐上游能观察到的形态：
 *  - 目标应用用 `app` 选择器（上游 `cuaActionDetail.ts` 读 `input.app.url`；
 *    「Open {app}」/「Read {app} interface」/「List {app} windows」三条文案说明
 *    `list_windows`/`get_app_state` 也吃同一选择器）；
 *  - 元素目标用 `element_index` + `state_id`（上游 `tool-contract.ts` 要求
 *    `state.state_id` 配 `state.elements[*].index`，且明确禁止从 text 正则 state_id）；
 *  - 坐标是**栅格像素**（上游：`x/y must be integer pixels inside the width/height
 *    of the returned raster`），且「不得拿 `screenshot_display.bounds` 或窗口 bounds
 *    当栅格坐标」；
 *  - `key`/`hold_key` 接受 `key` 或 `text`（上游 `cuaActionDetail.ts` 的读法）。
 *
 * 与上游的差异（有意，见 docs/zcode-cua-contract.md 的「重建对照表」）：
 *  - 上游 `request_access` 返回的 `CuaRequestAccessStatus` 是 macOS 专用
 *    （`platform:"darwin"`、`grantOwner`、`accessibility`、`screenRecording`）；
 *    Windows 后端没有这套授权模型，我们返回同构但平台正确的环境自述。
 *  - 上游 `stop_computer_control` 还负责结束 PiP 会话；我们只做本实现里真实存在的三件事：
 *    释放按键、结束拖拽、丢弃坐标系。
 *  - 上游把 25 个动作作为 `node_repl` 的私有 capability 方法暴露给 SDK；
 *    这里**直接注册成 DSH 工具**（DSH 没有等价的 JS kernel 桥），配置 `tools:"single"`
 *    可退回「一个 tool + action 参数」的形态，更接近上游的调用姿势。
 */
import { bool, enumOf, int, objectSchema, str, textOutputSchema } from './schema.js'
import {
  actionErrorHint,
  appAssociations,
  formatAccess,
  formatAction,
  formatAppState,
  formatClipboardRead,
  formatListApps,
  formatListWindows,
  formatScreenshot,
  plainEnvelope,
} from './format.js'

/** `app` 选择器：字符串（appKey/显示名/进程名）、整数（pid）或结构化对象。 */
const APP_SELECTOR = {
  description:
    'Target application: an appKey/displayName/process name from list_apps, a pid, or an object {appKey|name|process|pid|hwnd}.',
  oneOf: [
    { type: 'string' },
    { type: 'integer' },
    {
      type: 'object',
      properties: {
        appKey: str('Application key from list_apps.'),
        name: str('Display or process name.'),
        process: str('Process name.'),
        pid: int('Process id.'),
        hwnd: str('Window handle, e.g. 0x00120abc.'),
      },
      additionalProperties: true,
    },
  ],
}

/** `window` 选择器：hwnd 字符串或结构化对象。 */
const WINDOW_SELECTOR = {
  description: 'Target window: an hwnd from list_windows, or an object {hwnd|title|index}.',
  oneOf: [
    { type: 'string' },
    {
      type: 'object',
      properties: {
        hwnd: str('Window handle.'),
        title: str('Window title substring.'),
        index: int('Zero-based index within the app windows from list_windows.'),
      },
      additionalProperties: true,
    },
  ],
}

/** 屏幕区域（物理像素）。 */
const REGION = {
  type: 'object',
  description: 'Region in physical screen pixels. width/height are required.',
  properties: {
    x: int('Left edge.'),
    y: int('Top edge.'),
    width: int('Width.'),
    height: int('Height.'),
  },
  required: ['width', 'height'],
  additionalProperties: false,
}

const ELEMENT_TARGET_PROPS = {
  element_index: int('Element index from get_app_state (elements[*].index).'),
  state_id: str('state_id returned by the get_app_state that produced element_index. Required with element_index.'),
}

const COORD_FRAME_PROPS = {
  x: int('X in raster pixels of the most recent screenshot.'),
  y: int('Y in raster pixels of the most recent screenshot.'),
  frame_id: str('Frame id from the screenshot the coordinates were measured on. Omit to use the latest frame.'),
  space: enumOf(
    ['raster', 'screen'],
    'raster (default) = pixels inside the returned screenshot; screen = absolute physical pixels.',
  ),
}

const CLICK_PROPS = {
  ...ELEMENT_TARGET_PROPS,
  ...COORD_FRAME_PROPS,
  button: enumOf(['left', 'right', 'middle'], 'Mouse button. Defaults to the tool default.'),
  clicks: int('Click count (1-3). Defaults to the tool default.'),
  interval_ms: int('Delay between clicks in ms (default 60).'),
}

/** 拖拽：两端都可以是元素目标或栅格坐标。 */
const DRAG_PROPS = {
  ...ELEMENT_TARGET_PROPS,
  ...COORD_FRAME_PROPS,
  from: {
    type: 'object',
    description: 'Start point in raster pixels, as {x, y}.',
    properties: { x: int('Start x.'), y: int('Start y.') },
    required: ['x', 'y'],
    additionalProperties: false,
  },
  to: {
    type: 'object',
    description: 'End point in raster pixels, as {x, y}.',
    properties: { x: int('End x.'), y: int('End y.') },
    required: ['x', 'y'],
    additionalProperties: false,
  },
  from_x: int('Start x (flat alternative to from).'),
  from_y: int('Start y (flat alternative to from).'),
  to_x: int('End x (flat alternative to to).'),
  to_y: int('End y (flat alternative to to).'),
  to_element_index: int('End element index from get_app_state (alternative to to_x/to_y).'),
  button: enumOf(['left', 'right', 'middle'], 'Mouse button (default left).'),
  duration_ms: int('Glide duration in ms (default 300).'),
}

const OUTPUT_ACTION = textOutputSchema({
  action_sent: bool('True when a real desktop input was injected.'),
  state_id: str('state_id this action was resolved against, when element-targeted.'),
})

/**
 * app 选择器 → 协议参数。
 * @returns `{appKey?, pid?, hwnd?}`；无法解析时抛参数错误
 */
export function appSelectorToArgs(selector) {
  if (selector === undefined || selector === null) return {}
  if (typeof selector === 'number') return Number.isFinite(selector) ? { pid: Math.round(selector) } : {}
  if (typeof selector === 'string') {
    const text = selector.trim()
    if (text === '') return {}
    if (/^0x[0-9a-f]+$/iu.test(text)) return { hwnd: text }
    if (/^\d+$/u.test(text)) return { pid: Number(text) }
    return { appKey: text }
  }
  if (typeof selector !== 'object' || Array.isArray(selector)) {
    throw new Error('invalid arguments: app must be a string, an integer pid, or an object')
  }
  const out = {}
  const key = selector.appKey ?? selector.name ?? selector.process ?? selector.displayName
  if (typeof key === 'string' && key.trim() !== '') out.appKey = key.trim()
  if (Number.isFinite(selector.pid)) out.pid = Math.round(selector.pid)
  if (typeof selector.hwnd === 'string' && selector.hwnd.trim() !== '') out.hwnd = selector.hwnd.trim()
  return out
}

function windowSelectorToArgs(selector) {
  if (selector === undefined || selector === null) return {}
  if (typeof selector === 'string') return { hwnd: selector.trim() }
  if (typeof selector === 'number') return { window_index: Math.round(selector) }
  if (typeof selector !== 'object' || Array.isArray(selector)) {
    throw new Error('invalid arguments: window must be a string hwnd or an object')
  }
  const out = {}
  if (typeof selector.hwnd === 'string' && selector.hwnd.trim() !== '') out.hwnd = selector.hwnd.trim()
  if (typeof selector.title === 'string' && selector.title.trim() !== '') out.title = selector.title.trim()
  if (Number.isFinite(selector.index)) out.window_index = Math.round(selector.index)
  return out
}

/** 把秒/毫秒两种写法统一成毫秒。 */
function durationToMs(args, { defaultMs, key = 'duration_ms', secondsKey = 'duration', maxMs = 30000 }) {
  const ms = Number(args[key])
  if (Number.isFinite(ms)) return Math.min(maxMs, Math.max(1, Math.round(ms)))
  const seconds = Number(args[secondsKey])
  if (Number.isFinite(seconds)) return Math.min(maxMs, Math.max(1, Math.round(seconds * 1000)))
  return defaultMs
}

/**
 * 取元素目标。
 * @param required 该工具是否必须走元素路径（set_value / select_text / perform_action）；
 *                 false 时缺 element_index 表示「调用方要走坐标路径」，交回 undefined。
 */
function requireElement(args, toolName, required = false) {
  const index = args.element_index
  if (!Number.isFinite(index)) {
    if (required) throw new Error(`invalid arguments: ${toolName} needs element_index from get_app_state`)
    return undefined
  }
  if (typeof args.state_id !== 'string' || args.state_id.trim() === '') {
    throw new Error(
      `invalid arguments: ${toolName} needs state_id together with element_index (call get_app_state first)`,
    )
  }
  return { element_index: Math.round(index), state_id: args.state_id.trim() }
}

/** 给后端错误补上「怎么修」的提示，避免把裸错误码丢给模型。 */
function withHint(error) {
  const code = error?.code
  const hint = typeof code === 'string' ? actionErrorHint(code) : undefined
  if (hint === undefined) return error
  const base = error instanceof Error ? error.message : String(error)
  const wrapped = new Error(`${base}\nHint: ${hint}`, { cause: error })
  wrapped.code = code
  return wrapped
}

/**
 * 构造全部工具定义。
 * @param runtime 宿主端运行时（bridge/config/附件/日志/截图落盘）
 * @returns `{ native, single, specs }`：native = 25 个独立工具，single = 一个 computer_use 分发工具
 */
export function createToolDefinitions(runtime) {
  const { call } = runtime

  const specs = []
  const define = (spec) => {
    specs.push(spec)
    return spec
  }

  /**
   * 界面状态签名，用于 `changes` 差分。
   * 上游 UI 把界面变化显示成「{added} added, {removed} removed」
   * （`chat.toolCall.cua.details.changeCounts`，字段名 `changes`）；producer 侧的完整结构
   * 不在开源仓库里，这里按同一语义自行计算：以「角色|名字|值|AutomationId」为元素身份，
   * 与同一窗口上一次观察做集合差。
   */
  const stateSignatures = new Map()
  function computeChanges(key, elements) {
    const current = new Set(
      elements.map(
        (element) =>
          `${element.role ?? ''}|${element.name ?? ''}|${element.value ?? ''}|${element.automationId ?? ''}`,
      ),
    )
    const previous = stateSignatures.get(key)
    stateSignatures.set(key, current)
    if (stateSignatures.size > 32) {
      const oldest = stateSignatures.keys().next().value
      if (oldest !== undefined) stateSignatures.delete(oldest)
    }
    if (previous === undefined) return undefined
    let added = 0
    for (const signature of current) if (!previous.has(signature)) added += 1
    let removed = 0
    for (const signature of previous) if (!current.has(signature)) removed += 1
    return { added_count: added, removed_count: removed }
  }

  /* ---------------------------------------------------------------- *
   * 只读观察
   * ---------------------------------------------------------------- */

  define({
    name: 'request_access',
    readOnly: true,
    description:
      'Check whether the desktop backend is ready and report the environment it sees (platform, screen size, DPI awareness, monitor count, screen-capture and input-control status). Read-only; safe to call first.',
    parameters: objectSchema({}),
    output: textOutputSchema({}),
    async handler() {
      const access = runtime.accessReport?.()
      const probe = await runtime.probe()
      if (probe.ok !== true) {
        return {
          ready: false,
          platform: process.platform,
          backend: 'powershell-native',
          ...(access === undefined ? {} : { access }),
          notes: [
            `Backend is not available: ${probe.reason}`,
            'Nothing can be observed or controlled until this is fixed.',
          ],
          text: formatAccess({
            platform: process.platform,
            backend: 'unavailable',
            ready: false,
            ...(access === undefined ? {} : { access }),
            notes: [`Backend is not available: ${probe.reason}`],
          }),
        }
      }
      const info = await call('screen_info', {}, {})
      const monitorCount = Array.isArray(info.monitors) ? info.monitors.length : 0
      let capture = 'granted'
      try {
        await call('screenshot', { max_width: 320, format: 'jpeg', quality: 40 }, {})
      } catch (error) {
        capture = error?.code === 'SCREENSHOT_FAILED' ? 'denied' : 'unknown'
      }
      const backend = `powershell-native/${probe.info?.protocol ?? 'dsh-cua/1'}`
      return {
        ready: true,
        platform: process.platform,
        backend,
        dpiAware: probe.info?.dpiAware === true,
        monitors: monitorCount,
        screen: info.virtual,
        screenCapture: capture,
        inputControl: 'granted',
        ...(access === undefined ? {} : { access }),
        text: formatAccess({
          platform: process.platform,
          backend,
          ready: true,
          dpiAware: probe.info?.dpiAware === true,
          monitors: monitorCount,
          screen: info.virtual,
          screenCapture: capture,
          inputControl: 'granted',
          ...(access === undefined ? {} : { access }),
          notes: [
            'Windows desktop backend (PowerShell + UI Automation). No macOS-style permission grant is required on Windows.',
            'Coordinates for input tools are raster pixels of the most recent screenshot, unless space="screen".',
          ],
        }),
      }
    },
  })

  define({
    name: 'list_apps',
    readOnly: true,
    description:
      'List running applications that have a visible top-level window. Returns appKey, displayName, pid and window count. Call this first to learn valid app targets.',
    parameters: objectSchema({
      include_minimized: bool('Include apps whose only windows are minimized (default false).'),
    }),
    output: textOutputSchema({}),
    async handler(_runtime, args) {
      const data = await call('list_apps', { include_minimized: args.include_minimized === true }, {})
      return {
        count: data.count ?? 0,
        apps: data.apps ?? [],
        text: formatListApps(data),
        meta: appAssociations(undefined, 'items', data.apps ?? []),
      }
    },
  })

  define({
    name: 'list_windows',
    readOnly: true,
    description:
      'List top-level windows, optionally narrowed to one application. Returns hwnd, title, class and bounds in physical screen pixels.',
    parameters: objectSchema({ app: APP_SELECTOR }),
    output: textOutputSchema({}),
    async handler(_runtime, args) {
      const data = await call('list_windows', appSelectorToArgs(args.app), {})
      return {
        count: data.count ?? 0,
        windows: data.windows ?? [],
        text: formatListWindows(data),
        meta: data.app === undefined ? {} : appAssociations(data.app),
      }
    },
  })

  define({
    name: 'get_app_state',
    readOnly: true,
    timeout: 'long',
    description:
      'Read the accessibility (UI Automation) tree of one application window: every element with index, role, name, value, bounds, enabled/focused flags and supported actions. This is the primary observation channel — read it before element-targeted actions, then pass element_index with the returned state_id.',
    parameters: objectSchema({
      app: APP_SELECTOR,
      window: WINDOW_SELECTOR,
      max_elements: int('Cap on returned elements (default 120, max 400).'),
      max_depth: int('Cap on tree depth (default 8, max 16).'),
    }),
    output: textOutputSchema({ state_id: str('Observation id that element_index values belong to.') }),
    async handler(_runtime, args) {
      const payload = {
        ...appSelectorToArgs(args.app),
        ...windowSelectorToArgs(args.window),
      }
      if (Number.isFinite(args.max_elements)) payload.max_elements = Math.round(args.max_elements)
      if (Number.isFinite(args.max_depth)) payload.max_depth = Math.round(args.max_depth)
      const data = await call('get_app_state', payload, {}, 'long')
      const changes = computeChanges(
        `${data.app?.appKey ?? '?'}:${data.window?.hwnd ?? '?'}`,
        Array.isArray(data.elements) ? data.elements : [],
      )
      return {
        state_id: data.state_id,
        app: data.app,
        window: data.window,
        elements: data.elements ?? [],
        elementCount: data.elementCount ?? 0,
        truncated: data.truncated === true,
        ...(changes === undefined ? {} : { changes }),
        text: formatAppState(data, changes),
        meta: appAssociations(data.app),
      }
    },
  })

  define({
    name: 'screenshot',
    readOnly: true,
    timeout: 'long',
    description:
      'Capture the screen (or one monitor, or one application window) as an image. Returns the image itself when the current model route accepts image input, plus a text envelope with the raster size. Coordinates you pass to click/mouse_move/drag are pixels inside this returned image.',
    parameters: objectSchema({
      app: APP_SELECTOR,
      window: WINDOW_SELECTOR,
      monitor: int('Monitor index from the environment report; omit for the whole virtual screen.'),
      max_width: int('Downscale so the long edge does not exceed this many pixels (0 = no downscale).'),
      format: enumOf(['png', 'jpeg'], 'Image encoding. Defaults to the plugin configuration (png).'),
    }),
    output: textOutputSchema({ frame_id: str('Frame id these raster coordinates belong to.') }),
    async handler(_runtime, args, exec) {
      const payload = { ...runtime.defaultScreenshotArgs() }
      if (Number.isFinite(args.monitor)) payload.monitor = Math.round(args.monitor)
      if (Number.isFinite(args.max_width)) payload.max_width = Math.round(args.max_width)
      if (typeof args.format === 'string') payload.format = args.format
      const region = await resolveWindowRegion(call, args)
      if (region !== undefined) Object.assign(payload, region)
      const data = await captureWithinBudget(call, 'screenshot', payload, runtime, runtime.screenshotBudget())
      return await finishImageResult(data, { zoomed: false }, runtime, exec)
    },
  })

  define({
    name: 'zoom',
    readOnly: true,
    timeout: 'long',
    description:
      'Capture a magnified region of the screen. Use it to read small text or aim precisely at a control: pass a region in physical screen pixels (as read from a previous screenshot envelope or element bounds) and a scale factor.',
    parameters: objectSchema({
      region: REGION,
      x: int('Region left edge (alternative to region).'),
      y: int('Region top edge (alternative to region).'),
      width: int('Region width (alternative to region).'),
      height: int('Region height (alternative to region).'),
      scale: int('Magnification factor 1-8 (default 2).'),
      format: enumOf(['png', 'jpeg'], 'Image encoding.'),
      app: APP_SELECTOR,
      window: WINDOW_SELECTOR,
    }),
    output: textOutputSchema({ frame_id: str('Frame id the zoomed raster belongs to.') }),
    async handler(_runtime, args, exec) {
      const region = args.region ?? {}
      const left = Number.isFinite(args.x) ? Math.round(args.x) : Math.round(region.x ?? 0)
      const top = Number.isFinite(args.y) ? Math.round(args.y) : Math.round(region.y ?? 0)
      const width = Number.isFinite(args.width) ? Math.round(args.width) : Math.round(region.width ?? 0)
      const height = Number.isFinite(args.height) ? Math.round(args.height) : Math.round(region.height ?? 0)
      if (width <= 0 || height <= 0) {
        throw new Error('invalid arguments: zoom needs a region with positive width and height')
      }
      const payload = { left, top, width, height, scale: Number.isFinite(args.scale) ? Math.round(args.scale) : 2 }
      if (typeof args.format === 'string') payload.format = args.format
      // 标记帧归属窗口，让原生侧能拦住跨窗口复用旧帧。
      const owner = await resolveWindowRegion(call, args)
      if (owner?.target_hwnd !== undefined) payload.target_hwnd = owner.target_hwnd
      const data = await captureWithinBudget(call, 'zoom', payload, runtime, runtime.screenshotBudget())
      return await finishImageResult(data, { zoomed: true }, runtime, exec)
    },
  })

  /* ---------------------------------------------------------------- *
   * 动作
   * ---------------------------------------------------------------- */

  define({
    name: 'open_application',
    description:
      'Launch an application or open a URL / file path via the shell. Accepts a string, or {url|path|name, args}. Prefer this over trying to click a launcher.',
    parameters: objectSchema(
      {
        app: {
          description: 'What to open: a string, or {url|path|name|args}.',
          oneOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                url: str('URL to open in the default handler.'),
                path: str('Executable or document path.'),
                name: str('Application name resolved through the shell (e.g. notepad).'),
                args: { type: 'array', items: { type: 'string' }, description: 'Command-line arguments.' },
              },
              additionalProperties: false,
            },
          ],
        },
        wait_ms: int('How long to wait for the new window (default 800).'),
      },
      ['app'],
    ),
    output: OUTPUT_ACTION,
    async handler(_runtime, args) {
      const payload = {}
      const selector = args.app
      if (typeof selector === 'string') {
        if (/^https?:|^file:|^mailto:/iu.test(selector)) payload.url = selector
        else payload.name = selector
      } else if (typeof selector === 'object' && selector !== null && !Array.isArray(selector)) {
        if (typeof selector.url === 'string') payload.url = selector.url
        if (typeof selector.path === 'string') payload.path = selector.path
        if (typeof selector.name === 'string') payload.name = selector.name
        if (Array.isArray(selector.args)) payload.args = selector.args.map(String)
      } else {
        throw new Error('invalid arguments: app must be a string or an object {url|path|name|args}')
      }
      if (payload.url === undefined && payload.path === undefined && payload.name === undefined) {
        throw new Error('invalid arguments: app must carry url, path, or name')
      }
      if (Number.isFinite(args.wait_ms)) payload.wait_ms = Math.round(args.wait_ms)
      const data = await call('open_application', payload, {})
      return {
        action_sent: data.action_sent === true,
        app: data.launched,
        text: formatAction(data, 'Application launch requested.'),
        meta: appAssociations(undefined),
      }
    },
  })

  const clickTools = [
    { name: 'left_click', button: 'left', clicks: 1, describe: 'Click with the left mouse button.' },
    { name: 'double_click', button: 'left', clicks: 2, describe: 'Double-click.' },
    {
      name: 'triple_click',
      button: 'left',
      clicks: 3,
      describe: 'Triple-click (usually selects a line or paragraph).',
    },
    {
      name: 'right_click',
      button: 'right',
      clicks: 1,
      describe: 'Click with the right mouse button (opens a context menu).',
    },
    { name: 'middle_click', button: 'middle', clicks: 1, describe: 'Click with the middle mouse button.' },
  ]
  for (const tool of clickTools) {
    define({
      name: tool.name,
      description:
        `${tool.describe} Target either an element (element_index + state_id from get_app_state — preferred, it survives layout shifts) ` +
        'or raster coordinates x/y from the most recent screenshot. Coordinates are pixels inside that screenshot image, not physical screen pixels.',
      parameters: objectSchema(CLICK_PROPS),
      output: OUTPUT_ACTION,
      async handler(_runtime, args) {
        const payload = { button: args.button ?? tool.button, clicks: args.clicks ?? tool.clicks }
        const element = requireElement(args, tool.name)
        if (element !== undefined) {
          Object.assign(payload, element)
        } else {
          if (!Number.isFinite(args.x) || !Number.isFinite(args.y)) {
            throw new Error(`invalid arguments: ${tool.name} needs either element_index+state_id or both x and y`)
          }
          Object.assign(payload, { x: Math.round(args.x), y: Math.round(args.y) })
          if (typeof args.frame_id === 'string') payload.frame_id = args.frame_id
          if (typeof args.space === 'string') payload.space = args.space
        }
        if (Number.isFinite(args.interval_ms)) payload.interval_ms = Math.round(args.interval_ms)
        const data = await call('click', payload, {})
        return {
          action_sent: data.action_sent === true,
          state_id: data.state_id,
          app: data.app,
          text: formatAction(data, `${tool.name} dispatched.`),
          meta: appAssociations(data.app ?? undefined),
        }
      },
    })
  }

  define({
    name: 'mouse_move',
    description:
      'Move the pointer without clicking. Useful before drag or to trigger hover states. Coordinates are raster pixels of the most recent screenshot.',
    parameters: objectSchema(
      {
        ...COORD_FRAME_PROPS,
        duration_ms: int('Glide duration in ms (0 = instant).'),
      },
      ['x', 'y'],
    ),
    output: OUTPUT_ACTION,
    async handler(_runtime, args) {
      const payload = { x: Math.round(args.x), y: Math.round(args.y) }
      if (typeof args.frame_id === 'string') payload.frame_id = args.frame_id
      if (typeof args.space === 'string') payload.space = args.space
      if (Number.isFinite(args.duration_ms)) payload.duration_ms = Math.round(args.duration_ms)
      const data = await call('mouse_move', payload, {})
      return { action_sent: data.action_sent === true, text: formatAction(data, 'Pointer moved.') }
    },
  })

  define({
    name: 'left_click_drag',
    description:
      'Press the left button at one point, move, and release at another (drag and drop, sliders, text selection). Prefer element targets when both ends are elements; otherwise use raster coordinates from the most recent screenshot.',
    parameters: objectSchema(DRAG_PROPS),
    output: OUTPUT_ACTION,
    async handler(_runtime, args) {
      const payload = {}
      const fromElement = Number.isFinite(args.element_index) ? requireElement(args, 'left_click_drag') : undefined
      let toElement
      if (Number.isFinite(args.to_element_index)) {
        const stateId = typeof args.state_id === 'string' ? args.state_id.trim() : ''
        if (stateId === '') {
          throw new Error('invalid arguments: left_click_drag needs state_id together with to_element_index')
        }
        toElement = { element_index: Math.round(args.to_element_index), state_id: stateId }
      }
      if (fromElement !== undefined) {
        payload.from_element_index = fromElement.element_index
        payload.state_id = fromElement.state_id
      } else {
        const fromX = Number.isFinite(args.from_x) ? args.from_x : args.from?.x
        const fromY = Number.isFinite(args.from_y) ? args.from_y : args.from?.y
        const toX = Number.isFinite(args.to_x) ? args.to_x : args.to?.x
        const toY = Number.isFinite(args.to_y) ? args.to_y : args.to?.y
        if (![fromX, fromY, toX, toY].every((value) => Number.isFinite(value))) {
          throw new Error(
            'invalid arguments: left_click_drag needs from/to coordinates (from_x, from_y, to_x, to_y) or element targets',
          )
        }
        // 协议 §4.10 只认 from/to 对象（不接受扁平键）：模型侧的扁平写法在这里翻译。
        payload.from = { x: Math.round(fromX), y: Math.round(fromY) }
        payload.to = { x: Math.round(toX), y: Math.round(toY) }
      }
      if (toElement !== undefined) payload.to_element_index = toElement.element_index
      if (typeof args.frame_id === 'string') payload.frame_id = args.frame_id
      if (typeof args.space === 'string') payload.space = args.space
      if (Number.isFinite(args.duration_ms)) payload.duration_ms = Math.round(args.duration_ms)
      const data = await call('drag', payload, {})
      return { action_sent: data.action_sent === true, text: formatAction(data, 'Drag completed.') }
    },
  })

  define({
    name: 'scroll',
    description:
      'Scroll the wheel. Give a direction and optionally a point (raster coordinates or element target) to scroll over; without a point the wheel goes to the current pointer position.',
    parameters: objectSchema({
      direction: enumOf(['up', 'down', 'left', 'right'], 'Wheel direction (default down).'),
      amount: int('Wheel notches 1-20 (default 3).'),
      ...ELEMENT_TARGET_PROPS,
      ...COORD_FRAME_PROPS,
    }),
    output: OUTPUT_ACTION,
    async handler(_runtime, args) {
      const payload = {
        direction: args.direction ?? 'down',
        amount: Number.isFinite(args.amount) ? Math.round(args.amount) : 3,
      }
      const element = requireElement(args, 'scroll')
      if (element !== undefined) {
        Object.assign(payload, element)
      } else if (Number.isFinite(args.x) && Number.isFinite(args.y)) {
        payload.x = Math.round(args.x)
        payload.y = Math.round(args.y)
        if (typeof args.frame_id === 'string') payload.frame_id = args.frame_id
        if (typeof args.space === 'string') payload.space = args.space
      }
      const data = await call('scroll', payload, {})
      return { action_sent: data.action_sent === true, text: formatAction(data, 'Scroll dispatched.') }
    },
  })

  define({
    name: 'type',
    description:
      'Type text into whatever has keyboard focus, Unicode included. Pass an element target to click it first. Prefer this over per-character key presses.',
    parameters: objectSchema(
      {
        text: str('Text to type.'),
        ...ELEMENT_TARGET_PROPS,
        interval_ms: int('Delay between characters in ms (default 0).'),
      },
      ['text'],
    ),
    output: textOutputSchema({
      action_sent: bool('True when keystrokes were injected.'),
      characters: int('Number of characters typed.'),
    }),
    async handler(_runtime, args) {
      const payload = { text: args.text }
      const element = requireElement(args, 'type')
      if (element !== undefined) Object.assign(payload, element)
      if (Number.isFinite(args.interval_ms)) payload.interval_ms = Math.round(args.interval_ms)
      const data = await call('type', payload, {})
      return {
        action_sent: data.action_sent === true,
        characters: data.characters ?? String(args.text).length,
        text: formatAction(data, `Typed ${String(args.text).length} characters.`),
      }
    },
  })

  define({
    name: 'key',
    description:
      'Press a key or a modifier chord, e.g. "ctrl+s", "alt+tab", "enter", "f5", "ctrl+shift+left". Modifiers accepted: ctrl, alt, shift, win (aliases: control, meta, cmd, command).',
    parameters: objectSchema({
      key: str('Chord like "ctrl+s".'),
      text: str('Single character alternative to key.'),
      ...ELEMENT_TARGET_PROPS,
    }),
    output: OUTPUT_ACTION,
    async handler(_runtime, args) {
      const key = typeof args.key === 'string' && args.key.trim() !== '' ? args.key.trim() : undefined
      const text = typeof args.text === 'string' && args.text !== '' ? args.text : undefined
      if (key === undefined && text === undefined) {
        throw new Error('invalid arguments: key needs either key ("ctrl+s") or text (a single character)')
      }
      const payload = key === undefined ? { text } : { key }
      const element = requireElement(args, 'key')
      if (element !== undefined) Object.assign(payload, element)
      const data = await call('key', payload, {})
      return { action_sent: data.action_sent === true, text: formatAction(data, 'Key pressed.') }
    },
  })

  define({
    name: 'hold_key',
    description:
      'Hold a key (or chord) down for a duration, then release. Use for held modifiers around other actions or for key-repeat navigation.',
    parameters: objectSchema({
      key: str('Key or chord to hold.'),
      text: str('Single character alternative to key.'),
      duration: { type: 'number', description: 'Hold duration in seconds (default 0.5).' },
      duration_ms: int('Hold duration in ms (overrides duration).'),
    }),
    output: textOutputSchema({
      action_sent: bool('True when the key was pressed.'),
      durationMs: int('Hold duration in ms.'),
    }),
    async handler(_runtime, args) {
      const key = typeof args.key === 'string' && args.key.trim() !== '' ? args.key.trim() : undefined
      const text = typeof args.text === 'string' && args.text !== '' ? args.text : undefined
      if (key === undefined && text === undefined) {
        throw new Error('invalid arguments: hold_key needs either key or text')
      }
      const payload = key === undefined ? { text } : { key }
      payload.duration_ms = durationToMs(args, { defaultMs: 500, maxMs: 10000 })
      const data = await call('hold_key', payload, {})
      return {
        action_sent: data.action_sent === true,
        durationMs: data.durationMs ?? payload.duration_ms,
        text: formatAction(data, `Held key for ${payload.duration_ms} ms.`),
      }
    },
  })

  define({
    name: 'set_value',
    description:
      'Set the text of an editable element through UI Automation (fills the field without simulating keystrokes). If the element does not support it, fall back to click + type.',
    parameters: objectSchema(
      {
        value: str('Value to set.'),
        submit: bool('Press Enter after setting (default false).'),
        ...ELEMENT_TARGET_PROPS,
      },
      ['value', 'element_index', 'state_id'],
    ),
    output: textOutputSchema({
      action_sent: bool('True when the value was set.'),
      state_id: str('State the element came from.'),
    }),
    async handler(_runtime, args) {
      const element = requireElement(args, 'set_value', true)
      const data = await call('set_value', { ...element, value: args.value, submit: args.submit === true }, {})
      return {
        action_sent: data.action_sent === true,
        state_id: data.state_id,
        text: formatAction(data, 'Value set.'),
      }
    },
  })

  define({
    name: 'select_text',
    description:
      'Select text inside a text element through UI Automation. Omit start/length (or set all) to select everything.',
    parameters: objectSchema(
      {
        start: int('Start offset (default 0).'),
        length: int('Length to select; omit for the whole text.'),
        all: bool('Select the entire text (default true when start/length are omitted).'),
        ...ELEMENT_TARGET_PROPS,
      },
      ['element_index', 'state_id'],
    ),
    output: textOutputSchema({
      action_sent: bool('True when a selection was made.'),
      state_id: str('State the element came from.'),
    }),
    async handler(_runtime, args) {
      const element = requireElement(args, 'select_text', true)
      const payload = { ...element }
      if (Number.isFinite(args.start)) payload.start = Math.round(args.start)
      if (Number.isFinite(args.length)) payload.length = Math.round(args.length)
      if (args.all === true) payload.all = true
      const data = await call('select_text', payload, {})
      return {
        action_sent: data.action_sent === true,
        state_id: data.state_id,
        text: formatAction(data, 'Text selected.'),
      }
    },
  })

  define({
    name: 'perform_action',
    description:
      'Invoke a UI Automation action on an element (invoke, expand, collapse, toggle, select, focus, scroll_into_view). Use it when a control exposes an action but has no reliable geometry to click.',
    parameters: objectSchema(
      {
        action: enumOf(
          ['invoke', 'expand', 'collapse', 'toggle', 'select', 'focus', 'scroll_into_view'],
          'Action to perform.',
        ),
        ...ELEMENT_TARGET_PROPS,
      },
      ['action', 'element_index', 'state_id'],
    ),
    output: textOutputSchema({
      action_sent: bool('True when the action was performed.'),
      state_id: str('State the element came from.'),
    }),
    async handler(_runtime, args) {
      const element = requireElement(args, 'perform_action', true)
      const data = await call('perform_action', { ...element, action: args.action }, {})
      return {
        action_sent: data.action_sent === true,
        state_id: data.state_id,
        text: formatAction(data, `Performed ${args.action}.`),
      }
    },
  })

  define({
    name: 'wait',
    description:
      'Wait, then optionally re-read one application state. Use after an action that needs time (launching, loading, animations) instead of screenshotting in a tight loop.',
    parameters: objectSchema({
      duration: { type: 'number', description: 'Wait duration in seconds (default 1).' },
      duration_ms: int('Wait duration in ms (overrides duration).'),
      app: APP_SELECTOR,
      window: WINDOW_SELECTOR,
    }),
    output: textOutputSchema({ state_id: str('State of the re-read app, when an app was given.') }),
    async handler(_runtime, args) {
      const payload = { duration_ms: durationToMs(args, { defaultMs: 1000 }) }
      Object.assign(payload, appSelectorToArgs(args.app), windowSelectorToArgs(args.window))
      const data = await call('wait', payload, {}, 'long')
      const waitedText = `Waited ${(payload.duration_ms / 1000).toFixed(2)}s.`
      if (data.state_id !== undefined) {
        return {
          state_id: data.state_id,
          elements: data.elements ?? [],
          text: `${formatAction(data, waitedText)}\n\n${formatAppState(data)}`,
          meta: appAssociations(data.app),
        }
      }
      return { text: formatAction(data, waitedText) }
    },
  })

  define({
    name: 'read_clipboard',
    readOnly: true,
    description: 'Read the clipboard as text. Returns hasText=false when the clipboard holds no text.',
    parameters: objectSchema({}),
    output: textOutputSchema({
      text_value: str('Clipboard text.'),
      hasText: bool('False when the clipboard holds no text.'),
    }),
    async handler() {
      const data = await call('clipboard_read', {}, {})
      return { text_value: data.text, hasText: data.hasText === true, text: formatClipboardRead(data) }
    },
  })

  define({
    name: 'write_clipboard',
    description:
      'Write text to the clipboard. A good way to move text between applications, or to paste a large blob with key "ctrl+v" instead of typing it.',
    parameters: objectSchema({ text: str('Text to place on the clipboard.') }, ['text']),
    output: textOutputSchema({ action_sent: bool('True when the clipboard was written.') }),
    async handler(_runtime, args) {
      const data = await call('clipboard_write', { text: args.text }, {})
      return {
        action_sent: data.action_sent === true,
        text: formatAction(
          data,
          `Wrote ${data.characters ?? String(args.text).length} characters to the clipboard.`,
        ),
      }
    },
  })

  define({
    name: 'stop_computer_control',
    description:
      'Stop desktop control: release any keys still held by hold_key and finish any in-flight drag. Call it when the task is done or before handing control back to the user. Idempotent.',
    parameters: objectSchema({}),
    output: textOutputSchema({ stopped: bool('Always true.') }),
    async handler() {
      const data = await call('stop', { release_keys: true }, {})
      return {
        stopped: true,
        text: plainEnvelope('stop', data.text ?? 'Released held keys and finished any pending drag.', {
          released:
            Array.isArray(data.releasedKeys) && data.releasedKeys.length > 0
              ? data.releasedKeys.join(',')
              : undefined,
        }),
      }
    },
  })

  const native = specs.map((spec) => toDefinition(spec, runtime))

  const single = {
    definition: {
      name: 'computer_use',
      description:
        'Computer Use: observe and control desktop applications on this machine. Pick an `action`, then pass that action\'s parameters at the top level (see the computer-use skill for the full parameter list).',
      parameters: {
        type: 'object',
        properties: {
          action: enumOf(
            specs.map((spec) => spec.name),
            'Which Computer Use action to run.',
          ),
        },
        required: ['action'],
        additionalProperties: true,
      },
      output: {
        schema: textOutputSchema({ action: str('Action that ran.') }),
        render: renderValue,
        presentationMeta: (_args, value) => value?.meta ?? {},
      },
      async execute(args, exec) {
        const spec = specs.find((candidate) => candidate.name === args.action)
        if (spec === undefined) {
          throw new Error(
            `invalid arguments: unknown action "${String(args.action)}"; available: ${specs
              .map((entry) => entry.name)
              .join(', ')}`,
          )
        }
        const { action, ...rest } = args
        const value = await runHandler(spec, runtime, rest, exec)
        return { ...value, action }
      },
    },
  }

  return { native, single, specs }

  function toDefinition(spec, runtime_) {
    return {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: {
        schema: spec.output,
        render: renderValue,
        presentationMeta: (_args, value) => value?.meta ?? {},
      },
      ...(spec.timeout === 'long' ? { timeoutMs: runtime_.longTimeoutMs } : {}),
      isConcurrencySafe: () => spec.readOnly === true,
      async execute(args, exec) {
        return await runHandler(spec, runtime_, args, exec)
      },
    }
  }
}

/** 统一的 handler 包装：套上错误提示语。 */
async function runHandler(spec, runtime, args, exec) {
  try {
    return await spec.handler(runtime, args, exec)
  } catch (error) {
    throw withHint(error)
  }
}

/** 渲染：文本信封 +（可选）原生图像块。 */
function renderValue(_args, value) {
  const text = typeof value?.text === 'string' ? value.text : JSON.stringify(value ?? null)
  const blocks = [{ type: 'text', text }]
  if (value?.image !== undefined && value.image !== null) {
    blocks.push({ type: 'image', attachment: value.image })
  }
  return blocks
}

/**
 * 解析 app/window 选择器到一个屏幕区域（用于「截某个应用/窗口」）。
 * 拿不到窗口就返回 undefined，让后端退回整屏——比直接失败更有用。
 */
async function resolveWindowRegion(call, args) {
  if (args.app === undefined && args.window === undefined) return undefined
  let payload
  try {
    payload = { ...appSelectorToArgs(args.app) }
    if (typeof args.window === 'string') payload.hwnd = args.window.trim()
    else if (typeof args.window === 'number') payload.window_index = Math.round(args.window)
    else if (args.window !== undefined && args.window !== null && typeof args.window === 'object') {
      if (typeof args.window.hwnd === 'string') payload.hwnd = args.window.hwnd.trim()
      if (Number.isFinite(args.window.index)) payload.window_index = Math.round(args.window.index)
      if (typeof args.window.title === 'string') payload.title = args.window.title.trim()
    }
  } catch {
    return undefined
  }
  if (Object.keys(payload).length === 0) return undefined
  try {
    const listed = await call('list_windows', payload, {})
    const first = Array.isArray(listed.windows) ? listed.windows[0] : undefined
    if (first?.bounds === undefined) return undefined
    const { x, y, width, height } = first.bounds
    if (![x, y, width, height].every((value) => Number.isFinite(value)) || width <= 0 || height <= 0) {
      return undefined
    }
    return {
      left: Math.round(x),
      top: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
      clamp: true,
      // 帧归属：原生用它做跨窗口保护，防止把上次给别的窗口拍的 frame 几何套到这里。
      ...(typeof first.hwnd === 'string' ? { target_hwnd: first.hwnd } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * 截图类结果的收尾：落盘 + 附加图像块 + 组织信封。
 * 图像块只在「附件存储已挂载且当前路由声明图像输入」时附加（与 DSH 内置
 * `read_image` 的门禁同源）；否则退回纯文本信封 + saved_to 路径。
 */
async function finishImageResult(data, { zoomed }, runtime, exec) {
  const image = data.image ?? {}
  let savedPath
  if (typeof image.base64 === 'string' && image.base64 !== '') {
    savedPath = await runtime.saveFrame(image.base64, {
      mediaType: image.mediaType ?? 'image/png',
      frameId: data.frame_id,
      zoomed,
    })
  }
  const imageRef = await runtime.attachImage(image.base64, image.mediaType ?? 'image/png', savedPath, exec)
  return {
    frame_id: data.frame_id,
    image: imageRef,
    savedPath,
    text: formatScreenshot(data, { zoomed, savedPath }),
    meta: {},
  }
}

/**
 * 按字节预算拍图：png → jpeg →（必要时）更小栅格。
 *
 * 上游对模型可见的图片有硬预算（单张内联 256 KiB、合计 512 KiB、最多 4 张，
 * `result-display.ts:233-235`）。我们不在这里截断，而是**降级重拍**：
 * 让模型始终拿到一张完整但更省的图。坐标语义不受影响——降级会更新后端的 frame
 * 几何，`scale` 一并回报。
 */
async function captureWithinBudget(call, cmd, payload, runtime, budgetBytes) {
  let attempt = { ...payload }
  const data = await call(cmd, attempt, {}, 'long')
  const bytes = Number(data.image?.bytes) || 0
  if (bytes <= budgetBytes) return data

  let best = data
  let bestBytes = bytes

  // 阶梯一：换 JPEG 重拍（同样取景与栅格）。
  if ((attempt.format ?? 'png') !== 'jpeg') {
    attempt = { ...attempt, format: 'jpeg', quality: runtime.jpegQuality() }
    try {
      const next = await call(cmd, attempt, {}, 'long')
      if ((Number(next.image?.bytes) || Infinity) < bestBytes) {
        best = next
        bestBytes = Number(next.image?.bytes) || Number.POSITIVE_INFINITY
      }
      if (bestBytes <= budgetBytes) return best
    } catch {
      /* 换编码失败就保留原图，继续下一步 */
    }
  }

  // 阶梯二：把长边压到 60% 再拍一次（只做一次，避免在慢后端上无限重试）。
  const longEdge = Math.max(Number(best.image?.width) || 0, Number(best.image?.height) || 0)
  if (longEdge > 640) {
    const target = Math.max(480, Math.round(longEdge * 0.6))
    const smaller = { ...attempt, format: 'jpeg', quality: runtime.jpegQuality(), max_width: target }
    try {
      const next = await call(cmd, smaller, {}, 'long')
      if ((Number(next.image?.bytes) || Infinity) < bestBytes) {
        best = next
        bestBytes = Number(next.image?.bytes) || Number.POSITIVE_INFINITY
      }
    } catch {
      /* 保留上一步的结果 */
    }
  }
  best.budget_fallback = true
  return best
}
