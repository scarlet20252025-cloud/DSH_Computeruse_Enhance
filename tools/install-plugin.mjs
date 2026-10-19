#!/usr/bin/env node
/**
 * 把本插件装进 DSH profile（默认 dry-run，必须显式 `--apply`）。
 *
 * 做三件事，每件都可回滚：
 *   1. 备份 profile 的 package.json 为 `<name>.bak-dsh-computer-use`；
 *   2. 在 dependencies 里加 `"dsh-computer-use": "link:<本目录>"`；
 *   3. 在 dsh.profile.bundles 里加 `"dsh-computer-use"`（只有列进 bundles，
 *      本插件的 cordis.patch.yml 才会被应用，宿主端入口才会挂上）。
 * 然后可选跑 `pnpm install`（`--install`），最后提示重启 DSH。
 *
 * 为什么默认不装：改 profile 会影响 DSH 启动；插件加载失败时用户会失去可用的 DSH。
 * 因此默认只打印将要发生的改动，装的时候留下备份并给出一行回滚命令。
 *
 * 用法：
 *   node tools/install-plugin.mjs                 # 预览
 *   node tools/install-plugin.mjs --apply         # 改 profile（不跑 pnpm）
 *   node tools/install-plugin.mjs --apply --install
 *   node tools/install-plugin.mjs --rollback      # 从备份恢复
 */
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)))
const args = new Set(process.argv.slice(2))
const apply = args.has('--apply')
const rollback = args.has('--rollback')
const runInstall = args.has('--install')

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
const profileName = process.env.DSH_PROFILE ?? 'desktop'
const profileDir = join(dshHome, 'profiles', profileName)
const manifestPath = join(profileDir, 'package.json')
const backupPath = join(profileDir, 'package.json.bak-dsh-computer-use')

const PLUGIN_NAME = 'dsh-computer-use'
// pnpm 的 link: 依赖要用正斜杠路径，Windows 盘符同样写 E:/…
const linkSpec = `link:${pluginDir.replace(/\\/gu, '/')}`

function report(action, detail) {
  console.log(`${apply || rollback ? '[apply]' : '[dry-run]'} ${action}: ${detail}`)
}

async function run(command, commandArgs, cwd) {
  await new Promise((resolve, reject) => {
    // Node ≥18.20 出于安全不再允许直接 spawn `.cmd`/`.bat`（会 EINVAL），
    // 而 pnpm 在 Windows 上正是以 `pnpm.CMD` 垫片存在的 → 这种目标必须过 shell。
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/iu.test(command)
    const child = spawn(command, commandArgs, { cwd, stdio: 'inherit', shell: needsShell })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`${command} exited with ${code}`))))
  })
}

/**
 * 找到可用的 pnpm。
 *
 * 为什么要找：`spawn('pnpm')` 在 Windows 上会 ENOENT —— pnpm 是以 `pnpm.ps1`/`pnpm.CMD`
 * 垫片存在的，不在 PATH 的可执行搜索范围内（本机是 `E:\NodeJS\pnpm.CMD`）。
 * 顺序：显式环境变量 → node 同目录的垫片 → `where` 查询 → 退回裸名字 + shell。
 */
async function resolvePnpm() {
  const candidates = []
  if (typeof process.env.DSH_PNPM === 'string' && process.env.DSH_PNPM.trim() !== '') {
    candidates.push(process.env.DSH_PNPM.trim())
  }
  const nodeDir = dirname(process.execPath)
  candidates.push(join(nodeDir, 'pnpm.CMD'), join(nodeDir, 'pnpm.cmd'), join(nodeDir, 'pnpm'))
  const fromPath = await new Promise((resolve) => {
    const probe = spawn('where', ['pnpm'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    probe.stdout.on('data', (chunk) => {
      out += String(chunk)
    })
    probe.on('error', () => resolve(undefined))
    probe.on('exit', () => {
      const first = out.split(/\r?\n/u).map((line) => line.trim()).find((line) => line !== '')
      resolve(first)
    })
  })
  if (fromPath !== undefined) candidates.push(fromPath)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

if (!existsSync(manifestPath)) {
  console.error(`profile manifest not found: ${manifestPath}`)
  console.error('set DSH_HOME / DSH_PROFILE, or install from the DSH plugin page instead.')
  process.exit(2)
}

const raw = await readFile(manifestPath, 'utf8')
const manifest = JSON.parse(raw.replace(/^\uFEFF/u, ''))

if (rollback) {
  if (!existsSync(backupPath)) {
    console.error(`no backup at ${backupPath}; nothing to roll back`)
    process.exit(2)
  }
  await copyFile(backupPath, manifestPath)
  report('restored', manifestPath)
  console.log('restart DSH to drop the plugin.')
  process.exit(0)
}

const dependencies = { ...(manifest.dependencies ?? {}) }
const bundles = [...(manifest.dsh?.profile?.bundles ?? [])]
const needDependency = dependencies[PLUGIN_NAME] !== linkSpec
const needBundle = !bundles.includes(PLUGIN_NAME)

console.log(`plugin dir : ${pluginDir}`)
console.log(`profile    : ${profileDir}`)
console.log(`dependency : ${dependencies[PLUGIN_NAME] ?? '(missing)'} -> ${linkSpec}`)
console.log(`bundles    : ${needBundle ? 'append ' + PLUGIN_NAME : 'already listed'}`)
console.log('')

if (!needDependency && !needBundle && !runInstall) {
  console.log('already installed; nothing to change.')
  process.exit(0)
}

if (!apply) {
  report('would back up', `${manifestPath} -> ${backupPath}`)
  report('would set dependency', `${PLUGIN_NAME}: ${linkSpec}`)
  if (needBundle) report('would append bundle', PLUGIN_NAME)
  if (runInstall) report('would run', `pnpm install (cwd ${profileDir})`)
  console.log('\nre-run with --apply (and optionally --install) to perform these changes.')
  process.exit(0)
}

if (!existsSync(backupPath)) {
  await copyFile(manifestPath, backupPath)
  report('backed up', backupPath)
} else {
  report('backup exists (kept)', backupPath)
}

dependencies[PLUGIN_NAME] = linkSpec
manifest.dependencies = dependencies
manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles } }
if (needBundle) manifest.dsh.profile.bundles.push(PLUGIN_NAME)
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
report('wrote', manifestPath)

if (runInstall) {
  const pnpm = await resolvePnpm()
  if (pnpm === undefined) {
    console.error('cannot find pnpm (set DSH_PNPM=<path to pnpm.CMD> and retry)')
    console.error(`restore the profile with: node ${fileURLToPath(import.meta.url)} --rollback`)
    process.exit(1)
  }
  report('running', `${pnpm} install (cwd ${profileDir})`)
  try {
    await run(pnpm, ['install'], profileDir)
    report('installed', 'pnpm install finished')
  } catch (error) {
    console.error(`pnpm install failed: ${error instanceof Error ? error.message : String(error)}`)
    console.error(`restore the profile with: node ${fileURLToPath(import.meta.url)} --rollback`)
    process.exit(1)
  }
}

console.log('\nnext steps:')
console.log('  1. restart DSH (the loader reads the profile at boot)')
console.log('  2. in a session, ask the model to call `request_access`')
console.log(`rollback: node ${fileURLToPath(import.meta.url)} --rollback   (then restart DSH)`)
