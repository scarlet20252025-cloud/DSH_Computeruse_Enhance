#!/usr/bin/env node
/**
 * 指示器接口对齐探针：用**生产的 `OperationIndicator` 控制器**直连真实的
 * `src/native/indicator.ps1`，确认两侧对 `docs/indicator-protocol.md` 的理解一致。
 *
 * 与 `tools/indicator-smoke.mjs` 的分工：
 *   - smoke 测脚本本身（含点击穿透 / 不抢焦点 / 不进截图三条硬性质）；
 *   - 本探针测「Node 控制器发的东西，脚本真的照做了」，并打印脚本回报的全部事实。
 *
 * 用法：node tools/probe-indicator.mjs
 */
import { fileURLToPath } from 'node:url'

import { OperationIndicator } from '../src/indicator.js'

const indicator = new OperationIndicator({
  scriptPath: fileURLToPath(new URL('../src/native/indicator.ps1', import.meta.url)),
  locale: 'zh-CN',
  showAction: true,
  autoHideMs: 60000,
  log: {
    info: (message) => console.log(`  [info] ${message}`),
    warn: (message) => console.log(`  [warn] ${message}`),
  },
})

let pass = 0
let fail = 0
const check = (label, ok, detail) => {
  const shown = detail === undefined ? '' : `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  if (ok) {
    pass += 1
    console.log(`  PASS  ${label}${shown}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${label}${shown}`)
  }
}

try {
  console.log('=== 预热（插件加载时的真实路径） ===')
  await indicator.warmUp()
  const warmed = await indicator.status()
  check('控制器可用', warmed.available !== false && warmed.pong === true, warmed)

  console.log('\n=== show：动作开始前亮起 ===')
  indicator.note('left_click')
  let status
  const deadline = Date.now() + 8000
  for (;;) {
    status = await indicator.status()
    if (status.visible === true || Date.now() > deadline) break
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  check('脚本报告 visible === true', status.visible === true, status.visible)
  check('是最前端', status.topmost === true, status.topmost)
  check('点击穿透', status.clickThrough === true, status.clickThrough)
  check('不抢焦点', status.noActivate === true, status.noActivate)
  check('不进截图', status.excludedFromCapture === true, { affinity: status.affinity })
  check('窗口有正尺寸', Number(status.width) > 0 && Number(status.height) >= 38, `${status.width}x${status.height}`)
  // 结构性断言：上游卡片 38px 高 + 上下留白 6/12 = 56；多出来的部分是 WPF
  // `DropShadowEffect` 的 effect padding（阴影要地方画）。**不能用截图核对卡片外观**——
  // 浮窗被故意排除出截图捕获（excludedFromCapture=true），这正是它该有的性质。
  const height = Number(status.height)
  check(
    '窗口高度 = 卡片(38) + 留白(18) + 阴影余量(≤40)',
    height >= 56 && height <= 96,
    { height, 期望: '56..96' },
  )
  check('位于屏幕顶部（y 很小）', Number(status.y) >= 0 && Number(status.y) < 60, { x: status.x, y: status.y })
  check('hwnd 是 0x 形式', /^0x[0-9a-f]+$/u.test(String(status.hwnd)), status.hwnd)
  check('文案带当前动作', /点击/u.test(String(status.text)), status.text)
  console.log(`  完整事实: ${JSON.stringify(status)}`)

  console.log('\n=== update：换动作只改文案，不重新闪一次 ===')
  const widthBefore = Number(status.width)
  indicator.note('get_app_state')
  await new Promise((resolve) => setTimeout(resolve, 400))
  const updated = await indicator.status()
  check('文案已更新', /读取界面/u.test(String(updated.text)), updated.text)
  check('仍然可见', updated.visible === true, updated.visible)
  check('宽度随文案自适应（可能变化但不为 0）', Number(updated.width) > 0, { before: widthBefore, after: updated.width })

  console.log('\n=== hide：控制权交还后立即收起 ===')
  await indicator.hide()
  const hidden = await indicator.status()
  check('脚本报告 visible === false', hidden.visible === false, hidden.visible)
  check('隐藏后进程仍可用（可复用）', hidden.pong === true, hidden.pong)

  console.log('\n=== show 复现：隐藏后仍能再次亮起且保持最前端 ===')
  indicator.note('type')
  const deadline2 = Date.now() + 8000
  let again
  for (;;) {
    again = await indicator.status()
    if (again.visible === true || Date.now() > deadline2) break
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  check('再次可见', again.visible === true, again.visible)
  check('再次显示后仍是最前端', again.topmost === true, again.topmost)
} catch (error) {
  fail += 1
  console.log(`  FAIL  uncaught: ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`)
} finally {
  console.log('\n=== dispose ===')
  await indicator.dispose()
  console.log(`\n${'='.repeat(72)}\nPASS ${pass}   FAIL ${fail}\n${'='.repeat(72)}`)
  process.exitCode = fail === 0 ? 0 : 1
}
