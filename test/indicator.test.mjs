/**
 * 操作指示器控制器测试。
 *
 * 这里钉的是**行为与失败边界**，不是浮窗长什么样（那由 `tools/indicator-smoke.mjs`
 * 在真机上核验：点击穿透、不抢焦点、不进截图）。
 * 重点：指示器是纯装饰性的，它的任何失败都不允许影响工具执行。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { OperationIndicator, detectLocale, indicatorText } from '../src/indicator.js'

/** 假 bridge：记录调用序列，可注入失败。 */
function createFakeBridge({ failOn } = {}) {
  const calls = []
  const bridge = {
    async ensureStarted() {
      calls.push({ cmd: 'ready' })
      return { protocol: 'dsh-cua-indicator/1', psVersion: '5.1.0' }
    },
    async call(cmd, args) {
      calls.push({ cmd, args })
      if (failOn === cmd) throw new Error(`indicator ${cmd} failed`)
      return { visible: cmd !== 'hide' }
    },
    async dispose() {
      calls.push({ cmd: 'dispose' })
    },
  }
  return { bridge, calls }
}

const silent = { info: () => {}, warn: () => {} }
const flush = () => new Promise((resolve) => setImmediate(resolve))

function makeIndicator(options = {}) {
  const fake = createFakeBridge(options)
  const indicator = new OperationIndicator({
    scriptPath: 'C:\\plugin\\src\\native\\indicator.ps1',
    createBridge: () => fake.bridge,
    log: silent,
    locale: 'zh-CN',
    autoHideMs: 60,
    ...options,
  })
  return { indicator, calls: fake.calls }
}

test('文案：中文/英文基础文案，showAction 时带上动作词', () => {
  assert.equal(indicatorText(undefined, { locale: 'zh-CN' }), 'DSH 正在操作电脑')
  assert.equal(indicatorText('left_click', { locale: 'zh-CN', showAction: true }), 'DSH 正在操作电脑 · 点击')
  assert.equal(indicatorText('left_click', { locale: 'zh-CN', showAction: false }), 'DSH 正在操作电脑')
  assert.equal(indicatorText('type', { locale: 'en-US', showAction: true }), 'DSH is controlling your computer · typing')
  // 未知动作退回基础文案，不显示裸工具名
  assert.equal(indicatorText('not_a_tool', { locale: 'zh-CN', showAction: true }), 'DSH 正在操作电脑')
  // 未知 locale 退回中文
  assert.equal(indicatorText(undefined, { locale: 'fr-FR' }), 'DSH 正在操作电脑')
})

test('detectLocale：环境变量优先，否则看运行环境语言，兜底英文', () => {
  const previous = { DSH_LOCALE: process.env.DSH_LOCALE, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL }
  try {
    process.env.DSH_LOCALE = 'zh-CN'
    assert.equal(detectLocale(), 'zh-CN')
    delete process.env.DSH_LOCALE
    process.env.LANG = 'en_US.UTF-8'
    assert.equal(detectLocale(), 'en-US')
    delete process.env.LANG
    delete process.env.LC_ALL
    assert.ok(['zh-CN', 'en-US'].includes(detectLocale()))
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('首次活动 show（带动作文案），后续活动 update 而不是重复 show', async () => {
  const { indicator, calls } = makeIndicator()
  indicator.note('get_app_state')
  await flush()
  assert.deepEqual(calls, [{ cmd: 'show', args: { text: 'DSH 正在操作电脑 · 读取界面' } }])
  assert.equal(indicator.visible, true)

  indicator.note('left_click')
  await flush()
  assert.deepEqual(calls.at(-1), { cmd: 'update', args: { text: 'DSH 正在操作电脑 · 点击' } })
  assert.equal(calls.filter((call) => call.cmd === 'show').length, 1)
  await indicator.dispose()
})

test('无活动超过 autoHideMs 后自动隐藏（兜底边界）', async () => {
  const { indicator, calls } = makeIndicator({ autoHideMs: 40 })
  indicator.note('left_click')
  await flush()
  assert.equal(calls.filter((call) => call.cmd === 'hide').length, 0)
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(calls.filter((call) => call.cmd === 'hide').length, 1)
  assert.equal(indicator.visible, false)
  await indicator.dispose()
})

test('每次活动都刷新计时器：持续操作时不会中途熄灭', async () => {
  const { indicator, calls } = makeIndicator({ autoHideMs: 80 })
  for (let index = 0; index < 4; index += 1) {
    indicator.note('left_click')
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  assert.equal(calls.filter((call) => call.cmd === 'hide').length, 0)
  await new Promise((resolve) => setTimeout(resolve, 140))
  assert.equal(calls.filter((call) => call.cmd === 'hide').length, 1)
  await indicator.dispose()
})

test('stop_computer_control 立即隐藏（控制权已交还，浮层不能留）', async () => {
  const { indicator, calls } = makeIndicator({ autoHideMs: 10000 })
  indicator.note('left_click')
  await flush()
  indicator.note('stop_computer_control', { terminal: true })
  await flush()
  assert.equal(calls.at(-1).cmd, 'hide')
  assert.equal(indicator.visible, false)
  await indicator.dispose()
})

test('指示器失败绝不冒泡：show 失败只记日志，工具调用不受影响', async () => {
  const warnings = []
  const fake = createFakeBridge({ failOn: 'show' })
  const indicator = new OperationIndicator({
    scriptPath: 'x',
    createBridge: () => fake.bridge,
    log: { info: () => {}, warn: (message) => warnings.push(message) },
    autoHideMs: 10000,
  })
  assert.doesNotThrow(() => indicator.note('left_click'))
  await flush()
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /indicator failed/u)
  assert.match(warnings[0], /desktop control is unaffected/u)
  // hide / dispose 在失败态下也不抛
  await indicator.hide()
  await indicator.dispose()
})

test('禁用时不拉起进程：note/hide 都是空操作', async () => {
  const { indicator, calls } = makeIndicator({ enabled: false })
  indicator.note('left_click')
  await indicator.hide()
  await indicator.warmUp()
  assert.deepEqual(calls, [])
  assert.equal((await indicator.status()).enabled, false)
  await indicator.dispose()
})

test('预热失败只记日志（后端可用性不受影响），status 报告不可用', async () => {
  const warnings = []
  const failing = {
    async ensureStarted() {
      throw new Error('powershell.exe blocked')
    },
    async call() {
      throw new Error('powershell.exe blocked')
    },
    async dispose() {},
  }
  const indicator = new OperationIndicator({
    scriptPath: 'x',
    createBridge: () => failing,
    log: { info: () => {}, warn: (message) => warnings.push(message) },
  })
  await indicator.warmUp()
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /indicator unavailable/u)
  const status = await indicator.status()
  assert.equal(status.available, false)
  await indicator.dispose()
})

test('dispose 幂等并关掉指示器进程', async () => {
  const { indicator, calls } = makeIndicator()
  indicator.note('left_click')
  await flush()
  await indicator.dispose()
  await indicator.dispose()
  assert.equal(calls.filter((call) => call.cmd === 'dispose').length, 1)
  indicator.note('left_click')
  await flush()
  assert.equal(calls.filter((call) => call.cmd === 'show').length, 1, 'dispose 后不再拉起')
})
