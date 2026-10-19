#!/usr/bin/env node
/**
 * 性能基准：走**真实 NDJSON 协议**测各方法的端到端延迟。
 *
 * 为什么不用 tools/e2e.mjs 或 test/*.test.mjs：
 *   - test/* 用注入的 spawnImpl 假后端，测的是 JS 层逻辑，不含 PowerShell 与 UIA；
 *   - e2e.mjs 测正确性（一跑几分钟、要拉夹具窗口），不适合反复调优时的高频对比。
 *   本文件只做一件事：给同一批调用计时，让人能看见「改了之后到底快了多少」。
 *
 * 用法：
 *   node tools/bench.mjs                      # 默认 Firefox / 120 元素
 *   node tools/bench.mjs --app=notepad        # 指定 appKey
 *   node tools/bench.mjs --repeat=5           # 每档重复次数（取最小值，默认 3）
 *   node tools/bench.mjs --json               # 机器可读输出（用于前后对比）
 *
 * 输出里的 **first** 一行是「进程刚就绪后的第一次 get_app_state」，
 * 它包含一次性成本（UIA 连接、JIT），是用户真正感知到的「第一次让我看看屏幕」。
 *
 * 注意：脚本会启动并关闭自然后端进程，不会向桌面注入任何输入。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const scriptPath = path.join(repoRoot, 'src', 'native', 'cua.ps1')

const argv = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? 'true']
  }),
)
const appKey = argv.get('app') ?? 'firefox'
const repeat = Number(argv.get('repeat') ?? 3)
const asJson = argv.get('json') === 'true'
const timeoutMs = Number(process.env.CUA_BENCH_TIMEOUT_MS ?? 60000)

if (!existsSync(scriptPath)) {
  console.error('native script not found: ' + scriptPath)
  process.exit(1)
}

const results = []
const note = (label, ms, extra) => {
  results.push({ label, ms, ...(extra ?? {}) })
  if (!asJson) console.log(label.padEnd(34) + String(ms).padStart(6) + ' ms' + (extra ? '  ' + JSON.stringify(extra) : ''))
}

const child = spawn(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
  { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
)
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')

let buffer = ''
const pending = new Map()
let idCounter = 0
let readyAt = 0
const startedAt = Date.now()
const stderrLines = []

child.stderr.on('data', (chunk) => {
  for (const line of chunk.split('\n')) if (line.trim() !== '') stderrLines.push(line.trim())
})

const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('backend did not report ready in 30s')), 30000)
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (line.trim() === '') continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.event === 'ready') {
        readyAt = Date.now()
        clearTimeout(timer)
        resolve(msg.data)
        continue
      }
      const entry = pending.get(msg.id)
      if (!entry) continue
      pending.delete(msg.id)
      entry.resolve(msg)
    }
  })
})

function call(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    const id = 'b' + (idCounter += 1)
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(cmd + ' timed out'))
    }, timeoutMs)
    pending.set(id, {
      resolve: (msg) => {
        clearTimeout(timer)
        resolve(msg)
      },
    })
    child.stdin.write(JSON.stringify({ id, cmd, args }) + '\n')
  })
}

async function timed(label, cmd, args) {
  const t0 = Date.now()
  const msg = await call(cmd, args)
  const ms = Date.now() - t0
  if (msg.ok !== true) throw new Error(label + ' failed: ' + JSON.stringify(msg.error))
  return { ms, data: msg.data }
}

async function best(label, cmd, args, n = repeat) {
  let bestMs = Infinity
  let last = null
  for (let i = 0; i < n; i += 1) {
    const r = await timed(label, cmd, args)
    if (r.ms < bestMs) bestMs = r.ms
    last = r.data
  }
  note(label, bestMs)
  return last
}

const shutdown = async () => {
  try {
    await call('shutdown', {})
  } catch {
    /* 已经退出 */
  }
  setTimeout(() => {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  }, 200)
}

try {
  const info = await ready
  if (!asJson) {
    console.log('ready in ' + (readyAt - startedAt) + ' ms  (ps=' + info.psVersion + ', dpiAware=' + info.dpiAware + ')')
    console.log('---')
    note('cold ping (process ready)', readyAt - startedAt)
  } else {
    note('cold ping (process ready)', readyAt - startedAt)
  }

  await timed('ping', 'ping', {})
  note('ping (warm)', await timed('ping', 'ping', {}).then((r) => r.ms))

  // 第一次 get_app_state：包含 UIA 连接与 JIT，是用户的「第一次」体验
  const first = await timed('first get_app_state', 'get_app_state', { appKey, max_elements: 120, max_depth: 8 })
  note('first get_app_state 120/8', first.ms, { n: first.data?.elementCount })
  const warm = await timed('get_app_state', 'get_app_state', { appKey, max_elements: 120, max_depth: 8 })
  note('get_app_state 120/8 (warm)', warm.ms, { n: warm.data?.elementCount })

  for (const [els, depth] of [[25, 8], [100, 8], [200, 16], [400, 16]]) {
    const d = await best('get_app_state ' + els + '/' + depth, 'get_app_state', { appKey, max_elements: els, max_depth: depth })
    if (!asJson) results[results.length - 1].n = d?.elementCount
  }

  await best('list_windows (all)', 'list_windows', {})
  await best('list_apps', 'list_apps', {})
  await best('screenshot jpeg q60', 'screenshot', { format: 'jpeg', quality: 60 })
  await best('zoom 600x300 @2x jpeg', 'zoom', { left: 100, top: 100, width: 600, height: 300, scale: 2, format: 'jpeg', quality: 60 })

  if (asJson) {
    console.log(JSON.stringify({ appKey, repeat, results, stderr: stderrLines.slice(-10) }, null, 2))
  } else if (stderrLines.length > 0) {
    console.log('---')
    console.log('stderr: ' + stderrLines.slice(-5).join(' | '))
  }
} catch (error) {
  console.error('bench failed: ' + (error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
} finally {
  await shutdown()
}
