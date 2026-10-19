#!/usr/bin/env node
/**
 * 开发工具（不属于插件运行时）：把 DSH 里 `@deepseek-ai/dsh-tools` 及其传递依赖
 * 从 app.asar 提取到 `.ref/dsh/node_modules/`，直到真实导入成功。
 *
 * 目的：测试里能用**官方实现**校验我们的工具 schema 与参数校验语义，
 * 而不是拿一份自己仿造的检查器自证。
 *
 * 用法：node tools/ref-extract-validator.mjs [--max-rounds=40]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { listAsarEntries } from './asar.mjs'
import { asarCandidates, asarPath } from '../test/helpers.mjs'

// 写死路径在换机器时会静默失效，所以统一走 test/helpers.mjs 的探测顺序。
const ASAR = asarPath()
if (ASAR === undefined) {
  console.error('找不到 app.asar（探测过：' + asarCandidates().join(', ') + '）')
  console.error('可用 DSH_ASAR=<path> 显式指定。')
  process.exit(1)
}
const REF_ROOT = new URL('../.ref/dsh/', import.meta.url)
const REF = decodeURIComponent(REF_ROOT.pathname.replace(/^\//u, ''))
const ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'

const maxRounds = Number(process.argv.find((a) => a.startsWith('--max-rounds='))?.slice(13) ?? 40)
const entries = listAsarEntries(ASAR)
const byPrefix = new Map()
for (const entry of entries) {
  const prefix = entry.path.split('/').slice(0, -1).join('/')
  byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1)
}

/** 把一个 asar 包目录提取到 .ref/dsh/node_modules 下的扁平布局。 */
function extractPackage(specifier) {
  const parts = specifier.split('/')
  const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
  const source = `dsh/node_modules/${name}`
  const target = join(REF, 'node_modules', ...name.split('/'))
  const files = entries.filter((e) => e.path.startsWith(`${source}/`) && !e.unpacked)
  if (files.length === 0) return false
  for (const file of files) {
    const rel = file.path.slice(source.length + 1)
    if (rel.split('/').includes('node_modules')) continue
    const dest = join(target, rel)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, file.buffer.subarray(file.dataStart + Number(file.offset), file.dataStart + Number(file.offset) + file.size))
  }
  return true
}

/** 用真实 entry 跑一次导入，返回缺失的模块名（或 null = 成功）。 */
async function tryImport() {
  const { spawnSync } = await import('node:child_process')
  const probe = `
try {
  const m = await import(${JSON.stringify(new URL('../.ref/dsh/dsh-tools/lib/index.js', import.meta.url).href)});
  process.stdout.write('OK ' + typeof m.assertSupportedJsonSchema + ' ' + typeof m.ToolRuntime);
} catch (error) {
  process.stdout.write('ERR ' + (error.message || String(error)).split('\\n')[0]);
}
`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' })
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (out.startsWith('OK')) return { ok: true, detail: out.slice(3) }
  const missing = /Cannot find package '([^']+)'/.exec(out)
  const missingModule = /Cannot find module '([^']+)'/.exec(out)
  return { ok: false, detail: out, missing: missing?.[1] ?? missingModule?.[1] }
}

let round = 0
// 先把要用的包本体放进扁平 layout（被测对象，不是依赖）。
//  - dsh-tools：工具 schema 子集断言与参数校验语义
//  - yaml / dsh-skill / dsh-skill-filesystem：技能 frontmatter 的真实解析器
//  - dsh-client-modules：客户端插件清单（`dsh.client`）的官方校验器
//  - dsh-subagent：官方 `delegationDepthOf`，用来核对我们判「子代理」的兜底字段没漂移
//  - dsh-session：会话 header 字段的运行时定义（`origin` / `delegationDepth`）
const SEED_PACKAGES = [
  '@deepseek-ai/dsh-tools',
  'yaml',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-session',
]
for (const specifier of SEED_PACKAGES) {
  if (extractPackage(specifier)) console.log(`extracted ${specifier}`)
  else {
    console.error(`cannot extract ${specifier} from the asar`)
    process.exit(1)
  }
}
for (; round < maxRounds; round += 1) {
  const result = await tryImport()
  if (result.ok) {
    console.log(`import ok after ${round} extraction round(s): ${result.detail}`)
    process.exit(0)
  }
  if (result.missing === undefined) {
    console.error('import failed without a resolvable missing module:')
    console.error(result.detail)
    process.exit(1)
  }
  if (!extractPackage(result.missing)) {
    console.error(`missing package is not extractable from the asar: ${result.missing}`)
    console.error(result.detail)
    process.exit(1)
  }
  console.log(`extracted ${result.missing}`)
}

console.error(`gave up after ${maxRounds} rounds`)
process.exit(1)
