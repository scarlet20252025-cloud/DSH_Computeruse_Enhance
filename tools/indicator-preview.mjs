#!/usr/bin/env node
/**
 * 生成指示器预览图（给 README 用）。
 *
 * 这件事有个反讽：生产浮窗**故意**被排除出截图捕获
 * （`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`，否则模型每张截图都被它污染），
 * 所以**没有任何办法**用普通截图展示生产浮窗的真实样子。
 *
 * 解法：让 `indicator.ps1` 支持一个只给文档/调试用的开关
 * `DSH_CUA_INDICATOR_CAPTURABLE=1`——同一份代码、同一套视觉规格，只是不设 capture affinity。
 * 于是这张预览是**真实生产窗口**的图像，不是另画一张示意图。
 *
 * 抓图方式：`PrintWindow`（tools/capture-window.ps1）——只取窗口自身像素。
 * 不用 GDI 区域截图：那会把窗口**下面**的桌面一起拍进来（实测拍到过用户正在玩的游戏 HUD），
 * 既不整洁，也不该把用户屏幕内容写进仓库。
 *
 * 用法：
 *   node tools/indicator-preview.mjs                                  # docs/indicator-preview.png
 *   node tools/indicator-preview.mjs --dark --out=docs/xxx.png --text="..."
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { OperationIndicator } from '../src/indicator.js'

const args = new Map(
  process.argv.slice(2).map((value) => {
    const [key, ...rest] = value.replace(/^--/u, '').split('=')
    return [key, rest.join('=') || 'true']
  }),
)

const dark = args.get('dark') === 'true' || args.get('theme') === 'dark'
const outPath = args.get('out') ?? fileURLToPath(new URL(`../docs/indicator-preview${dark ? '-dark' : ''}.png`, import.meta.url))
const text = args.get('text') ?? (dark ? 'DSH 正在操作电脑 · 读取界面' : 'DSH 正在操作电脑 · 点击')
const backdrop = args.get('backdrop') ?? (dark ? '#20242A' : '#F4F5F7')

// 两个只给文档/调试用的开关；生产路径永远不会设它们。
process.env.DSH_CUA_INDICATOR_CAPTURABLE = '1'
if (dark) process.env.DSH_CUA_INDICATOR_THEME = 'dark'

const indicator = new OperationIndicator({
  scriptPath: fileURLToPath(new URL('../src/native/indicator.ps1', import.meta.url)),
  locale: 'zh-CN',
  showAction: true,
  autoHideMs: 60000,
  log: { info: () => {}, warn: (message) => console.log(`  [indicator] ${message}`) },
})

try {
  await indicator.warmUp()
  await indicator.showText(text)
  const shown = await indicator.status()
  if (shown?.visible !== true) throw new Error(`indicator is not visible: ${JSON.stringify(shown)}`)
  if (shown.excludedFromCapture !== false) {
    console.log('  warning: capturable mode did not take effect; the preview may be blank')
  }
  console.log(`  window rect: ${shown.x},${shown.y} ${shown.width}x${shown.height} (${shown.text})`)

  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      fileURLToPath(new URL('./capture-window.ps1', import.meta.url)),
      '-Hwnd',
      String(shown.hwnd),
      '-Out',
      outPath,
      '-Backdrop',
      backdrop,
    ],
    { encoding: 'utf8' },
  )
  const stdout = (result.stdout ?? '').trim()
  if (stdout !== '') console.log(`  ${stdout}`)
  if (result.status !== 0) {
    console.error(`  capture failed (exit ${result.status}): ${(result.stderr ?? '').trim()}`)
    process.exitCode = 1
  } else {
    console.log(`  preview written: ${outPath} (backdrop ${backdrop})`)
  }
} finally {
  delete process.env.DSH_CUA_INDICATOR_CAPTURABLE
  delete process.env.DSH_CUA_INDICATOR_THEME
  await indicator.dispose()
}
