/**
 * 原生后端客户端（NDJSON 协议）的行为测试。
 *
 * 全部用注入的假子进程跑，不启动真实 PowerShell：协议边界（就绪横幅、串行化、
 * 超时换进程、错误码透传、关停）在这里钉死，真机验证交给 tools/native-smoke.mjs。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BridgeError, BridgeUnavailableError, NativeBridge } from '../src/bridge.js'
import { FakeChild } from './helpers.mjs'

/** 造一个桥 + 一个假子进程；已发出横幅。 */
function makeBridge(options = {}) {
  const children = []
  const spawnImpl = () => {
    const child = new FakeChild()
    children.push(child)
    return child
  }
  const bridge = new NativeBridge({
    scriptPath: 'C:\\plugin\\src\\native\\cua.ps1',
    startupTimeoutMs: 1000,
    defaultTimeoutMs: 1000,
    maxRestarts: 2,
    spawnImpl,
    ...options,
  })
  return { bridge, children, child: () => children.at(-1) }
}

/** 等一个宏任务，让内部 await 链推进。 */
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('就绪横幅解析：ensureStarted 返回 data，并标记存活', async () => {
  const { bridge, child } = makeBridge()
  const started = bridge.ensureStarted()
  await tick()
  child().emitLine({ id: null, ok: true, event: 'ready', data: { protocol: 'dsh-cua/1', dpiAware: true } })
  const info = await started
  assert.equal(info.protocol, 'dsh-cua/1')
  assert.equal(bridge.alive, true)
  assert.equal(bridge.readyInfo.dpiAware, true)
  await bridge.dispose()
})

test('call 写出的请求带 id/cmd/args，响应按 id 归位', async () => {
  const { bridge, child } = makeBridge()
  const started = bridge.ensureStarted()
  await tick()
  child().emitLine({ id: null, ok: true, event: 'ready', data: {} })
  await started

  const pending = bridge.call('list_apps', { include_minimized: false })
  await tick()
  const request = child().lastRequest()
  assert.equal(request.cmd, 'list_apps')
  assert.deepEqual(request.args, { include_minimized: false })
  assert.equal(typeof request.id, 'string')

  child().emitLine({ id: request.id, ok: true, data: { count: 1, apps: [{ appKey: 'notepad' }] } })
  assert.deepEqual(await pending, { count: 1, apps: [{ appKey: 'notepad' }] })
  await bridge.dispose()
})

test('后端错误码原样透传为 BridgeError', async () => {
  const { bridge, child } = makeBridge()
  const started = bridge.ensureStarted()
  await tick()
  child().emitLine({ id: null, ok: true, event: 'ready', data: {} })
  await started

  const pending = bridge.call('click', { element_index: 3, state_id: 's1' })
  await tick()
  child().emitLine({
    id: child().lastRequest().id,
    ok: false,
    error: { code: 'ELEMENT_STALE', message: 'state s1 is stale', details: { current: 's2' } },
  })
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof BridgeError)
    assert.equal(error.code, 'ELEMENT_STALE')
    assert.equal(error.message, 'state s1 is stale')
    assert.deepEqual(error.details, { current: 's2' })
    return true
  })
  await bridge.dispose()
})

test('响应 id 不匹配 → PROTOCOL_MISMATCH，不与下一条请求错配', async () => {
  const { bridge, child } = makeBridge()
  const started = bridge.ensureStarted()
  await tick()
  child().emitLine({ id: null, ok: true, event: 'ready', data: {} })
  await started

  const pending = bridge.call('ping', {})
  await tick()
  child().emitLine({ id: 'someone-else', ok: true, data: {} })
  await assert.rejects(pending, (error) => error instanceof BridgeError && error.code === 'PROTOCOL_MISMATCH')
  await bridge.dispose()
})

test('调用超时 → TIMEOUT 并换掉进程（迟到响应不会错配）', async () => {
  const { bridge, children, child } = makeBridge()
  const started = bridge.ensureStarted()
  await tick()
  child().emitLine({ id: null, ok: true, event: 'ready', data: {} })
  await started

  const pending = bridge.call('get_app_state', {}, { timeoutMs: 30 })
  await tick()
  const stalled = child()
  await assert.rejects(pending, (error) => error instanceof BridgeError && error.code === 'TIMEOUT')
  assert.equal(stalled.killed, true, '超时后必须 kill，否则迟到响应会错配')

  // 下一次调用会重新拉起一个新进程。
  const retry = bridge.ensureStarted()
  await tick()
  assert.equal(children.length, 2)
  child().emitLine({ id: null, ok: true, event: 'ready', data: { protocol: 'dsh-cua/1' } })
  await retry
  await bridge.dispose()
})

test('协议串行：第二条请求在第一条响应之后才写出', async () => {
  const { bridge, child } = makeBridge()
  const started = bridge.ensureStarted()
  await tick()
  child().emitLine({ id: null, ok: true, event: 'ready', data: {} })
  await started

  const first = bridge.call('ping', {})
  const second = bridge.call('ping', {})
  await tick()
  assert.equal(child().writes.length, 1, '一次只允许一个在飞请求')

  child().emitLine({ id: child().lastRequest().id, ok: true, data: { pong: true } })
  await tick()
  assert.equal(child().writes.length, 2)
  child().emitLine({ id: child().lastRequest().id, ok: true, data: { pong: true } })
  await Promise.all([first, second])
  await bridge.dispose()
})

test('stderr 进诊断而不是协议；onDiagnostic 收到行', async () => {
  const seen = []
  const { bridge, child } = makeBridge({ onDiagnostic: (line) => seen.push(line) })
  const started = bridge.ensureStarted()
  await tick()
  child().emitStderr('WARN uia tree capped\n')
  child().emitLine({ id: null, ok: true, event: 'ready', data: {} })
  await started
  assert.deepEqual(seen, ['WARN uia tree capped'])
  assert.match(bridge.diagnostics, /uia tree capped/u)
  await bridge.dispose()
})

test('stdout 上的非 JSON 噪声只记诊断，不破坏后续请求', async () => {
  const seen = []
  const { bridge, child } = makeBridge({ onDiagnostic: (line) => seen.push(line) })
  const started = bridge.ensureStarted()
  await tick()
  child().stdout.emit('data', 'Add-Type output leaked\n')
  child().emitLine({ id: null, ok: true, event: 'ready', data: {} })
  await started
  assert.match(seen.join('\n'), /non-JSON line/u)
  await bridge.dispose()
})

test('dispose 先发 shutdown 再结束进程，且幂等', async () => {
  const { bridge, child } = makeBridge()
  const started = bridge.ensureStarted()
  await tick()
  child().emitLine({ id: null, ok: true, event: 'ready', data: {} })
  await started

  const disposed = bridge.dispose()
  await tick()
  assert.equal(child().lastRequest()?.cmd, 'shutdown')
  child().emitLine({ id: child().lastRequest().id, ok: true, data: { stopped: true } })
  child().emit('exit', 0, null)
  await disposed
  await bridge.dispose()
  assert.equal(child().killed, true)
})

test('scriptPath 传 URL 时必须转成文件系统路径再交给 spawn', async () => {
  // 回归测试：曾经把 URL 直接交给 spawn，PowerShell 收到 file:///… 后立刻退出
  // （「不支持给定路径的格式」）。单元测试当时因为用字符串路径而漏掉了这个 bug，
  // 端到端测试才抓到——这里把它钉死。
  const seen = []
  const bridge = new NativeBridge({
    scriptPath: new URL('file:///E:/plugin/src/native/cua.ps1'),
    startupTimeoutMs: 200,
    spawnImpl: (executable, args) => {
      seen.push({ executable, args })
      const child = new FakeChild()
      queueMicrotask(() => child.emitLine({ id: null, ok: true, event: 'ready', data: {} }))
      return child
    },
  })
  await bridge.ensureStarted()
  assert.equal(seen.length, 1)
  const fileArg = seen[0].args.at(-1)
  assert.equal(fileArg, 'E:\\plugin\\src\\native\\cua.ps1')
  assert.doesNotMatch(fileArg, /^file:/u)
  assert.equal(seen[0].executable, 'powershell.exe')
  assert.deepEqual(seen[0].args.slice(0, 6), [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    fileArg,
  ])
  await bridge.dispose()
})

test('spawn 抛错 → BridgeUnavailableError，probe 报告不可用而不抛', async () => {
  const bridge = new NativeBridge({
    scriptPath: 'C:\\plugin\\src\\native\\cua.ps1',
    spawnImpl: () => {
      throw new Error('spawn powershell.exe ENOENT')
    },
  })
  await assert.rejects(bridge.ensureStarted(), (error) => {
    assert.ok(error instanceof BridgeUnavailableError)
    assert.match(error.message, /ENOENT/u)
    return true
  })
  const probe = await bridge.probe()
  assert.equal(probe.ok, false)
  assert.match(probe.reason, /ENOENT/u)
  await bridge.dispose()
})

test('后端退出 → 在飞请求被拒绝，且重启计数生效', async () => {
  const { bridge, children, child } = makeBridge({ maxRestarts: 1 })
  const started = bridge.ensureStarted()
  await tick()
  child().emitLine({ id: null, ok: true, event: 'ready', data: {} })
  await started

  const pending = bridge.call('ping', {})
  await tick()
  child().emit('exit', 3, null)
  await assert.rejects(pending, (error) => error instanceof BridgeUnavailableError && /exited/u.test(error.message))

  // 第二次启动允许；第三次（超过 maxRestarts=1）拒绝。
  const second = bridge.ensureStarted()
  await tick()
  child().emitLine({ id: null, ok: true, event: 'ready', data: {} })
  await second
  child().emit('exit', 4, null)
  await tick()
  await assert.rejects(bridge.ensureStarted(), (error) => {
    assert.ok(error instanceof BridgeUnavailableError)
    assert.match(error.message, /will not be restarted/u)
    return true
  })
  assert.equal(children.length, 2)
})
