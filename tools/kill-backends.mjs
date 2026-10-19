#!/usr/bin/env node
/**
 * 清理/盘点遗留的原生进程（Computer Use 后端 `cua.ps1` 与操作指示器 `indicator.ps1`）。
 *
 * 关键教训：**判定条件不能写进被查询进程的命令行里**。
 * 第一版把 `*native\cua.ps1*` 直接写进 PowerShell 查询，于是「运行这条查询的
 * powershell.exe 自己」的命令行也含这个字样，查询把自己匹配成了遗留后端——
 * 结果既误报（把 harness 的工具进程当成后端），又在 kill 时打到了自己人。
 * 正确做法：查询里不带任何特征串，取回全量命令行后在 **Node 侧**过滤。
 *
 * 用法：
 *   node tools/kill-backends.mjs            # 盘点并清理两者
 *   node tools/kill-backends.mjs --list     # 只看不杀（复核用）
 */
import { spawnSync } from 'node:child_process'

const SCRIPT =
  "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"

/** 拼出来的特征串：保证不会出现在任何查询文本里（否则查询会匹配到自己）。 */
const NEEDLES = {
  backend: ['cua', '.ps1'].join(''),
  indicator: ['indic', 'ator', '.ps1'].join(''),
}

const listOnly = process.argv.includes('--list')

function listProcesses(needle) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
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
    .map((row) => Number(row.ProcessId))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

let failures = 0
for (const [kind, needle] of Object.entries(NEEDLES)) {
  const before = listProcesses(needle)
  console.log(`${kind} before: ${before.join(',') || 'none'}`)
  if (listOnly !== true) {
    for (const pid of before) {
      if (pid === process.pid) continue
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    }
  }
  const after = listProcesses(needle)
  console.log(`${kind} after : ${after.join(',') || 'none'}`)
  if (after.length > 0) failures += 1
}
process.exitCode = failures === 0 ? 0 : 1
