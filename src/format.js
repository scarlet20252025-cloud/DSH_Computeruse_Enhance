/**
 * 模型面信封（model-facing envelope）。
 *
 * 形态对齐 ZCode：Computer Use 的每个工具结果都是一段**结构化 XML 风格文本**
 * （`<app>…</app>`、`[index] Role "Name" @(x,y,w,h)`），而机器可解析字段
 * （`state_id`、`elements[*].index`、`screenshot_display.*`）只走结构化输出。
 * 上游在 `node-repl-host/src/tool-contract.ts` 里反复强调「不要把 text 正则出 state_id」，
 * 因此这里的 text 只承载**给模型读**的内容，且刻意把交互坐标规则写在信封里：
 * 模型看不到 JS 文档，信封就是它唯一的规则来源。
 *
 * 另有一个上游契约的对应物：`zcode.cua/app-associations-v1`
 * （ZCode `packages/zcode-cua/host-display-contract.js`）。ZCode 把它放在 MCP 结果的
 * `_meta` 上，由宿主读出来渲染工具卡片的「目标应用」；DSH 的等价通道是
 * `presentationMeta`。键名沿用上游，便于对照。
 */

/** ZCode 的目标应用关联元数据键（上游原样字符串）。 */
export const CUA_APP_ASSOCIATIONS_META_KEY = 'zcode.cua/app-associations-v1'

/** 上游对这份元数据的字节上限（`CUA_APP_ASSOCIATIONS_MAX_META_BYTES`）。 */
export const CUA_APP_ASSOCIATIONS_MAX_META_BYTES = 16 * 1024

/**
 * 构造目标应用关联元数据（`presentationMeta` 的返回值）。
 * @param app 后端返回的 app 对象（`{appKey, displayName}`）
 * @param mode `primary` = 这一跳确定了唯一目标应用；`items` = 列表结果，按结果下标关联；
 *             `none` = 未确立身份（请求授权、停止控制等）。
 */
export function appAssociations(app, mode = 'primary', items) {
  if (mode === 'none') return { [CUA_APP_ASSOCIATIONS_META_KEY]: { mode: 'none' } }
  if (mode === 'items' && Array.isArray(items)) {
    return {
      [CUA_APP_ASSOCIATIONS_META_KEY]: {
        mode: 'items',
        items: items.slice(0, 64).map((entry) => ({
          ...(entry?.appKey === undefined ? {} : { appKey: entry.appKey }),
          ...(entry?.displayName === undefined ? {} : { displayName: entry.displayName }),
        })),
      },
    }
  }
  if (app === undefined || app === null || typeof app.appKey !== 'string') {
    return { [CUA_APP_ASSOCIATIONS_META_KEY]: { mode: 'none' } }
  }
  return {
    [CUA_APP_ASSOCIATIONS_META_KEY]: {
      mode: 'primary',
      primary: {
        appKey: app.appKey,
        ...(typeof app.displayName === 'string' && app.displayName !== ''
          ? { displayName: app.displayName }
          : {}),
      },
    },
  }
}

function quote(value) {
  return String(value ?? '').replace(/"/gu, '&quot;').replace(/[\r\n]+/gu, ' ')
}

function attr(name, value) {
  if (value === undefined || value === null || value === '') return ''
  return ` ${name}="${quote(value)}"`
}

function boundsText(bounds) {
  if (bounds === undefined || bounds === null) return ''
  return ` @(${bounds.x},${bounds.y},${bounds.width},${bounds.height})`
}

/** 应用/窗口选择失败时的统一说明（模型据此换目标，而不是重试同一个名字）。 */
export function targetHint() {
  return 'Use list_apps / list_windows to get a valid app target (app accepts appKey, displayName, process name, pid, or hwnd).'
}

/** `request_access` 的结果信封。 */
export function formatAccess(data) {
  const lines = [`<computer-use environment="${quote(data.platform ?? 'unknown')}">`]
  lines.push(`backend="${quote(data.backend ?? 'unknown')}"${attr('ready', data.ready === true ? 'true' : 'false')}`)
  if (data.dpiAware === true) lines.push(`dpi_aware="true"`)
  if (Number.isFinite(data.monitors)) lines.push(`monitors="${data.monitors}"`)
  if (data.screen !== undefined) {
    lines.push(`virtual_screen="${data.screen.width}x${data.screen.height}"`)
  }
  lines.push(`screen_capture="${quote(data.screenCapture ?? 'unknown')}"`)
  lines.push(`input_control="${quote(data.inputControl ?? 'unknown')}"`)
  // 访问设置也报出来：模型据此知道「用户此刻允不允许」，同时它也是**运行时可自查**的凭据——
  // 用户在菜单里改了设置，这里立刻能看出来（诊断「界面改了但没生效」时省一大圈）。
  if (data.access !== undefined) {
    lines.push(
      `access_mode="${quote(data.access.mode)}"${attr(
        'subagents',
        data.access.allowSubagents === true ? 'allowed' : 'blocked',
      )}`,
    )
  }
  lines.push(`</computer-use>`)
  if (Array.isArray(data.notes) && data.notes.length > 0) {
    for (const note of data.notes) lines.push(`- ${note}`)
  }
  if (data.access !== undefined) {
    lines.push(`- 电脑操控访问设置：${data.access.label}`)
  }
  return lines.join('\n')
}

/** `list_apps` 的结果信封。 */
export function formatListApps(data) {
  const apps = Array.isArray(data.apps) ? data.apps : []
  if (apps.length === 0) {
    return '<apps count="0">\nNo applications with visible windows were found.\n</apps>'
  }
  const lines = [`<apps count="${apps.length}">`]
  apps.forEach((app, index) => {
    const title = app.windows?.[0]?.title
    lines.push(
      `[${index}] app="${quote(app.displayName ?? app.appKey)}" key="${quote(app.appKey)}" pid="${app.pid}"` +
        attr('foreground', app.foreground === true ? 'true' : undefined) +
        ` windows="${app.windowCount ?? app.windows?.length ?? 0}"` +
        attr('title', title),
    )
  })
  lines.push('</apps>')
  lines.push('Pass `app` as the key or the display name to target one; then use get_app_state for its interface elements.')
  return lines.join('\n')
}

/** `list_windows` 的结果信封。 */
export function formatListWindows(data) {
  const windows = Array.isArray(data.windows) ? data.windows : []
  if (windows.length === 0) return '<windows count="0">\nNo matching windows.\n</windows>'
  const lines = [`<windows count="${windows.length}">`]
  windows.forEach((win, index) => {
    lines.push(
      `[${index}] hwnd="${quote(win.hwnd)}" title="${quote(win.title)}" app="${quote(win.displayName ?? win.appKey)}"` +
        ` pid="${win.pid}"${attr('class', win.className)}` +
        attr('foreground', win.foreground === true ? 'true' : undefined) +
        attr('minimized', win.minimized === true ? 'true' : undefined) +
        boundsText(win.bounds),
    )
  })
  lines.push('</windows>')
  return lines.join('\n')
}

/** `get_app_state` 的结果信封：这是 Computer Use 的主要观察通道。 */
export function formatAppState(data, changes) {
  const elements = Array.isArray(data.elements) ? data.elements : []
  const lines = [
    `<app name="${quote(data.app?.displayName ?? data.app?.appKey)}" key="${quote(data.app?.appKey)}"` +
      ` pid="${data.app?.pid ?? ''}"${attr('window', data.window?.title)}` +
      ` state_id="${quote(data.state_id)}" elements="${elements.length}"` +
      attr('truncated', data.truncated === true ? 'true' : undefined) +
      attr('minimized', data.window?.minimized === true ? 'true' : undefined) +
      '>',
  ]
  if (changes !== undefined) {
    lines.push(`changes: ${changes.added_count} added, ${changes.removed_count} removed since the previous read`)
  }
  if (data.focused !== undefined && data.focused !== null && data.focused.elementIndex !== undefined) {
    lines.push(`focused: [${data.focused.elementIndex}] ${quote(data.focused.role)} "${quote(data.focused.name)}"`)
  }
  for (const element of elements) {
    const parts = [`[${element.index}] ${quote(element.role)} "${quote(element.name)}"`]
    if (element.value !== undefined && element.value !== null && String(element.value) !== '') {
      parts.push(`value="${quote(String(element.value).slice(0, 120))}"`)
    }
    parts.push(boundsText(element.bounds).trim())
    const flags = []
    if (element.focused === true) flags.push('focused')
    if (element.enabled === false) flags.push('disabled')
    if (element.offscreen === true) flags.push('offscreen')
    if (Array.isArray(element.actions) && element.actions.length > 0) flags.push(`actions=${element.actions.join('|')}`)
    if (flags.length > 0) parts.push(flags.join(' '))
    lines.push(parts.filter(Boolean).join(' '))
  }
  if (elements.length === 0) {
    lines.push('(no interface elements were exposed for this window)')
  }
  lines.push('</app>')
  lines.push(
    `Element targets: pass element_index with state_id="${quote(data.state_id)}". ` +
      'A different state_id is stale — call get_app_state again before targeting elements.',
  )
  return lines.join('\n')
}

/** 截图结果信封：坐标规则写在这里，模型只有这一个来源。 */
export function formatScreenshot(data, { zoomed = false, savedPath } = {}) {
  const image = data.image ?? {}
  const display = data.screenshot_display ?? {}
  const lines = [
    `<screenshot kind="${zoomed ? 'zoom' : 'full-screen'}" frame_id="${quote(data.frame_id)}"` +
      ` width="${image.width}" height="${image.height}"${attr('format', image.mediaType)}>`,
    `source_region="${data.source?.x},${data.source?.y},${data.source?.width},${data.source?.height}" (physical pixels)`,
    `raster="${image.width}x${image.height}"  scale="${Number(data.scale?.x ?? 1).toFixed(3)}"` +
      (data.clamped === true ? '  clamped="true"' : ''),
  ]
  if (savedPath !== undefined) lines.push(`saved_to="${quote(savedPath)}"`)
  if (data.budget_fallback === true) {
    lines.push('note: re-encoded at a lower cost because the first attempt exceeded the byte budget (coordinates still refer to this image)')
  }
  lines.push('</screenshot>')
  lines.push(
    'Coordinate rule: x/y in click/mouse_move/drag/scroll/zoom are **raster pixels inside this image** ' +
      `(0..${Math.max(0, (image.width ?? 1) - 1)} by 0..${Math.max(0, (image.height ?? 1) - 1)}). ` +
      'Do not use window or element bounds as raster coordinates. ' +
      'Element bounds are physical screen pixels and only meaningful with element_index/state_id.',
  )
  if (display.mode === undefined) lines.push('Call get_app_state before element-targeted actions.')
  return lines.join('\n')
}

/** 一般动作（点击/输入/按键/滚动/拖拽/设值/选择/执行动作/剪贴板写/开应用/聚焦窗口）的结果信封。 */
export function formatAction(data, fallbackText) {
  const lines = [`<action status="${data.action_sent === true ? 'sent' : 'unknown'}">`]
  lines.push(data.text ?? fallbackText ?? 'Action completed.')
  if (data.target !== undefined && data.target !== null) {
    if (Number.isFinite(data.target.x) && Number.isFinite(data.target.y)) {
      lines.push(`target_raster=(${data.target.x},${data.target.y})${attr('screen', data.target.screenX !== undefined ? `${data.target.screenX},${data.target.screenY}` : undefined)}`)
    }
    if (data.target.elementIndex !== undefined) lines.push(`target_element=[${data.target.elementIndex}]${attr('role', data.target.role)}${attr('name', data.target.name)}`)
  }
  if (data.state_id !== undefined) lines.push(`state_id="${quote(data.state_id)}"`)
  if (data.characters !== undefined) lines.push(`characters=${data.characters}`)
  if (data.waitedMs !== undefined) lines.push(`waited_ms=${data.waitedMs}`)
  lines.push('</action>')
  return lines.join('\n')
}

/** 剪贴板读结果信封。 */
export function formatClipboardRead(data) {
  if (data.hasText !== true) {
    return `<clipboard empty="${data.empty === true ? 'true' : 'false'}">\nNo text on the clipboard.\n</clipboard>`
  }
  return `<clipboard characters="${String(data.text ?? '').length}">\n${data.text ?? ''}\n</clipboard>`
}

/** 纯文本信封（出错提示、等待、停止控制等）。 */
export function plainEnvelope(kind, text, attributes = {}) {
  const attrs = Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => ` ${key}="${quote(value)}"`)
    .join('')
  return `<${kind}${attrs}>\n${text}\n</${kind}>`
}

/**
 * 把上游的错误语义翻成模型能照着修的说明。
 * 上游 broker 的稳定错误码（`packages/zcode-cua/broker.js`）：
 * not_authorized / not_selectable / not_settable / element_unavailable /
 * action_unavailable / foreground_required；本地后端另加 ELEMENT_STALE 一族。
 */
export function actionErrorHint(code) {
  switch (code) {
    case 'ELEMENT_STALE':
      return 'The interface changed, or the frame/state you measured on is no longer the latest. Call get_app_state again (element targets) or screenshot again (raster coordinates) and use the new state_id/frame_id.'
    case 'ELEMENT_NOT_FOUND':
      return 'That element index is not in the current state. Call get_app_state again.'
    case 'ELEMENT_UNAVAILABLE':
      return 'The element is gone, hidden, or has no usable geometry. Call get_app_state again, or fall back to screenshot + x/y raster coordinates.'
    case 'ACTION_UNAVAILABLE':
      return 'That UI Automation action is not supported by this element. Try click with the element center, or use keyboard navigation.'
    case 'NOT_SELECTABLE':
      return 'This element does not support text selection. Click it, then use key with ctrl+a instead.'
    case 'NOT_SETTABLE':
      return 'This element cannot be filled programmatically. Click it, then use type.'
    case 'FOREGROUND_REQUIRED':
      return 'Windows refused to bring the target window to the foreground. Call open_application to raise it, click one of its elements (element_index + state_id), or ask the user to focus it.'
    case 'APP_NOT_FOUND':
      return `No such application. ${targetHint()}`
    case 'WINDOW_NOT_FOUND':
      return `No such window. ${targetHint()}`
    case 'NO_FRAME':
      return 'No screenshot has been taken yet, so raster coordinates have no origin. Call screenshot first, or pass space="screen" with physical screen coordinates.'
    case 'TIMEOUT':
      return 'The desktop backend did not answer in time and was restarted. Retry the call; if it repeats, the target app may be hung.'
    default:
      return 'Fix the arguments and retry, or take a screenshot to re-observe the screen.'
  }
}
