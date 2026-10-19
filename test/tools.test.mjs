/**
 * 工具面测试：25 个 ZCode 同名动作 → 原生协议方法的参数映射、错误提示、
 * 图片预算降级、state 差分、单工具分发模式。
 *
 * 关键：所有调用都过 `createGuardedExecute`（生产注册路径），并对每个返回值做
 * **无损 JSON 断言**。真机验证抓到的 `value is not lossless JSON` 就是绕过这一层
 * 才漏掉的——当时的测试直接调 handler。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BridgeError } from '../src/bridge.js'
import { createToolDefinitions, appSelectorToArgs } from '../src/tools.js'
import { CUA_APP_ASSOCIATIONS_META_KEY } from '../src/format.js'
import { createGuardedExecute } from '../src/index.js'
import { createFakeRuntime, loadDshPackage, refAvailable, UPSTREAM_TOOL_NAMES, READ_ONLY_TOOL_NAMES } from './helpers.mjs'

/** 造工具表 + 记录调用的运行时；定义走生产同款守卫，返回值逐次校验无损 JSON。 */
function setup(responder, options = {}) {
  const calls = []
  const runtime = createFakeRuntime({ responder, calls, ...options })
  const { native, single, specs } = createToolDefinitions(runtime)
  const byName = new Map(native.map((definition) => [definition.name, definition]))
  const run = async (name, args = {}, exec = {}) => {
    const definition = byName.get(name)
    if (definition === undefined) throw new Error(`no such tool: ${name}`)
    const guarded = { ...definition, execute: createGuardedExecute(definition) }
    const before = calls.length
    const value = await guarded.execute(args, exec)
    assertLossless(name, value)
    return { value, calls: calls.slice(before), definition }
  }
  return { runtime, native, single, specs, byName, run, calls }
}

/** 本地无损 JSON 判定：undefined / 非有限数 / 函数 / symbol 都不是无损 JSON。 */
function assertLossless(name, value, path = '') {
  const label = `${name}${path === '' ? '' : `.${path}`}`
  if (value === null) return
  const type = typeof value
  if (type === 'string' || type === 'boolean') return
  if (type === 'number') {
    assert.ok(Number.isFinite(value), `${label} 不是有限数：${String(value)}`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertLossless(name, entry, `${path}[${index}]`))
    return
  }
  assert.equal(type, 'object', `${label} 不是 JSON 值（${type}）`)
  for (const [key, entry] of Object.entries(value)) {
    assert.notEqual(entry, undefined, `${label}.${key} 是 undefined —— DSH 会拒绝整次调用`)
    assertLossless(name, entry, path === '' ? key : `${path}.${key}`)
  }
}

const SCREENSHOT_STUB = {
  frame_id: 'f1',
  image: { base64: 'AAAA', mediaType: 'image/png', width: 1280, height: 800, bytes: 12 },
  source: { x: 0, y: 0, width: 2560, height: 1600 },
  scale: { x: 0.5, y: 0.5 },
  screenshot_display: { mode: 'full-screen' },
}

test('工具面与上游 ZCode 完全同名同数（25 个）', () => {
  const { native } = setup()
  assert.equal(UPSTREAM_TOOL_NAMES.length, 25, '上游 cuaSummaryMessages.ts 的键数')
  assert.equal(native.length, 25)
  // 只比较集合：声明顺序是我们自己的（上游那 25 个名字在 UI 里是字典序常量表，
  // 不是调用顺序契约），注册表投影给模型的顺序由 DSH 决定。
  assert.deepEqual(
    [...native.map((definition) => definition.name)].sort(),
    [...UPSTREAM_TOOL_NAMES].sort(),
  )
  for (const definition of native) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 40, `${definition.name} 的描述太短`)
    assert.equal(typeof definition.output.render, 'function')
  }
})

test('只读工具标记为并发安全，写工具不是', () => {
  const { native } = setup()
  for (const definition of native) {
    const expected = READ_ONLY_TOOL_NAMES.has(definition.name)
    assert.equal(definition.isConcurrencySafe({}), expected, definition.name)
  }
})

test('click 族：元素目标优先，5 个工具名映射到 click 的 button/clicks', async () => {
  const { run } = setup(() => ({ action_sent: true, state_id: 's1', text: 'ok' }))
  for (const [name, button, clicks] of [
    ['left_click', 'left', 1],
    ['double_click', 'left', 2],
    ['triple_click', 'left', 3],
    ['right_click', 'right', 1],
    ['middle_click', 'middle', 1],
  ]) {
    const { calls } = await run(name, { element_index: 4, state_id: 's1' }, {})
    assert.equal(calls.length, 1)
    assert.equal(calls[0].cmd, 'click')
    assert.deepEqual(calls[0].args, { button, clicks, element_index: 4, state_id: 's1' }, name)
  }
})

test('click 族：栅格坐标路径透传 frame_id / space', async () => {
  const { run } = setup(() => ({ action_sent: true }))
  const { calls } = await run('left_click', { x: 10, y: 20, frame_id: 'f1', space: 'raster' }, {})
  assert.deepEqual(calls[0].args, { button: 'left', clicks: 1, x: 10, y: 20, frame_id: 'f1', space: 'raster' })
})

test('click 族：既无元素目标也无坐标 → 参数错误；有 index 无 state_id → 参数错误', async () => {
  const { run } = setup(() => ({}))
  await assert.rejects(run('left_click', {}), /needs either element_index\+state_id or both x and y/u)
  await assert.rejects(
    run('left_click', { element_index: 1 }),
    /needs state_id together with element_index/u,
  )
})

test('screenshot：默认参数 + 应用选择器解析成窗口区域', async () => {
  const { run } = setup((cmd) => {
    if (cmd === 'list_windows') {
      return { count: 1, windows: [{ hwnd: '0x1', title: 'Untitled - Notepad', bounds: { x: 100, y: 50, width: 800, height: 600 } }] }
    }
    return SCREENSHOT_STUB
  })
  const { value, calls } = await run('screenshot', { app: 'notepad' })
  assert.deepEqual(calls.map((entry) => entry.cmd), ['list_windows', 'screenshot'])
  assert.deepEqual(calls[1].args, {
    max_width: 1600,
    format: 'png',
    left: 100,
    top: 50,
    width: 800,
    height: 600,
    clamp: true,
    // 帧归属：原生靠它拦跨窗口复用旧帧（实测过的真实事故）
    target_hwnd: '0x1',
  })
  assert.equal(value.frame_id, 'f1')
  assert.match(value.text, /Coordinate rule/u)
  assert.match(value.text, /raster pixels/u)
})

test('zoom：区域必填且为正，scale 透传，越界信息保留', async () => {
  const { run } = setup(() => ({ ...SCREENSHOT_STUB, zoomed: true, clamped: true }))
  const { value, calls } = await run('zoom', { region: { x: 10, y: 20, width: 300, height: 200 }, scale: 3 })
  assert.equal(calls[0].cmd, 'zoom')
  assert.deepEqual(calls[0].args, { left: 10, top: 20, width: 300, height: 200, scale: 3 })
  assert.match(value.text, /clamped="true"/u)
  await assert.rejects(run('zoom', {}), /positive width and height/u)
})

test('type / key / hold_key：参数与单位换算', async () => {
  const { run } = setup(() => ({ action_sent: true, characters: 3, durationMs: 500 }))
  const typed = await run('type', { text: '你好', element_index: 2, state_id: 's9' })
  assert.deepEqual(typed.calls[0].args, { text: '你好', element_index: 2, state_id: 's9' })

  const chord = await run('key', { key: 'ctrl+s' })
  assert.deepEqual(chord.calls[0].args, { key: 'ctrl+s' })
  const char = await run('key', { text: 'a' })
  assert.deepEqual(char.calls[0].args, { text: 'a' })
  await assert.rejects(run('key', {}), /needs either key/u)

  const held = await run('hold_key', { key: 'shift', duration: 1.5 })
  assert.deepEqual(held.calls[0].args, { key: 'shift', duration_ms: 1500 })
  assert.equal(held.value.durationMs, 500, '后端回报优先')
})

test('scroll / mouse_move / drag：默认值与两种目标写法', async () => {
  const { run } = setup(() => ({ action_sent: true, text: 'ok' }))
  const scroll = await run('scroll', { element_index: 3, state_id: 's1' })
  assert.deepEqual(scroll.calls[0].args, { direction: 'down', amount: 3, element_index: 3, state_id: 's1' })

  const move = await run('mouse_move', { x: 5, y: 6 })
  assert.deepEqual(move.calls[0].args, { x: 5, y: 6 })

  const flatDrag = await run('left_click_drag', { from_x: 1, from_y: 2, to_x: 3, to_y: 4 })
  assert.deepEqual(flatDrag.calls[0].args, { from: { x: 1, y: 2 }, to: { x: 3, y: 4 } })

  const objectDrag = await run('left_click_drag', { from: { x: 7, y: 8 }, to: { x: 9, y: 10 } })
  assert.deepEqual(objectDrag.calls[0].args, { from: { x: 7, y: 8 }, to: { x: 9, y: 10 } })

  const elementDrag = await run('left_click_drag', { element_index: 2, to_element_index: 5, state_id: 's1' })
  assert.deepEqual(elementDrag.calls[0].args, {
    from_element_index: 2,
    to_element_index: 5,
    state_id: 's1',
  })
  await assert.rejects(run('left_click_drag', {}), /needs from\/to coordinates/u)
})

test('zoom：支持 app/window 选择器，并回传帧归属窗口（防跨窗口静默复用）', async () => {
  const { run } = setup((cmd) => {
    if (cmd === 'list_windows') {
      return { count: 1, windows: [{ hwnd: '0x2', title: 'A - Notepad', bounds: { x: 10, y: 20, width: 300, height: 200 } }] }
    }
    return { frame_id: 'f9', image: { base64: 'AA==', mediaType: 'image/png', width: 100, height: 80, bytes: 1 }, source: { x: 0, y: 0, width: 100, height: 80 }, scale: { x: 1, y: 1 } }
  })
  const { calls } = await run('zoom', { x: 10, y: 20, width: 100, height: 50, scale: 2, app: 'notepad' })
  assert.equal(calls[0].cmd, 'list_windows')
  assert.equal(calls[1].cmd, 'zoom')
  assert.equal(calls[1].args.left, 10)
  assert.equal(calls[1].args.scale, 2)
  assert.equal(calls[1].args.target_hwnd, '0x2')
})

test('set_value / select_text / perform_action 透传到对应协议方法', async () => {
  const { run } = setup(() => ({ action_sent: true, state_id: 's1', text: 'ok' }))
  const setValue = await run('set_value', { element_index: 1, state_id: 's1', value: 'hi', submit: true })
  assert.equal(setValue.calls[0].cmd, 'set_value')
  assert.deepEqual(setValue.calls[0].args, { element_index: 1, state_id: 's1', value: 'hi', submit: true })

  const select = await run('select_text', { element_index: 1, state_id: 's1', all: true })
  assert.equal(select.calls[0].cmd, 'select_text')
  assert.deepEqual(select.calls[0].args, { element_index: 1, state_id: 's1', all: true })

  const perform = await run('perform_action', { element_index: 1, state_id: 's1', action: 'invoke' })
  assert.equal(perform.calls[0].cmd, 'perform_action')
  assert.deepEqual(perform.calls[0].args, { element_index: 1, state_id: 's1', action: 'invoke' })

  // 守卫（schema 层）比 handler 更早拦：必填项缺失在参数校验阶段就报错。
  await assert.rejects(run('set_value', { value: 'x' }), /missing required property "element_index"/u)
  await assert.rejects(
    run('set_value', { value: 'x', element_index: 1 }),
    /missing required property "state_id"/u,
  )
})

test('open_application：字符串/对象两种选择器，缺目标即报错', async () => {
  const { run } = setup(() => ({ action_sent: true, launched: { kind: 'name', target: 'notepad' }, text: 'Opened' }))
  const byName = await run('open_application', { app: 'notepad' })
  assert.deepEqual(byName.calls[0].args, { name: 'notepad' })

  const byUrl = await run('open_application', { app: 'https://example.com' })
  assert.deepEqual(byUrl.calls[0].args, { url: 'https://example.com' })

  const byObject = await run('open_application', { app: { path: 'C:\\Windows\\notepad.exe', args: ['/x'] }, wait_ms: 20 })
  assert.deepEqual(byObject.calls[0].args, { path: 'C:\\Windows\\notepad.exe', args: ['/x'], wait_ms: 20 })

  await assert.rejects(run('open_application', { app: { args: ['x'] } }), /must carry url, path, or name/u)
  // 同上：`app` 是 oneOf，非法类型在 schema 层就被拒，而不是留给 handler 兜底。
  await assert.rejects(run('open_application', { app: 42 }), /must match exactly one oneOf branch/u)
})

test('剪贴板与停止控制', async () => {
  const { run } = setup((cmd) => {
    if (cmd === 'clipboard_read') return { text: 'hello', hasText: true, empty: false }
    if (cmd === 'clipboard_write') return { action_sent: true, characters: 5 }
    if (cmd === 'stop') return { action_sent: true, stopped: true, releasedKeys: ['shift'], text: 'Released held keys' }
    return {}
  })
  const read = await run('read_clipboard', {})
  assert.equal(read.calls[0].cmd, 'clipboard_read')
  assert.equal(read.value.text_value, 'hello')
  assert.match(read.value.text, /hello/u)

  const write = await run('write_clipboard', { text: 'hello' })
  assert.equal(write.calls[0].cmd, 'clipboard_write')
  assert.equal(write.value.action_sent, true)

  const stop = await run('stop_computer_control', {})
  assert.equal(stop.calls[0].cmd, 'stop')
  assert.deepEqual(stop.calls[0].args, { release_keys: true })
  assert.equal(stop.value.stopped, true)
  assert.match(stop.value.text, /shift/u)
})

test('request_access：后端可用时给出环境自述，不可用时明确说明原因', async () => {
  const okSetup = setup((cmd) => {
    if (cmd === 'screen_info') {
      return { dpiAware: true, virtual: { x: 0, y: 0, width: 2560, height: 1600 }, monitors: [{ index: 0, primary: true }] }
    }
    if (cmd === 'screenshot') return { ...SCREENSHOT_STUB, image: { ...SCREENSHOT_STUB.image, bytes: 4 } }
    return {}
  })
  const ok = await okSetup.run('request_access', {})
  assert.equal(ok.value.ready, true)
  assert.equal(ok.value.monitors, 1)
  assert.match(ok.value.text, /2560x1600/u)
  assert.match(ok.value.text, /Windows desktop backend/u)

  const badSetup = setup(() => ({}), {})
  badSetup.runtime.probe = async () => ({ ok: false, reason: 'powershell.exe is blocked by policy' })
  const bad = await badSetup.run('request_access', {})
  assert.equal(bad.value.ready, false)
  assert.match(bad.value.text, /blocked by policy/u)
})

test('get_app_state：state_id/元素树进信封，并计算 changes 差分', async () => {
  let round = 0
  const { run } = setup(() => {
    round += 1
    const base = [
      { index: 0, role: 'MenuBar', name: 'Application', bounds: { x: 0, y: 0, width: 800, height: 24 } },
      { index: 1, role: 'Document', name: 'Text editor', value: round === 1 ? '' : 'hello', bounds: { x: 8, y: 60, width: 780, height: 500 }, focused: true },
    ]
    return {
      state_id: `s${round}`,
      app: { appKey: 'notepad', displayName: 'Notepad', pid: 1234 },
      window: { hwnd: '0x1', title: 'Untitled - Notepad', minimized: false },
      elements: base,
      elementCount: base.length,
      truncated: false,
    }
  })
  const first = await run('get_app_state', { app: 'notepad' })
  assert.equal(first.value.state_id, 's1')
  assert.equal(first.value.changes, undefined, '首次观察没有前一次可比')
  assert.match(first.value.text, /state_id="s1"/u)
  assert.match(first.value.text, /\[1\] Document "Text editor"/u)
  assert.match(first.value.text, /Element targets: pass element_index with state_id="s1"/u)
  assert.equal(
    first.value.meta[CUA_APP_ASSOCIATIONS_META_KEY].primary.appKey,
    'notepad',
    'presentationMeta 必须带上游同名 targets 关联键',
  )

  const second = await run('get_app_state', { app: 'notepad' })
  assert.deepEqual(second.value.changes, { added_count: 1, removed_count: 1 })
  assert.match(second.value.text, /changes: 1 added, 1 removed/u)
})

test('后端错误码带上可修提示（element_stale / foreground_required …）', async () => {
  const { run } = setup(() => {
    throw new BridgeError('ELEMENT_STALE', 'state s1 is stale')
  })
  await assert.rejects(run('left_click', { element_index: 1, state_id: 's1' }), (error) => {
    assert.equal(error.code, 'ELEMENT_STALE')
    assert.match(error.message, /Hint: .*get_app_state again/u)
    return true
  })

  const { run: run2 } = setup(() => {
    throw new BridgeError('FOREGROUND_REQUIRED', 'cannot raise hwnd 0x1')
  })
  await assert.rejects(run2('left_click', { element_index: 1, state_id: 's1' }), /Hint: .*foreground/u)
})

test('截图字节超预算时阶梯降级，并在信封里说明', async () => {
  const attempts = []
  const { run } = setup((cmd, args) => {
    attempts.push({ cmd, format: args.format, max_width: args.max_width, quality: args.quality })
    // 现状：png 1.8 MB；同栅格 jpeg 仍有 900 KB；压到 960 以内才降到 200 KB。
    const bytes = args.format === 'jpeg' ? (args.max_width <= 960 ? 200000 : 900000) : 1800000
    return {
      ...SCREENSHOT_STUB,
      image: {
        ...SCREENSHOT_STUB.image,
        bytes,
        mediaType: args.format === 'jpeg' ? 'image/jpeg' : 'image/png',
      },
    }
  })
  const { value } = await run('screenshot', {})
  assert.deepEqual(attempts.map((entry) => entry.format), ['png', 'jpeg', 'jpeg'])
  assert.deepEqual(attempts.map((entry) => entry.max_width), [1600, 1600, 768], '第二次降级压长边到 60%')
  assert.match(value.text, /lower cost because the first attempt exceeded the byte budget/u)
})

test('截图在预算内时不做任何降级重拍', async () => {
  const attempts = []
  const { run } = setup((cmd, args) => {
    attempts.push({ format: args.format, max_width: args.max_width })
    return { ...SCREENSHOT_STUB, image: { ...SCREENSHOT_STUB.image, bytes: 120000 } }
  })
  const { value } = await run('screenshot', {})
  assert.equal(attempts.length, 1)
  assert.doesNotMatch(value.text, /byte budget/u)
})

test('渲染：文本信封 + （有附件时）原生图像块', async () => {
  const attachment = { attachmentId: 'a1', mediaType: 'image/png', bytes: 12, width: 1280, height: 800 }
  const { run, byName } = setup(() => SCREENSHOT_STUB, { attachments: attachment })
  const { value } = await run('screenshot', {})
  assert.deepEqual(value.image, attachment)
  const blocks = byName.get('screenshot').output.render({}, value)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, 'text')
  assert.deepEqual(blocks[1], { type: 'image', attachment })

  const noAttachment = setup(() => SCREENSHOT_STUB, { attachments: undefined })
  const plain = await noAttachment.run('screenshot', {})
  assert.equal(plain.value.image, undefined)
  assert.equal(noAttachment.byName.get('screenshot').output.render({}, plain.value).length, 1)
})

test('单工具模式：action 分发到同名 handler，未知 action 报错', async () => {
  const { single } = setup(() => ({ action_sent: true, text: 'ok' }))
  const guarded = { ...single.definition, execute: createGuardedExecute(single.definition) }
  const value = await guarded.execute({ action: 'left_click', element_index: 1, state_id: 's1' }, {})
  assert.equal(value.action, 'left_click')
  assert.match(value.text, /<action/u)
  // action 是 enum：非法值在 schema 层被拒，handler 里的 unknown-action 分支只是兜底。
  await assert.rejects(guarded.execute({ action: 'not_a_tool' }, {}), /"action" must be one of/u)
  assert.equal(single.definition.output.render({}, value).length, 1)
})

test('官方校验器确认：25 个工具在「后端只回最小字段」时输出仍是无损 JSON', async (t) => {
  if (!refAvailable()) {
    t.skip('run `node tools/ref-extract-validator.mjs` first')
    return
  }
  const tools = await loadDshPackage('@deepseek-ai/dsh-tools')
  // 最毒的场景：后端把所有可选字段都省掉（坐标点击没有 app/state_id、
  // 剪贴板为空、截图没有附件……）。真机踩到的正是这一族。
  const runtimes = createFakeRuntime({ responder: () => ({}) })
  const { native } = createToolDefinitions(runtimes)
  const minimalArgs = {
    request_access: {},
    list_apps: {},
    list_windows: {},
    get_app_state: { app: 1234 },
    screenshot: {},
    zoom: { region: { x: 0, y: 0, width: 10, height: 10 } },
    open_application: { app: 'notepad' },
    left_click: { x: 1, y: 1 },
    double_click: { x: 1, y: 1 },
    triple_click: { x: 1, y: 1 },
    right_click: { x: 1, y: 1 },
    middle_click: { x: 1, y: 1 },
    mouse_move: { x: 1, y: 1 },
    left_click_drag: { from_x: 1, from_y: 1, to_x: 2, to_y: 2 },
    scroll: { direction: 'down' },
    type: { text: 'x' },
    key: { key: 'enter' },
    hold_key: { key: 'shift' },
    set_value: { element_index: 0, state_id: 's1', value: 'v' },
    select_text: { element_index: 0, state_id: 's1' },
    perform_action: { element_index: 0, state_id: 's1', action: 'invoke' },
    wait: {},
    read_clipboard: {},
    write_clipboard: { text: 'x' },
    stop_computer_control: {},
  }
  for (const definition of native) {
    const guarded = { ...definition, execute: createGuardedExecute(definition) }
    const value = await guarded.execute(minimalArgs[definition.name] ?? {}, {})
    const violations = tools.validateJsonSchemaValue({}, value, '')
    assert.deepEqual(violations, [], `${definition.name}: ${violations.join('; ')}`)
  }
  assert.equal(native.length, 25)
})

test('appSelectorToArgs：字符串/数字/对象都归一化成协议参数', () => {
  assert.deepEqual(appSelectorToArgs('notepad'), { appKey: 'notepad' })
  assert.deepEqual(appSelectorToArgs(1234), { pid: 1234 })
  assert.deepEqual(appSelectorToArgs('0x00120abc'), { hwnd: '0x00120abc' })
  assert.deepEqual(appSelectorToArgs({ name: 'Notepad', pid: 4, hwnd: '0x2' }), { appKey: 'Notepad', pid: 4, hwnd: '0x2' })
  assert.deepEqual(appSelectorToArgs(undefined), {})
  assert.throws(() => appSelectorToArgs(true), /must be a string, an integer pid, or an object/u)
})
