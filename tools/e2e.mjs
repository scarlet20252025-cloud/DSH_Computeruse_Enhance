#!/usr/bin/env node
/**
 * 真机端到端：**本插件的完整链路** —— `src/index.js` 注册的工具定义
 * → `src/tools.js` 参数映射与信封 → `src/bridge.js` NDJSON 客户端
 * → `src/native/cua.ps1` 原生后端 → 真实桌面。
 *
 * 与 `tools/native-smoke.mjs` 的分工：
 *   - smoke 只测原生后端（协议层），即使插件 JS 全坏也会 PASS；
 *   - 本文件测的是模型真正会走的那条路，唯一不解的是 DSH 自身的注册表与提示词组装
 *     （那部分由 test/*.test.mjs 用官方实现交叉验证）。
 *
 * 注入目标是我们自己启动的 WinForms 夹具（tools/e2e-fixture.ps1），
 * 不碰用户任何窗口与文档；每种输入注入都有可回读的观察证据：
 *   - 键盘注入 → 夹具文本框的 UIA value 必须等于注入文本
 *   - 元素点击 → 夹具窗口标题必须变成 CLICKED:<n>
 *   - 栅格坐标点击 → 同上的增量证明坐标映射正确
 *   - 剪贴板写入 → 夹具里 ctrl+a/ctrl+c 后读回的文本
 *
 * 用法：node tools/e2e.mjs
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = new URL('..', import.meta.url)
// 必须转成真实路径：spawn 的参数只接受字符串，传 URL 会得到 "file:///…" 并让
// PowerShell 报「找不到路径」而立刻退出（这个坑已经踩过一次）。
const fixtureScript = fileURLToPath(new URL('./e2e-fixture.ps1', import.meta.url))
const srcIndex = fileURLToPath(new URL('../src/index.js', import.meta.url))
const srcBridgePath = fileURLToPath(new URL('../src/bridge.js', import.meta.url))
const srcNativePath = fileURLToPath(new URL('../src/native/cua.ps1', import.meta.url))
const srcConfig = fileURLToPath(new URL('../src/config.js', import.meta.url))

let pass = 0
let fail = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${label}${detail === undefined ? '' : `  -> ${short(detail)}`}`)
  } else {
    fail += 1
    failures.push(label)
    console.log(`  FAIL  ${label}${detail === undefined ? '' : `  -> ${short(detail)}`}`)
  }
}

function short(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

/**
 * 前置体检：夹具窗口是否可见、能否成为前台窗口。
 *
 * 全部用原生后端直接问（不经插件工具），失败返回 `{visible,foreground,reason}` 而不是抛错，
 * 让调用方能给出「环境不适合」的明确结论。
 */
async function probeDesktopForInput(pid) {
  const { NativeBridge } = await import(pathToFileURL(srcBridgePath).href)
  const bridge = new NativeBridge({ scriptPath: srcNativePath, defaultTimeoutMs: 30000 })
  try {
    await bridge.ensureStarted()
    const first = await bridge.call('list_windows', { pid }, { timeoutMs: 30000 })
    const window = first.windows?.[0]
    if (window === undefined) {
      return { visible: false, foreground: false, reason: '夹具窗口不可见（被全屏应用遮挡、被最小化，或已退出）' }
    }
    try {
      await bridge.call('focus_window', { hwnd: window.hwnd }, { timeoutMs: 15000 })
    } catch {
      /* 切前台失败由下面的事实判定 */
    }
    const after = await bridge.call('list_windows', { pid }, { timeoutMs: 30000 })
    const foreground = after.windows?.[0]?.foreground === true
    return {
      visible: true,
      foreground,
      title: window.title,
      reason: foreground ? 'ok' : '夹具窗口无法成为前台窗口（多半有全屏应用/游戏在跑）',
    }
  } catch (error) {
    return {
      visible: false,
      foreground: false,
      reason: `探针失败：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    await bridge.dispose()
  }
}

/** 启动夹具并拿到 pid。 */
async function startFixture() {
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', fixtureScript], {
    windowsHide: false,
  })
  const pid = await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('fixture did not report its pid in time')), 20000)
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk)
      const match = /FIXTURE_PID=(\d+)/u.exec(buffer)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    })
    child.on('error', reject)
    child.on('exit', (code) => reject(new Error(`fixture exited early (code=${code})`)))
  })
  return { child, pid }
}

async function killFixture(pid) {
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    killer.on('exit', () => resolve(undefined))
    killer.on('error', () => resolve(undefined))
  })
}

/**
 * 列出本进程派生的 NativeBridge 子进程。
 * @param needle 命令行特征串（**必须由调用方用拼接方式构造**，不能出现在查询文本里，
 *               否则跑这条查询的 powershell.exe 自己会被匹配上——这个坑踩过一次）
 */
function listChildProcesses(needle) {
  const query =
    "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const text = (result.stdout ?? '').trim()
  if (text === '') return []
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows
    .filter((row) => typeof row?.CommandLine === 'string' && row.CommandLine.includes(needle))
    .filter((row) => Number(row.ParentProcessId) === process.pid)
    .map((row) => Number(row.ProcessId))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

/** 原生后端进程。 */
const listBackendProcesses = () => listChildProcesses(BACKEND_NEEDLE)
/** 操作指示器进程（`indicator.ps1`）。 */
const listIndicatorProcesses = () => listChildProcesses(INDICATOR_NEEDLE)

/** 拼出来的特征串：不会出现在上面的查询文本里，避免自匹配。 */
const BACKEND_NEEDLE = ['cua', '.ps1'].join('')
const INDICATOR_NEEDLE = ['indic', 'ator', '.ps1'].join('')

/** 轮询直到谓词为真（或超时）。 */
async function waitFor(predicate, timeoutMs, stepMs = 250) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

/** 等指示器报告可见（首次动作到 WPF 窗口显示之间有一次进程内往返）。 */
async function waitForIndicator() {
  const deadline = Date.now() + 8000
  let last
  for (;;) {
    last = await indicator.status()
    if (last?.visible === true) return last
    if (Date.now() > deadline) return last
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/** 等到后端进程全部退出；返回是否在期限内退干净。 */
async function waitForBackendExit(timeoutMs) {
  return await waitFor(() => listBackendProcesses().length === 0, timeoutMs, 200)
}

const home = await mkdtemp(join(tmpdir(), 'dsh-cu-e2e-'))
process.env.DSH_HOME = home

const { resetHomeCacheForTesting } = await import(pathToFileURL(srcConfig).href)
resetHomeCacheForTesting()
const { apply, createGuardedExecute } = await import(pathToFileURL(srcIndex).href)
const { OperationIndicator } = await import(pathToFileURL(fileURLToPath(new URL('../src/indicator.js', import.meta.url))).href)
const { indicatorScriptPath } = await import(pathToFileURL(fileURLToPath(new URL('../src/config.js', import.meta.url))).href)

const savedFrames = []
const attachments = []
const registry = {
  logger: { info: () => {}, warn: (m) => console.log(`  [plugin warn] ${m}`), error: (m) => console.log(`  [plugin error] ${m}`) },
  tools: {
    register(definition) {
      registry.__definitions.push(definition)
      return () => {}
    },
  },
  __definitions: [],
  get(name) {
    if (name === 'commands') {
      // 真机闸门验收要用它来切设置：GUI 里点菜单和这里调 handler 是同一条路径。
      return {
        register(definition) {
          registry.__commands.set(definition.name, definition)
          return () => registry.__commands.delete(definition.name)
        },
      }
    }
    if (name === 'attachments') {
      return {
        imageLimits: {
          mediaTypes: ['image/png', 'image/jpeg'],
          maxImageBytes: 20 * 1024 * 1024,
          maxMessageImageBytes: 8 * 1024 * 1024,
        },
        async saveImage({ data, mediaType, name }) {
          const ref = {
            attachmentId: `att-${attachments.length + 1}`,
            mediaType,
            bytes: data.byteLength,
            width: 1,
            height: 1,
            name,
          }
          attachments.push(ref)
          return ref
        },
      }
    }
    if (name === 'llm') {
      // 假的模型路由信息：声明支持图像输入，用来验证「路由支持图像时才挂图像块」这条门禁。
      return {
        async resolveModelInfo() {
          return { inputModalities: ['text', 'image'] }
        },
      }
    }
    return undefined
  },
  effect(fn) {
    registry.__disposeEffect = fn
    return () => {}
  },
  on() {
    return () => {}
  },
  __commands: new Map(),
}

let fixture
let definitionByName
let indicator
try {
  section('启动夹具窗口（我们自己的进程，零用户风险）')
  fixture = await startFixture()
  check('夹具进程已启动', Number.isFinite(fixture.pid), { pid: fixture.pid })
  section('前置体检：这台桌面现在能不能接受输入注入')
  // 本套件靠**真实输入注入**验证（type/key/click 打到夹具窗口再回读）。
  // 若有全屏游戏/独占全屏应用在跑，夹具既拿不到前台也收不到注入，于是会出现
  // 「剪贴板里是别人的内容」「窗口不见了」这类**看起来像产品 bug 的失败**。
  // 与其给出误导性结论，先把环境说清楚：报 INCONCLUSIVE 并退出 2。
  const health = await probeDesktopForInput(fixture.pid)
  check('夹具窗口可见', health.visible === true, { title: health.title })
  check('夹具窗口能成为前台（否则注入会打到别处）', health.foreground === true, health.reason)
  if (health.visible !== true || health.foreground !== true) {
    console.log(`\n  INCONCLUSIVE: ${health.reason}`)
    console.log('  桌面当前不适合做真实注入验证（例如全屏游戏/独占全屏应用在前台）。')
    console.log('  把前台切回普通窗口后重跑本套件；本插件自身的正确性不受此影响。')
    process.exitCode = 2
    throw new Error('desktop cannot accept injected input right now')
  }

  // 真实指示器实例：WPF 冷启动要 1-2 秒，先预热，与插件加载时的行为一致。
  indicator = new OperationIndicator({
    scriptPath: indicatorScriptPath(),
    locale: 'zh-CN',
    showAction: true,
    autoHideMs: 60000,
    log: { info: () => {}, warn: (message) => console.log(`  [indicator warn] ${message}`) },
  })
  await indicator.warmUp()
  check('指示器进程可预热', listIndicatorProcesses().length === 1, listIndicatorProcesses())

  section('插件加载：注册 25 个工具 + 自装技能')
  // indicator: false —— 由本测试自己持有一个真实指示器实例（见下），
  // 避免插件与测试各拉一个浮窗。
  await apply(registry, {
    tools: 'native',
    warmup: true,
    installSkill: true,
    screenshotMaxWidth: 0,
    indicator: false,
  })
  definitionByName = new Map(registry.__definitions.map((definition) => [definition.name, definition]))
  check('注册了 25 个工具', registry.__definitions.length === 25, registry.__definitions.length)
  check(
    '技能已装进用户技能根',
    existsSync(join(home, 'skills', 'computer-use', 'SKILL.md')),
    join(home, 'skills', 'computer-use', 'SKILL.md'),
  )

  // 真实调用总是带 agent（DSH 的注册表分发路径保证），这里也照做：
  // 闸门用 `exec.agent.session.header` 判「主 Agent / 子代理」，不带 agent 的调用
  // 在限制态下会被 fail-closed 拒绝——那是刻意的（见 src/access.js 的注释）。
  const mainExec = () => ({
    callId: `e2e-${Date.now()}`,
    signal: new AbortController().signal,
    agent: { id: 'e2e-main', session: { header: { id: 'e2e-main' } }, options: {} },
  })

  const call = async (name, args = {}, exec = mainExec()) => {
    const definition = definitionByName.get(name)
    if (definition === undefined) throw new Error(`no tool ${name}`)
    const before = attachments.length
    // 与生产同款守卫（参数宽化校验 + 闸门 + 输出清洗 + 指示器），避免「测试路径」与「真实路径」分叉。
    const value = await createGuardedExecute(definition, indicator)(args, exec)
    return { value, newAttachments: attachments.slice(before) }
  }

  section('request_access：后端可用性与环境自述')
  const access = await call('request_access')
  check('ready === true', access.value.ready === true, access.value.text.split('\n')[0])
  check('platform 是 win32', access.value.platform === 'win32', access.value.platform)
  check('dpiAware === true', access.value.dpiAware === true, access.value.dpiAware)
  check('至少一个显示器', access.value.monitors >= 1, access.value.monitors)
  check('信封里有屏幕尺寸', /virtual_screen="\d+x\d+"/u.test(access.value.text), access.value.text)

  section('操作指示器：动作一开始就亮起（协议事实，不是本地视图）')
  const indicatorStatus = await waitForIndicator()
  check('指示器原生侧报告 visible === true', indicatorStatus?.visible === true, indicatorStatus)
  check('指示器在屏幕上确为最前端', indicatorStatus?.topmost === true, indicatorStatus?.topmost)
  check('指示器点击穿透', indicatorStatus?.clickThrough === true, indicatorStatus?.clickThrough)
  check('指示器不抢焦点', indicatorStatus?.noActivate === true, indicatorStatus?.noActivate)
  check(
    '指示器不进截图（WDA_EXCLUDEFROMCAPTURE）',
    indicatorStatus?.excludedFromCapture === true,
    { affinity: indicatorStatus?.affinity },
  )
  check('指示器文案带上了当前动作', /检查环境/u.test(String(indicatorStatus?.text)), indicatorStatus?.text)

  section('list_apps / list_windows：找到夹具应用')
  const apps = await call('list_apps')
  const fixtureApp = (apps.value.apps ?? []).find((app) => app.pid === fixture.pid)
  check('list_apps 能列出夹具进程', fixtureApp !== undefined, (apps.value.apps ?? []).map((a) => `${a.appKey}:${a.pid}`))
  check('信封是 <apps> 结构', apps.value.text.includes('<apps count='), apps.value.text.split('\n')[0])
  const fixtureKey = fixtureApp.appKey
  // 主流程用 pid 精确定位：appKey 是进程名，同名进程可能有别的窗口。
  const fixtureTarget = { pid: fixture.pid }

  const windows = await call('list_windows', { app: fixtureTarget })
  check('list_windows 按 appKey 过滤到 1 个窗口', windows.value.count === 1, { count: windows.value.count })
  const fixtureWindow = windows.value.windows[0]
  check('窗口标题是夹具标题', fixtureWindow.title === 'DSH CUA Fixture', fixtureWindow.title)
  check('窗口 bounds 是物理像素', fixtureWindow.bounds.width > 0 && fixtureWindow.bounds.height > 0, fixtureWindow.bounds)

  section('get_app_state：读夹具界面元素')
  const state1 = await call('get_app_state', { app: fixtureTarget })
  check('有 state_id', typeof state1.value.state_id === 'string' && state1.value.state_id.length > 0, state1.value.state_id)
  check('元素非空', state1.value.elements.length > 0, state1.value.elementCount)
  check('信封带 state_id 与元素行', state1.value.text.includes(`state_id="${state1.value.state_id}"`), state1.value.text.split('\n')[0])
  check('首次观察没有 changes', state1.value.changes === undefined, state1.value.changes)
  check(
    'presentationMeta 带上游 app-associations 键',
    state1.value.meta['zcode.cua/app-associations-v1']?.primary?.appKey === fixtureKey,
    state1.value.meta,
  )

  const inputEl = state1.value.elements.find((element) => element.name === 'FixtureInput')
  const buttonEl = state1.value.elements.find((element) => element.name === 'FixtureButton')
  check('找到 FixtureInput 文本框元素', inputEl !== undefined, inputEl)
  check('找到 FixtureButton 按钮元素', buttonEl !== undefined, buttonEl)
  check('文本框支持 set_value', Array.isArray(inputEl?.actions) && inputEl.actions.includes('set_value'), inputEl?.actions)

  section('type（元素目标）：键盘注入 → UIA 回读文本')
  const typed = 'dsh-computer-use e2e 中文 ✅'
  const typeResult = await call('type', {
    text: typed,
    element_index: inputEl.index,
    state_id: state1.value.state_id,
  })
  check('type 报告 action_sent', typeResult.value.action_sent === true, typeResult.value.text.split('\n')[1])
  check('type 报告字符数', typeResult.value.characters === typed.length, typeResult.value.characters)

  // 键盘注入是异步生效的：SendInput 只负责把事件塞进输入队列，目标进程把字符
  // 逐个处理再让 UIA 的 Value 跟上，中间有可观测的延迟（本机实测 130ms 发出 25 字符，
  // 约 200~330ms 后 UIA 才读全）。此处立刻读一次会稳定读到被截断的前缀
  // （实测 18/25），所以这里必须轮询到收敛，而不是断言「立刻就是全量」。
  const deadline = Date.now() + 3000
  let inputAfter = null
  let state2 = null
  for (;;) {
    state2 = await call('get_app_state', { app: fixtureTarget })
    inputAfter = state2.value.elements.find((element) => element.name === 'FixtureInput')
    if (inputAfter?.value === typed) break
    if (Date.now() > deadline) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  check('文本框 value 等于注入文本（轮询到 UIA 收敛）', inputAfter?.value === typed, inputAfter?.value)
  check('第二次观察带 changes', state2.value.changes !== undefined, state2.value.changes)

  section('set_value：程序化写值 → UIA 回读')
  const setResult = await call('set_value', {
    element_index: inputAfter.index,
    state_id: state2.value.state_id,
    value: 'set_value 覆写',
  })
  check('set_value 报告 action_sent', setResult.value.action_sent === true, setResult.value.text.split('\n')[1])
  const state3 = await call('get_app_state', { app: fixtureTarget })
  const inputSet = state3.value.elements.find((element) => element.name === 'FixtureInput')
  check('文本框 value 被 set_value 改写', inputSet?.value === 'set_value 覆写', inputSet?.value)

  section('key / select_text / 剪贴板：快捷键注入链路')
  await call('key', { key: 'ctrl+a' })
  const selectResult = await call('select_text', {
    element_index: inputSet.index,
    state_id: state3.value.state_id,
    all: true,
  })
  check('select_text 报告 action_sent', selectResult.value.action_sent === true, selectResult.value.text.split('\n')[1])
  await call('key', { key: 'ctrl+c' })
  const clip = await call('read_clipboard')
  check('ctrl+a/ctrl+c 后剪贴板内容与文本框一致', clip.value.text_value === 'set_value 覆写', clip.value.text_value)
  check('读剪贴板信封是 <clipboard>', clip.value.text.startsWith('<clipboard'), clip.value.text.split('\n')[0])

  await call('write_clipboard', { text: '来自 write_clipboard' })
  const clip2 = await call('read_clipboard')
  check('write_clipboard → read_clipboard 往返一致', clip2.value.text_value === '来自 write_clipboard', clip2.value.text_value)

  section('left_click（元素目标）→ 夹具窗口标题变化')
  // 元素索引只在产生它的那次 state_id 内有效，因此动作前重新观察（这正是技能里教模型的纪律）。
  const beforeClickState = await call('get_app_state', { app: fixtureTarget })
  const beforeClickTitle = beforeClickState.value.window.title
  const clickTarget = beforeClickState.value.elements.find((element) => element.name === 'FixtureButton')
  const clickResult = await call('left_click', {
    element_index: clickTarget.index,
    state_id: beforeClickState.value.state_id,
  })
  check('元素点击报告 action_sent', clickResult.value.action_sent === true, clickResult.value.text.split('\n')[1])
  await call('wait', { duration_ms: 250 })
  const afterElementClick = await call('get_app_state', { app: fixtureTarget })
  check(
    '窗口标题变成 CLICKED:1（点击真的生效）',
    afterElementClick.value.window.title === 'DSH CUA Fixture CLICKED:1',
    { before: beforeClickTitle, after: afterElementClick.value.window.title },
  )
  const buttonEl2 = afterElementClick.value.elements.find((element) => element.name === 'FixtureButton')

  section('screenshot → 栅格坐标 → left_click（坐标映射）')
  const visionExec = { agent: { options: { provider: 'fake', model: 'fake-vision' } } }
  const shot = await call('screenshot', { max_width: 1280 }, visionExec)
  check('screenshot 返回 frame_id', typeof shot.value.frame_id === 'string', shot.value.frame_id)
  check('截图信封写着坐标规则', shot.value.text.includes('Coordinate rule'), shot.value.text.split('\n')[0])
  check('图像路由下截图挂了图像块', shot.newAttachments.length === 1, shot.newAttachments)
  check(
    'raster 尺寸与 envelope 一致',
    new RegExp(`raster="${shot.value.text.match(/raster="(\d+x\d+)"/u)?.[1]}"`, 'u').test(shot.value.text),
    shot.value.text.match(/raster="[^"]*"/u)?.[0],
  )
  check('截图栅格已落盘', typeof shot.value.savedPath === 'string' && existsSync(shot.value.savedPath), shot.value.savedPath)

  // 用元素 bounds（物理像素）推导栅格坐标：raster = (screen - source) * scale
  const source = shot.value.text.match(/source_region="(-?\d+),(-?\d+),(\d+),(\d+)"/u)
  const rasterSize = shot.value.text.match(/raster="(\d+)x(\d+)"/u)
  const scale = Number(rasterSize[1]) / Number(source[3])
  const centerScreenX = buttonEl2.bounds.x + Math.round(buttonEl2.bounds.width / 2)
  const centerScreenY = buttonEl2.bounds.y + Math.round(buttonEl2.bounds.height / 2)
  const rasterX = Math.round((centerScreenX - Number(source[1])) * scale)
  const rasterY = Math.round((centerScreenY - Number(source[2])) * scale)
  check('推导出的栅格坐标在图片范围内', rasterX >= 0 && rasterX < Number(rasterSize[1]), { rasterX, rasterY, scale })

  const rasterClick = await call('left_click', { x: rasterX, y: rasterY, frame_id: shot.value.frame_id })
  check('栅格坐标点击报告 action_sent', rasterClick.value.action_sent === true, rasterClick.value.text.split('\n')[1])
  await call('wait', { duration_ms: 250 })
  const afterRasterClick = await call('get_app_state', { app: fixtureTarget })
  check(
    '窗口标题变成 CLICKED:2（栅格坐标映射正确）',
    afterRasterClick.value.window.title === 'DSH CUA Fixture CLICKED:2',
    afterRasterClick.value.window.title,
  )
  // 放在栅格点击之后：多截一帧会让 f2 不再是最新帧，从而正确地把上面那次点击判成 stale。
  const noRouteShot = await call('screenshot', { max_width: 320 })
  check(
    '无路由信息时降级为纯文本信封（不挂图像块）',
    noRouteShot.newAttachments.length === 0 && noRouteShot.value.image === undefined,
    noRouteShot.value.image,
  )

  section('zoom / scroll / mouse_move / drag / hold_key / perform_action')
  const zoomed = await call('zoom', {
    region: {
      x: fixtureWindow.bounds.x,
      y: fixtureWindow.bounds.y,
      width: Math.min(200, fixtureWindow.bounds.width),
      height: Math.min(120, fixtureWindow.bounds.height),
    },
    scale: 2,
  })
  check('zoom 返回新 frame_id', typeof zoomed.value.frame_id === 'string', zoomed.value.frame_id)
  check('zoom 信封标记 kind="zoom"', zoomed.value.text.includes('kind="zoom"'), zoomed.value.text.split('\n')[0])

  const scroll = await call('scroll', { direction: 'down', amount: 2, x: rasterX, y: rasterY })
  check('scroll 报告 action_sent', scroll.value.action_sent === true, scroll.value.text.split('\n')[1])
  const move = await call('mouse_move', { x: rasterX, y: rasterY, duration_ms: 100 })
  check('mouse_move 报告 action_sent', move.value.action_sent === true, move.value.text.split('\n')[1])
  const drag = await call('left_click_drag', {
    from_x: Math.max(0, rasterX - 40),
    from_y: rasterY,
    to_x: rasterX,
    to_y: rasterY,
    duration_ms: 200,
  })
  check('left_click_drag 报告 action_sent', drag.value.action_sent === true, drag.value.text.split('\n')[1])
  const held = await call('hold_key', { key: 'shift', duration_ms: 200 })
  check('hold_key 报告 action_sent', held.value.action_sent === true, held.value.text.split('\n')[1])

  const stateForAction = await call('get_app_state', { app: fixtureTarget })
  const actionTarget = stateForAction.value.elements.find((element) => element.name === 'FixtureInput')
  const performed = await call('perform_action', {
    element_index: actionTarget.index,
    state_id: stateForAction.value.state_id,
    action: 'focus',
  })
  check('perform_action(focus) 报告 action_sent', performed.value.action_sent === true, performed.value.text.split('\n')[1])

  section('访问闸门（真机）：禁用时真的点不动，放开后真的能点')
  // 这一段验收「界面上的开关真的有效」：改设置 → 走同一条生产路径调用 → 看桌面有没有变。
  // 判据用**夹具窗口标题**（外部事实，且用原生后端独立读取，不采信工具自己的返回值）——
  // 「工具说被拒绝了、桌面却已经动过」是这类安全功能最危险的失败模式。
  const settings = registry.__commands.get('computer-use')
  check('注册了 /computer-use 命令（GUI 菜单走同一条路径）', settings !== undefined)
  const titleBeforeGate = (await probeDesktopForInput(fixture.pid)).title

  // 闸门这一段必须走**插件的注册定义**（`registry.__definitions` 里的 execute 就是生产包装），
  // 不能再套一层本套件的包装：外层包装会先点亮指示器、内层闸门才拒绝，
  // 于是「被拒绝的调用没有点亮指示器」这条会被测试自己弄成假失败。
  // 生产里也只有一层包装——这里照生产来。
  const callGuarded = async (name, args, exec = mainExec()) => {
    const definition = definitionByName.get(name)
    if (definition === undefined) throw new Error(`no tool ${name}`)
    return await definition.execute(args, exec)
  }

  const offResult = await settings.handler({ rawInput: 'mode=off' })
  check('切到禁用成功', offResult.kind === 'success' && /禁用/u.test(offResult.text), offResult.text)
  // 浮层先收掉：前面的正常调用已经点亮过它，而它要等 60s 兜底才自动隐藏。
  await indicator.hide()
  await new Promise((resolve) => setTimeout(resolve, 250))
  const activityBeforeDenied = indicator.lastActivityAt
  await assert.rejects(
    callGuarded('left_click', { x: 300, y: 300 }),
    (error) => error.code === 'CUA_DISABLED',
    '禁用后必须拒绝，且是 CUA_DISABLED',
  )
  await assert.rejects(
    callGuarded('get_app_state', { app: fixtureTarget }),
    (error) => error.code === 'CUA_DISABLED',
    '禁用后连只读工具也不放行（禁用就是禁用）',
  )
  const afterDenied = await indicator.status()
  check(
    '被拒绝的调用没有点亮操作指示器',
    afterDenied.visible === false && indicator.lastActivityAt === activityBeforeDenied,
    { visible: afterDenied.visible, activityChanged: indicator.lastActivityAt !== activityBeforeDenied },
  )
  const titleWhileOff = (await probeDesktopForInput(fixture.pid)).title
  check('禁用期间窗口标题没变（桌面真的没被碰）', titleWhileOff === titleBeforeGate, {
    before: titleBeforeGate,
    after: titleWhileOff,
  })

  const restore = await settings.handler({ rawInput: 'mode=auto subagents=off' })
  check('恢复「全自动 + 关闭子代理」', restore.kind === 'success', restore.text)
  const subagent = {
    callId: 'e2e-sub',
    signal: new AbortController().signal,
    agent: {
      id: 'e2e-sub',
      session: { header: { id: 'e2e-sub', origin: 'subagent', delegationDepth: 1, parentSession: 'e2e-main' } },
      options: {},
    },
  }
  await assert.rejects(
    callGuarded('left_click', { x: 300, y: 300 }, subagent),
    (error) => error.code === 'CUA_SUBAGENT_BLOCKED',
    '同一设置下主 Agent 放行 ≠ 子代理放行',
  )
  check('子代理被单独拦住（主 Agent 可点、子代理不可点）', true)

  const stateForGate = await call('get_app_state', { app: fixtureTarget })
  const gateButton = stateForGate.value.elements.find((element) => element.name === 'FixtureButton')
  const reopened = await call('left_click', {
    element_index: gateButton.index,
    state_id: stateForGate.value.state_id,
  })
  check('放开后主 Agent 的点击真的生效', reopened.value.action_sent === true, reopened.value.text.split('\n')[0])
  await call('wait', { duration_ms: 300 })
  const titleAfterReopen = (await probeDesktopForInput(fixture.pid)).title
  check('窗口标题确实变了（说明前面拦住的那些调用没白拦）', titleAfterReopen !== titleBeforeGate, {
    before: titleBeforeGate,
    after: titleAfterReopen,
  })

  section('未实现的工具路径：open_application 拒绝不存在的应用')
  await assert.rejects(
    call('open_application', { app: 'definitely-not-an-application-xyz' }),
    (error) => /LAUNCH_FAILED|Could not launch/u.test(error.message),
    'open_application 应当把 LAUNCH_FAILED 翻成可读错误',
  )
  check('open_application 失败信息里有 Hint 或原始原因', true)

  section('错误路径：stale state_id 带上可修提示')
  await assert.rejects(
    call('left_click', { element_index: clickTarget.index, state_id: beforeClickState.value.state_id }),
    (error) => error.code === 'ELEMENT_STALE' && /Hint: .*get_app_state/u.test(error.message),
    'ELEMENT_STALE 必须带「重新观察」的提示',
  )
  check('ELEMENT_STALE 已按契约返回并带 Hint', true)

  section('stop_computer_control：释放按键并结束拖拽')
  const stop = await call('stop_computer_control')
  check('stop 报告 stopped', stop.value.stopped === true, stop.value.text.split('\n')[0])
  check('stop 幂等（再来一次）', (await call('stop_computer_control')).value.stopped === true)

  section('操作指示器：控制权交还后立即收起')
  const hidden = await waitFor(async () => (await indicator.status()).visible === false, 8000)
  check('指示器已隐藏（可见性保证不能滞留）', hidden, await indicator.status())
} catch (error) {
  fail += 1
  failures.push(`uncaught: ${error instanceof Error ? error.message : String(error)}`)
  console.log(`\n  FAIL  uncaught: ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`)
} finally {
  section('清理')
  if (fixture !== undefined) {
    await killFixture(fixture.pid)
    check('夹具进程已结束', true, { pid: fixture.pid })
  }
  if (typeof registry.__disposeEffect === 'function') {
    const cleanup = registry.__disposeEffect()
    if (typeof cleanup === 'function') cleanup()
    // dispose 是同步的（cordis 生命周期要求），内部对 bridge.dispose() 是 fire-and-forget。
    // 这里**轮询**到后端进程真的消失为止，并把它当成一条断言：
    // 「卸载后不遗留 helper 进程」是这个插件必须成立的性质（否则每装一次泄一个进程）。
    const gone = await waitForBackendExit(6000)
    check('dispose 后不遗留原生后端进程', gone, gone ? 'no cua.ps1 process' : 'cua.ps1 still alive')
  }
  if (indicator !== undefined) {
    await indicator.dispose()
    const indicatorGone = await waitFor(() => listIndicatorProcesses().length === 0, 6000)
    check('dispose 后不遗留指示器进程', indicatorGone, listIndicatorProcesses())
  }
  console.log(`\n${'='.repeat(72)}`)
  console.log(`PASS ${pass}   FAIL ${fail}`)
  if (failures.length > 0) console.log(`failed: ${failures.join(' | ')}`)
  console.log('='.repeat(72))
  process.exitCode = fail === 0 ? 0 : 1
}
