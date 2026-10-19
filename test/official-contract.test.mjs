/**
 * 与**官方实现**的契约交叉校验（开发期；缺 `.ref/dsh` 或 asar 时自动跳过）。
 *
 * 为什么单独一个文件：这里钉的不是"我的代码自洽"，而是"我的假设和 DSH 官方代码一致"。
 * 三个假设最容易悄悄漂移，且漂移后**不会报错、只会静默失效**：
 *
 *   1. 判「调用方是不是子代理」用的字段（`origin` / `delegationDepth` / `options.subagentDepth`）
 *      —— 若 DSH 改名，子代理限制就变成一句空话（fail-open），界面上完全看不出来；
 *   2. 官方 `delegationDepthOf` 的语义（取较大者）—— 我自己实现了一份等价逻辑；
 *   3. 客户端半声明的 `dsh.client.inject` 是否**真的是客户端插件** —— 写错名字不会报错，
 *      加载器会静默跳过依赖顺序，等运行时报一个看不懂的错。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { asarCandidates, asarPath, refAvailable, refRoot } from './helpers.mjs'

// 探测顺序见 helpers.asarPath()：写死路径会让「官方实现交叉验证」在换机器时静默 skip。
const ASAR = asarPath()

/** 官方子代理包里的深度助手路径（按绝对路径导入：包根会拉进未提取的传递依赖）。 */
const depthModulePath = join(refRoot, 'node_modules', '@deepseek-ai', 'dsh-subagent', 'lib', 'types', 'depth.js')
/** 官方创建子代理的地方：这些字面量就是「这就是子代理」的证据。 */
const childAgentPath = join(refRoot, 'node_modules', '@deepseek-ai', 'dsh-subagent', 'lib', 'types', 'child-agent.js')

test('子代理识别与官方 delegationDepthOf 对齐（字段与「取较大者」语义都不能漂移）', async (t) => {
  if (!refAvailable() || !existsSync(depthModulePath)) {
    return t.skip('需要先跑 node tools/ref-extract-validator.mjs（.ref/dsh 缺失）')
  }
  const { delegationDepthOf } = await import(pathToFileURL(depthModulePath).href)
  const { classifyCaller } = await import('../src/access.js')

  // 官方语义：max(header.delegationDepth, options.subagentDepth)，缺省 0。
  const shapes = [
    { label: '顶层（只有 header.id）', agent: { session: { header: { id: 's' } }, options: {} } },
    {
      label: '深层委派（两侧都声明，取较大）',
      agent: { session: { header: { id: 's', delegationDepth: 1 } }, options: { subagentDepth: 3 } },
    },
    {
      label: '只有 header.delegationDepth',
      agent: { session: { header: { id: 's', delegationDepth: 2 } }, options: {} },
    },
    {
      label: '只有 options.subagentDepth',
      agent: { session: { header: { id: 's' } }, options: { subagentDepth: 1 } },
    },
  ]

  for (const { label, agent } of shapes) {
    const official = delegationDepthOf(agent)
    const mine = classifyCaller({ agent })
    if (official === 0) {
      assert.equal(mine.kind, 'main', `${label}：官方深度 0 ⇒ 必须判成主 Agent`)
    } else {
      assert.equal(mine.kind, 'subagent', `${label}：官方深度 ${official} ⇒ 必须判成子代理`)
      assert.equal(mine.depth, official, `${label}：深度数值要与官方一致（我算的是 ${mine.depth}）`)
    }
  }

  // `origin === 'subagent'` 是另一条独立判据（深度字段缺失时的兜底），官方也用它打标。
  const byOrigin = classifyCaller({ agent: { session: { header: { id: 's', origin: 'subagent' } }, options: {} } })
  assert.equal(byOrigin.kind, 'subagent')
  assert.ok(delegationDepthOf({ session: { header: { id: 's', origin: 'subagent' } }, options: {} }) === 0)
  // ↑ 这个组合正是「只看深度会漏掉」的情形：官方深度 0，但 origin 已经是 subagent。
  //    所以两个判据缺一不可——这条断言就是在钉这件事。
})

test('官方仍用这些字面量标记子代理（改名 = 我的识别失效，必须报警）', async (t) => {
  if (!refAvailable() || !existsSync(childAgentPath)) {
    return t.skip('需要先跑 node tools/ref-extract-validator.mjs（.ref/dsh 缺失）')
  }
  const source = readFileSync(childAgentPath, 'utf8')
  for (const literal of ["'subagent'", 'delegationDepth', 'parentSession']) {
    assert.ok(
      source.includes(literal),
      `官方 ${childAgentPath} 里不再出现 ${literal}：DSH 可能改了子代理标记方式，` +
        'src/access.js 的 classifyCaller 需要跟着改（否则「禁止子代理」会静默失效）',
    )
  }
})

test('客户端半声明的 dsh.client.inject 里，每个包都真的是客户端插件', async (t) => {
  if (ASAR === undefined) return t.skip(`找不到 app.asar（探测过：${asarCandidates().join(', ')}）`)
  const { listAsarEntries } = await import('../tools/asar.mjs')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const declared = pkg.dsh?.client?.inject ?? []
  assert.ok(declared.length > 0, '客户端半必须声明依赖的客户端插件')

  const entries = listAsarEntries(ASAR)
  const readManifest = (packageName) => {
    const path = `dsh/node_modules/${packageName}/package.json`
    const entry = entries.find((item) => item.path === path)
    if (entry === undefined) return undefined
    const buffer = entry.buffer.subarray(entry.dataStart + Number(entry.offset), entry.dataStart + Number(entry.offset) + entry.size)
    return JSON.parse(buffer.toString('utf8'))
  }

  for (const name of declared) {
    const manifest = readManifest(name)
    assert.ok(manifest !== undefined, `${name} 在 App 里不存在：dsh.client.inject 写错了名字（加载器会静默跳过）`)
    assert.equal(
      manifest.dsh?.client?.platform,
      'web',
      `${name} 不是客户端插件（dsh.client.platform 不是 'web'），写进 inject 没有意义`,
    )
    assert.ok(
      manifest.exports?.['./client'] !== undefined,
      `${name} 声明了 dsh.client 但导出里没有 "./client"：客户端加载器会直接抛错`,
    )
  }
})

test('输入框那一行的槽位仍在、且仍在「完全权限」芯片之后渲染（按钮位置的前提）', async (t) => {
  if (ASAR === undefined) return t.skip(`找不到 app.asar（探测过：${asarCandidates().join(', ')}）`)
  const { listAsarEntries } = await import('../tools/asar.mjs')
  const entries = listAsarEntries(ASAR)
  const entry = entries.find(
    (item) => item.path === 'dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js',
  )
  if (entry === undefined) return t.skip('官方 conversation 客户端 bundle 不在 App 里')
  const source = entry.buffer
    .subarray(entry.dataStart + Number(entry.offset), entry.dataStart + Number(entry.offset) + entry.size)
    .toString('utf8')

  // 槽位名是硬契约：DSH 改名 = 我们的按钮**静默消失**（界面不会报任何错）。
  assert.ok(
    source.includes('"conversation.input.left"'),
    '官方 InputBar 里不再渲染 conversation.input.left：本插件的按钮会消失，须跟随改名',
  )
  // 调用形态：无 owner props 的 renderSlot。形态变了，我们注册时注入 props 的方式就得跟着改。
  assert.ok(
    source.includes('renderSlot("conversation.input.left", {})'),
    '官方对 conversation.input.left 的调用形态变了（不再是无 owner props 的 renderSlot）',
  )
  // 位置：必须排在 permission 芯片之后——用户要的「完全权限右侧」正是靠这个顺序成立的。
  const permissionAt = source.indexOf('"conversation.input.permission"')
  const leftAt = source.indexOf('"conversation.input.left"')
  assert.ok(
    permissionAt > 0 && leftAt > permissionAt,
    'conversation.input.left 不再排在 permission 芯片之后，按钮位置会变',
  )
})
