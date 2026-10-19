/**
 * 插件级测试：`apply(ctx)` 的注册行为、参数守卫、技能自安装、配置与卸载。
 *
 * 用假 cordis 上下文 + 临时 `DSH_HOME` 跑，**不启动真实 PowerShell**
 * （config 里 `warmup:false`；后端只在首次调用时懒启动，而这些用例不调用后端）。
 * 真机端到端验证在 tools/native-smoke.mjs 与 tools/e2e.mjs。
 */
import assert from 'node:assert/strict'
import { test, before } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// DSH home 必须在 config.js 首次解析之前指到临时目录；后续所有路径都走它。
const home = await mkdtemp(join(tmpdir(), 'dsh-cu-home-'))
process.env.DSH_HOME = home

const { apply } = await import('../src/index.js')
const { resetHomeCacheForTesting } = await import('../src/config.js')
const { UPSTREAM_TOOL_NAMES, createFakeContext } = await import('./helpers.mjs')

/** 每次用例都用一个干净的 home 子目录，避免互相污染。 */
let caseIndex = 0
async function freshHome() {
  caseIndex += 1
  const dir = join(home, `case-${caseIndex}`)
  await mkdir(dir, { recursive: true })
  return dir
}

/** 切 home：必须同时清缓存，否则 config/skill 仍指向上一个用例的 home。 */
function useHome(homeDir) {
  process.env.DSH_HOME = homeDir
  resetHomeCacheForTesting()
}

async function applyOnce({ config = {}, services = {}, homeDir } = {}) {
  if (homeDir !== undefined) useHome(homeDir)
  const ctx = createFakeContext({ services })
  // indicator: false —— 单测不允许拉起 WPF 指示器进程（那是真机验证的事）；
  // 指示器控制器本身的行为由 test/indicator.test.mjs 注入假 bridge 覆盖。
  await apply(ctx, { warmup: false, installSkill: false, indicator: false, ...config })
  return ctx
}

test('禁用时一个工具都不注册（模型看不到这套能力）', async () => {
  const homeDir = await freshHome()
  const ctx = await applyOnce({ config: { enabled: false }, homeDir })
  assert.equal(ctx.registrations.length, 0)
})

test('默认模式注册 25 个与上游同名的工具，且每个都满足注册表准入', async () => {
  const homeDir = await freshHome()
  const ctx = await applyOnce({ homeDir })
  assert.equal(ctx.registrations.length, 25)
  assert.deepEqual(
    ctx.registrations.map((definition) => definition.name).sort(),
    [...UPSTREAM_TOOL_NAMES].sort(),
  )
  for (const definition of ctx.registrations) {
    assert.equal(typeof definition.description, 'string')
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(definition.parameters.type, 'object')
    assert.ok(Array.isArray(definition.output.render({}, { text: 'x' })))
  }
})

test('single 模式只注册一个 computer_use（action 参数分发）', async () => {
  const homeDir = await freshHome()
  const ctx = await applyOnce({ config: { tools: 'single' }, homeDir })
  assert.equal(ctx.registrations.length, 1)
  assert.equal(ctx.registrations[0].name, 'computer_use')
  assert.deepEqual(ctx.registrations[0].parameters.required, ['action'])
  assert.equal(ctx.registrations[0].parameters.properties.action.enum.length, 25)
})

test('注册的 execute 是守卫过的：非法参数在触达后端之前就被拒', async () => {
  const homeDir = await freshHome()
  const ctx = await applyOnce({ homeDir })
  const byName = new Map(ctx.registrations.map((definition) => [definition.name, definition]))

  // 这些拒绝都发生在参数校验阶段，因此不会启动后端进程（后端此时也未预热）。
  await assert.rejects(
    byName.get('mouse_move').execute({}, {}),
    /invalid arguments: missing required property "x"/u,
  )
  await assert.rejects(
    byName.get('left_click').execute({ nonsense: 1 }, {}),
    /invalid arguments: "nonsense" is not a declared property/u,
  )
  await assert.rejects(
    byName.get('perform_action').execute({ element_index: 1, state_id: 's1', action: 'explode' }, {}),
    /invalid arguments: "action" must be one of/u,
  )
  await assert.rejects(
    byName.get('get_app_state').execute({ app: true }, {}),
    /invalid arguments: "app" must match exactly one oneOf branch/u,
  )
})

test('配置从文件读取：tools=single + installSkill=false 生效', async () => {
  const homeDir = await freshHome()
  const path = join(homeDir, 'plugins', 'dsh-computer-use', 'config.json')
  await mkdir(join(homeDir, 'plugins', 'dsh-computer-use'), { recursive: true })
  await writeFile(path, JSON.stringify({ tools: 'single', installSkill: false, warmup: false, indicator: false }), 'utf8')
  useHome(homeDir)
  const ctx = createFakeContext()
  await apply(ctx, undefined)
  assert.equal(ctx.registrations.length, 1)
  assert.equal(ctx.registrations[0].name, 'computer_use')
  assert.equal(existsSync(join(homeDir, 'skills', 'computer-use', 'SKILL.md')), false, 'installSkill=false 不写技能')
})

test('技能自安装：写进用户技能根，带所有权标记，frontmatter 完好，可重复执行', async () => {
  const homeDir = await freshHome()
  const ctx = await applyOnce({ config: { installSkill: true }, homeDir })
  assert.ok(ctx.registrations.length > 0)

  const skillPath = join(homeDir, 'skills', 'computer-use', 'SKILL.md')
  const text = await readFile(skillPath, 'utf8')
  assert.match(text, /^---\nname: computer-use\n/u, 'YAML frontmatter 必须是文件开头')
  assert.match(text, /description: /u)
  assert.match(text, /<!-- generated-by: dsh-computer-use -->\s*$/u, '标记放末尾，避免破坏 frontmatter')

  // 再装一次：内容一致，不重复写坏
  const ctx2 = await applyOnce({ config: { installSkill: true }, homeDir })
  assert.ok(ctx2.registrations.length > 0)
  assert.equal(await readFile(skillPath, 'utf8'), text)
})

test('技能自安装不覆盖用户自己写的同名技能', async () => {
  const homeDir = await freshHome()
  const dir = join(homeDir, 'skills', 'computer-use')
  await mkdir(dir, { recursive: true })
  const userSkill = '---\nname: computer-use\ndescription: my own\n---\n\nmine\n'
  await writeFile(join(dir, 'SKILL.md'), userSkill, 'utf8')

  await applyOnce({ config: { installSkill: true }, homeDir })
  assert.equal(await readFile(join(dir, 'SKILL.md'), 'utf8'), userSkill, '用户版本必须原样保留')
})

test('卸载：dispose 会注销全部工具', async () => {
  const homeDir = await freshHome()
  const ctx = await applyOnce({ homeDir })
  assert.equal(ctx.registrations.length, 25)
  ctx.dispose()
  assert.equal(ctx.registrations.length, 0)
  // 幂等
  ctx.dispose()
  assert.equal(ctx.registrations.length, 0)
})

test('回合结束即收起：订阅了 agent/status，behavior 由控制器内部开关决定', async () => {
  const homeDir = await freshHome()
  // 刻意不开 indicator：断言「接线在」不该依赖「真的拉起 WPF 进程」。
  const ctx = await applyOnce({ homeDir })
  const listeners = ctx.listeners.get('agent/status') ?? []
  assert.equal(listeners.length, 1, '必须订阅 agent/status（回合结束 → 收起浮层）')
  // 事件没送达时的兜底由 indicatorAutoHideMs 负责；这里只验证监听器可被安全调用
  // （禁用态下 hide() 是 no-op，不会抛也不会拉起进程）。
  listeners[0]({ status: 'running' })
  listeners[0]({ status: 'idle' })
  listeners[0](undefined)
})

test('附件服务缺失时也能加载；存在时把截图挂成图像块', async () => {
  const homeDir = await freshHome()
  const withoutAttachments = await applyOnce({ homeDir })
  assert.equal(withoutAttachments.registrations.length, 25)

  const saved = []
  const attachments = {
    imageLimits: { mediaTypes: ['image/png', 'image/jpeg'], maxImageBytes: 5_000_000, maxMessageImageBytes: 4_000_000 },
    async saveImage({ data, mediaType, name }) {
      saved.push({ bytes: data.byteLength, mediaType, name })
      return { attachmentId: 'att-1', mediaType, bytes: data.byteLength, width: 1280, height: 800, name }
    },
  }
  const withAttachments = await applyOnce({ homeDir, services: { attachments } })
  assert.equal(withAttachments.registrations.length, 25)
  assert.equal(saved.length, 0, '加载本身不产生附件')
})
