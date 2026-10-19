#!/usr/bin/env node
/**
 * 最强验证：在**真实的 cordis 运行时 + 真实的 `@deepseek-ai/dsh-tools` 注册表**里加载本插件，
 * 看模型实际会收到什么工具 schema。
 *
 * 这条路径不经过 DSH 应用本身（那需要重启用户的 DSH），但用的是 DSH 自己的注册表实现：
 * 注册准入（`ctx.tools.register` 的校验）、schema 投影（`ctx.tools.schemas()`）、
 * 作用域与限制（`ctx.tools.restrict`）都是真码。
 *
 * 依赖 `.ref/dsh`（由 `node tools/ref-extract-validator.mjs` 从 app.asar 提取）。
 * 用法：node tools/verify-real-registry.mjs
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const refDir = new URL('../.ref/dsh/', import.meta.url)
const refRoot = decodeURIComponent(refDir.pathname.replace(/^\//u, ''))

if (!existsSync(join(refRoot, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))) {
  console.error('missing .ref/dsh — run `node tools/ref-extract-validator.mjs` first')
  process.exit(2)
}

const require = createRequire(join(refRoot, 'index.js'))
const load = async (specifier) => await import(pathToFileURL(require.resolve(specifier)).href)

const { Context } = await load('@deepseek-ai/cordis')
const toolsModule = await load('@deepseek-ai/dsh-tools')
const ToolRuntime = toolsModule.default

const home = await mkdtemp(join(tmpdir(), 'dsh-cu-registry-'))
process.env.DSH_HOME = home
const { resetHomeCacheForTesting } = await import('../src/config.js')
resetHomeCacheForTesting()
const plugin = await import('../src/index.js')

let pass = 0
let fail = 0
const check = (label, ok, detail) => {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${label}${detail === undefined ? '' : `  -> ${detail}`}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : `  -> ${detail}`}`)
  }
}

const ctx = new Context()
// ToolRuntime 声明 `static inject = ["systemPrompt"]`，缺这个服务它会被 cordis 挂起
// （表现为 `ctx.get('tools') === undefined`，不是报错），所以必须先挂 SystemPrompt。
const SystemPrompt = (await load('@deepseek-ai/dsh-system-prompt')).default
await ctx.plugin(SystemPrompt, {})
await ctx.plugin(ToolRuntime, {})
await new Promise((resolve) => setTimeout(resolve, 0))
check('真实 SystemPrompt 已挂载', ctx.get('systemPrompt') !== undefined, typeof ctx.get('systemPrompt')?.section)
check('真实 ToolRuntime 已挂载', ctx.get('tools') !== undefined, typeof ctx.get('tools')?.register)

// indicator: false —— 本验证只关心「真实注册表里能不能挂上、schema 投影对不对」，
// 不需要在屏幕上弹一个浮窗（那是 e2e / indicator:smoke 的事）。
await ctx.plugin(plugin, { tools: 'native', warmup: false, installSkill: true, indicator: false })

const schemas = ctx.tools.schemas()
check('注册表向模型投影出 25 个工具', schemas.length === 25, schemas.length)
check(
  '工具名与上游一致（集合）',
  ['get_app_state', 'left_click', 'screenshot', 'stop_computer_control'].every((name) =>
    schemas.some((schema) => schema.name === name),
  ),
  schemas.map((schema) => schema.name).join(','),
)

const screenshot = schemas.find((schema) => schema.name === 'screenshot')
check('screenshot schema 是对象根', screenshot.parameters.type === 'object', screenshot.parameters.type)
check(
  'screenshot schema 只暴露给模型参数（无 execute/render 泄漏）',
  Object.keys(screenshot).sort().join(',') === 'description,name,parameters',
  Object.keys(screenshot).join(','),
)
check(
  'screenshot schema 带上了参数的 description',
  screenshot.parameters.properties.max_width?.description !== undefined,
  screenshot.parameters.properties.max_width,
)

// 真实注册表的解析语义（作用域限制需要 agent 作用域，这里不越界使用）。
const resolved = ctx.tools.get('screenshot')
check('注册表能按名字解析到工具', resolved?.name === 'screenshot', resolved?.name)
check('未注册的名字解析为空', ctx.tools.get('not_a_tool') === undefined, String(ctx.tools.get('not_a_tool')))
check(
  '每个工具都声明了 description（模型靠它选工具）',
  schemas.every((schema) => typeof schema.description === 'string' && schema.description.length > 40),
  schemas.filter((schema) => (schema.description ?? '').length <= 40).map((schema) => schema.name),
)

console.log(`\n${'='.repeat(72)}`)
console.log(`PASS ${pass}   FAIL ${fail}`)
console.log('='.repeat(72))
process.exitCode = fail === 0 ? 0 : 1
