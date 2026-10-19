#!/usr/bin/env node
/**
 * 一次性调用原生后端（NDJSON 协议），用于**临时排查**。
 *
 * 存在的理由：调这个插件时最常见的浪费是「为了看一眼返回，又写一个 tmp-*.cjs 驱动」。
 * 每个临时驱动都要重复实现 spawn / 逐行解析 / 等待 id 匹配，写完还要记得删。
 * 这个文件把那段样板固定下来，改参数就能用。
 *
 * 用法：
 *   node tools/call.mjs list_apps
 *   node tools/call.mjs list_windows --title=Firefox
 *   node tools/call.mjs get_app_state --app=firefox --els=30 --depth=6
 *   node tools/call.mjs get_app_state --appKey=firefox --maxElements=30 --maxDepth=6   # 原名照抄也行
 *   node tools/call.mjs screenshot --format=jpeg --quality=60 --out=.probe/shot.jpg
 *   node tools/call.mjs zoom --left=100 --top=100 --width=600 --height=300 --scale=2 --out=.probe/zoom.jpg
 *   node tools/call.mjs ping + screen_info        # 「+」分隔可连续调多条，共用同一个后端进程
 *
 * 参数规则：
 *   - 第一个非 flag 词是命令名；
 *   - 其余 `--k=v` 原样进入 args：先查别名表（--app/--els/--depth/--window/--target），
 *     查不到才把驼峰转下划线（--maxElements -> max_elements）。原生名是 camel/snake 混排的，
 *     只做驼峰转换会把 --appKey 变成 app_key 而被后端拒绝；
 *   - 数字/布尔自动转型（"120" -> 120，"true" -> true），其余当字符串；
 *   - `--out=<path>` 是客户端行为：把返回里的 data.image（base64）写成文件，不发给后端。
 *
 * 输出：stdout 打印完整 JSON 响应（含 ok/error），stderr 打印每条耗时。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const scriptPath = path.join(repoRoot, 'src', 'native', 'cua.ps1')
const timeoutMs = Number(process.env.CUA_CALL_TIMEOUT_MS ?? 60000)

const argv = process.argv.slice(2)
if (argv.length === 0) {
  console.error('usage: node tools/call.mjs <cmd> [--k=v ...] [ + <cmd> ... ]')
  process.exit(2)
}

/**
 * 参数名归一化。原生协议里的名字是混合风格：大部分是 snake_case（max_elements），
 * 但选择器那个是 camelCase（appKey）。只做"驼峰转下划线"会把 --appKey 变成 app_key 而被拒，
 * 所以这里先查别名表，再退回驼峰转下划线。
 */
const KEY_ALIASES = new Map([
  ['app', 'appKey'],
  ['appkey', 'appKey'],
  ['hwnd', 'hwnd'],
  ['pid', 'pid'],
  ['title', 'title'],
  ['window', 'window_index'],
  ['windowindex', 'window_index'],
  ['els', 'max_elements'],
  ['maxelements', 'max_elements'],
  ['depth', 'max_depth'],
  ['maxdepth', 'max_depth'],
  ['timeoutms', 'timeout_ms'],
  ['target', 'target_hwnd'],
  ['targethwnd', 'target_hwnd'],
])

function normalizeKey(rawKey) {
  const flat = rawKey.replace(/_/g, '').toLowerCase()
  const alias = KEY_ALIASES.get(flat)
  if (alias) return alias
  // 没有别名就按驼峰拆：maxWidth -> max_width。已经是 snake 的名字拆完不变。
  return rawKey.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
}

/** 把 "get_app_state --app=x + ping" 切成 [{cmd,args}]。 */
const groups = [[]]
for (const token of argv) {
  if (token === '+') groups.push([])
  else groups[groups.length - 1].push(token)
}

const calls = groups.map((group) => {
  const cmd = group.find((t) => !t.startsWith('--'))
  const args = {}
  let out = null
  for (const token of group.filter((t) => t.startsWith('--'))) {
    const body = token.slice(2)
    const eq = body.indexOf('=')
    const rawKey = eq < 0 ? body : body.slice(0, eq)
    const rawValue = eq < 0 ? 'true' : body.slice(eq + 1)
    const key = normalizeKey(rawKey)
    if (key === 'out') {
      out = rawValue
      continue
    }
    if (rawValue === 'true' || rawValue === 'false') args[key] = rawValue === 'true'
    else if (rawValue !== '' && !Number.isNaN(Number(rawValue))) args[key] = Number(rawValue)
    else args[key] = rawValue
  }
  return { cmd, args, out }
})

if (calls.some((c) => !c.cmd)) {
  console.error('every group needs a command name')
  process.exit(2)
}

if (!existsSync(scriptPath)) {
  console.error('native script not found: ' + scriptPath)
  process.exit(1)
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
let printedDiagnostics = 0

child.stderr.on('data', (chunk) => {
  for (const line of String(chunk).split('\n')) {
    const text = line.trim()
    if (text !== '') console.error('[backend] ' + text)
  }
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
        clearTimeout(timer)
        printedDiagnostics = 0
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

function call(cmd, args) {
  return new Promise((resolve, reject) => {
    const id = 'c' + (idCounter += 1)
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(cmd + ' timed out after ' + timeoutMs + 'ms'))
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

let exitCode = 0
try {
  const info = await ready
  console.error('[ready] ' + JSON.stringify(info))

  for (const item of calls) {
    const startedAt = Date.now()
    const msg = await call(item.cmd, item.args)
    const elapsed = Date.now() - startedAt
    console.error('[' + item.cmd + '] ' + elapsed + 'ms' + (msg.ok ? '' : ' (failed)'))

    // data.image 是对象 { base64, mediaType, width, height, bytes }，不是裸 base64 字符串。
    // 第一版按字符串处理，报 "The first argument must be of type string … Received an instance of Object"。
    const image = msg.ok && msg.data ? msg.data.image : null
    if (item.out && image && typeof image.base64 === 'string') {
      const target = path.resolve(repoRoot, item.out)
      mkdirSync(path.dirname(target), { recursive: true })
      const bytes = Buffer.from(image.base64, 'base64')
      writeFileSync(target, bytes)
      const copy = { ...msg.data, image: { ...image, base64: '<' + bytes.length + ' bytes -> ' + target + '>' } }
      console.log(JSON.stringify({ ...msg, data: copy }, null, 2))
    } else {
      console.log(JSON.stringify(msg, null, 2))
    }
    if (!msg.ok) exitCode = 1
  }
} catch (error) {
  console.error('failed: ' + (error instanceof Error ? error.message : String(error)))
  exitCode = 1
} finally {
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
    process.exit(exitCode)
  }, 150)
}
