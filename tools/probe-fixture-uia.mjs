#!/usr/bin/env node
/** 一次性排查：夹具窗口到底暴露了哪些 UIA 元素。 */
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
try {
  await bridge.ensureStarted()
  const state = await bridge.call('get_app_state', { pid }, { timeoutMs: 30000 })
  console.log(`pid=${pid} app=${JSON.stringify(state.app)} window=${state.window?.title}`)
  console.log(state.text)
} finally {
  await bridge.dispose()
  spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
}
