#!/usr/bin/env node
/**
 * 诊断：用真实 bridge 驱动后端，观察「set_value / type 之后 get_app_state 还能不能读到 value」。
 * 复现端到端测试里 `elements[].value` 一直为 null 的现象，并打印每步完整状态树。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(new URL('./e2e-fixture.ps1', import.meta.url))
const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', fixture])
const pid = await new Promise((resolve, reject) => {
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk)
    const match = /FIXTURE_PID=(\d+)/u.exec(buffer)
    if (match) resolve(Number(match[1]))
  })
  child.on('exit', () => reject(new Error('fixture exited early')))
})

const { NativeBridge } = await import('../src/bridge.js')
const bridge = new NativeBridge({
  scriptPath: fileURLToPath(new URL('../src/native/cua.ps1', import.meta.url)),
  defaultTimeoutMs: 30000,
})

const dump = (label, state) => {
  console.log(`\n----- ${label} (state_id=${state.state_id}) -----`)
  console.log(state.text)
  const edit = state.elements.find((element) => element.name === 'FixtureInput')
  console.log(`edit element: ${JSON.stringify(edit)}`)
}

try {
  await bridge.ensureStarted()

  const s1 = await bridge.call('get_app_state', { pid }, { timeoutMs: 30000 })
  dump('第 1 次观察（未写入）', s1)

  const edit = s1.elements.find((element) => element.name === 'FixtureInput')
  const set = await bridge.call(
    'set_value',
    { element_index: edit.index, state_id: s1.state_id, value: 'probe-value-123' },
    { timeoutMs: 30000 },
  )
  console.log(`\nset_value -> ${JSON.stringify(set)}`)

  const s2 = await bridge.call('get_app_state', { pid }, { timeoutMs: 30000 })
  dump('set_value 之后观察', s2)

  const edit2 = s2.elements.find((element) => element.name === 'FixtureInput')
  const typed = await bridge.call(
    'type',
    { text: 'XYZ', element_index: edit2.index, state_id: s2.state_id },
    { timeoutMs: 30000 },
  )
  console.log(`\ntype -> ${JSON.stringify(typed)}`)

  const s3 = await bridge.call('get_app_state', { pid }, { timeoutMs: 30000 })
  dump('type 之后观察', s3)

  const edit3 = s3.elements.find((element) => element.name === 'FixtureInput')
  if (edit3 !== undefined) {
    const sel = await bridge.call(
      'select_text',
      { element_index: edit3.index, state_id: s3.state_id, all: true },
      { timeoutMs: 30000 },
    )
    console.log(`\nselect_text -> ${JSON.stringify(sel)}`)
  }
} finally {
  await bridge.dispose()
  spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
}
