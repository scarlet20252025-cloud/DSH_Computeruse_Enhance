/**
 * 技能文件测试：用 DSH **自己的**解析器（`dsh-skill-filesystem` 里的
 * `parseFrontmatter` + `yaml` 包 + `dsh-skill` 的 `isSkillName`）验证
 * `skills/computer-use/SKILL.md` 真的会被技能目录接受。
 *
 * 为什么值得单独测：技能一旦 frontmatter 不合法，DSH 只会打一条 warn 然后**静默丢弃**，
 * 表现是「模型看不到这个技能」——这类失败在真机上也很难定位。
 * 这里把那段解析逻辑原样搬过来跑，等价于让官方 provider 先审一遍。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SKILL_MARKER, bundledSkillPath, installedSkillPath } from '../src/skill.js'
import { loadDshPackage, refAvailable } from './helpers.mjs'

/** 与 `dsh-skill-filesystem/lib/index.js` 的 parseFrontmatter 逐行等价。 */
function findClosingFrontmatter(raw, start) {
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/u, '') === '---') {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

function parseFrontmatter(raw, parseYaml) {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/u, '') !== '---') return undefined
  const start = firstLineEnd + 1
  const closing = findClosingFrontmatter(raw, start)
  if (closing === undefined) return undefined
  const parsed = parseYaml(raw.slice(start, closing.start))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return { data: parsed, body: raw.slice(closing.bodyStart) }
}

test('随包技能能被 DSH 的 frontmatter 解析器接受，且 name 合法', async (t) => {
  if (!refAvailable()) {
    t.skip('run `node tools/ref-extract-validator.mjs` first')
    return
  }
  const { parse: parseYaml } = await loadDshPackage('yaml')
  const skill = await loadDshPackage('@deepseek-ai/dsh-skill')

  const raw = await readFile(bundledSkillPath(), 'utf8')
  const parsed = parseFrontmatter(raw, parseYaml)
  assert.ok(parsed, 'frontmatter 必须存在且可解析')

  assert.equal(parsed.data.name, 'computer-use')
  assert.equal(typeof skill.isSkillName, 'function')
  assert.equal(skill.isSkillName(parsed.data.name), true, 'name 必须符合 provider 的命名规则')
  assert.equal(typeof parsed.data.description, 'string')
  assert.ok(parsed.data.description.length > 40, 'description 要足够让模型判断何时该用')
  assert.equal(typeof parsed.data.whenToUse, 'string')
  assert.equal(typeof parsed.data.metadata, 'object')

  // provider 会拒绝 legacy 拼写（camelCase 变体），这里显式钉住不要引入。
  for (const legacy of ['disableModelInvocation', 'userInvocable']) {
    assert.equal(Object.hasOwn(parsed.data, legacy), false, `不许用 legacy 字段 ${legacy}`)
  }

  // 可选布尔字段：允许的方式只有 YAML 布尔与 true/false/yes/no/on/off/1/0；
  // 我们不声明它们，因此默认「允许两个接口调用」。
  assert.equal(parsed.data['disable-model-invocation'], undefined)
  assert.equal(parsed.data['user-invocable'], undefined)

  // 随包源文件不带所有权标记：标记由安装时追加，避免源文件被误当成「已安装副本」。
  assert.equal(raw.includes(SKILL_MARKER), false, '随包源文件不应带安装标记')
  assert.ok(!raw.startsWith(SKILL_MARKER), 'frontmatter 必须是文件首行')
})

test('技能正文覆盖了观察→操作→复查的关键纪律', async () => {
  const raw = await readFile(bundledSkillPath(), 'utf8')
  for (const needle of [
    'get_app_state', // 观察通道
    'state_id', // 元素目标纪律
    'raster', // 坐标纪律
    'stop_computer_control', // 收尾
    'ELEMENT_STALE', // 错误恢复
    'UIPI', // Windows 提权限制
  ]) {
    assert.ok(raw.includes(needle), `技能正文缺少关键内容：${needle}`)
  }
})

test('安装到用户技能根后的副本同样可解析（含末尾标记）', async (t) => {
  if (!refAvailable()) {
    t.skip('official parser not extracted')
    return
  }
  const { parse: parseYaml } = await loadDshPackage('yaml')
  const { ensureSkillInstalled } = await import('../src/skill.js')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-cu-skill-'))
  try {
    const { resetHomeCacheForTesting } = await import('../src/config.js')
    resetHomeCacheForTesting()
    const result = await ensureSkillInstalled()
    assert.equal(result.status, 'installed')
    assert.equal(result.path, await installedSkillPath())

    const raw = await readFile(result.path, 'utf8')
    const parsed = parseFrontmatter(raw, parseYaml)
    assert.ok(parsed, '安装后的副本仍必须能被解析')
    assert.equal(parsed.data.name, 'computer-use')
    assert.ok(parsed.body.includes(SKILL_MARKER))
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})
