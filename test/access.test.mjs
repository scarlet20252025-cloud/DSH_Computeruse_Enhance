/**
 * 访问闸门测试：谁能调用电脑操控、什么条件下拒绝。
 *
 * 这一层是**安全边界**，所以测法偏执一点：
 *   - 决策矩阵穷举（模式 × 调用方 × 子代理开关）；
 *   - 拒绝路径要断言「下游 handler 一次都没被调用」——只看抛不抛错不够，
 *     真正的失败是「抛了错但桌面已经被点过了」；
 *   - 拒绝路径还要断言「操作指示器没亮」——屏幕上什么都没发生却显示
 *     「DSH 正在操作电脑」，那是在骗用户。
 *   - 「需要询问」只认 `allowed-once`，其余一律拒绝（fail-closed）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'dsh-cu-access-'))
process.env.DSH_HOME = home

const access = await import('../src/access.js')
const { apply } = await import('../src/index.js')
const { resetHomeCacheForTesting, readConfig } = await import('../src/config.js')
const { createFakeContext } = await import('./helpers.mjs')

let caseIndex = 0
async function freshHome() {
  caseIndex += 1
  const dir = join(home, `case-${caseIndex}`)
  await mkdir(dir, { recursive: true })
  return dir
}

function useHome(homeDir) {
  process.env.DSH_HOME = homeDir
  resetHomeCacheForTesting()
}

/** 造一个「主 Agent」的 exec。 */
function mainExec(overrides = {}) {
  return {
    callId: 'call-main',
    signal: new AbortController().signal,
    agent: { id: 'session-main', session: { header: { id: 'session-main' } }, options: {} },
    ...overrides,
  }
}

/** 造一个「子代理」的 exec（用 origin 标记）。 */
function subagentExec(overrides = {}) {
  return {
    callId: 'call-sub',
    signal: new AbortController().signal,
    agent: {
      id: 'session-sub',
      session: { header: { id: 'session-sub', origin: 'subagent', delegationDepth: 1, parentSession: 'session-main' } },
      options: {},
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 调用方判定
// ---------------------------------------------------------------------------

test('classifyCaller：主 Agent / 子代理（origin）/ 子代理（深度兜底）/ 判定不出来', () => {
  assert.equal(access.classifyCaller(mainExec()).kind, 'main')
  assert.equal(access.classifyCaller(subagentExec()).kind, 'subagent')
  // 只有 delegationDepth、没有 origin 时也必须认出来
  assert.equal(
    access.classifyCaller({
      agent: { id: 's', session: { header: { id: 's', delegationDepth: 2 } }, options: {} },
    }).kind,
    'subagent',
  )
  // 只有 options.subagentDepth 时的兜底
  assert.equal(
    access.classifyCaller({ agent: { id: 's', session: { header: { id: 's' } }, options: { subagentDepth: 1 } } }).kind,
    'subagent',
  )
  assert.equal(access.classifyCaller({}).kind, 'unknown')
  assert.equal(access.classifyCaller(undefined).kind, 'unknown')
})

test('classifyCaller：PTC 的 exec.parent 不是父会话，不能拿来判层级', () => {
  // exec.parent 存在但会话是主 Agent：必须仍然是 main
  const withParent = mainExec({ parent: { callId: 'parent-call' } })
  assert.equal(access.classifyCaller(withParent).kind, 'main')
})

test('classifyCaller：agent 在但读不到 session.header → unknown（不能默认成主 Agent）', () => {
  // 这是 fail-open 的入口：如果这里返回 main，「禁止子代理」就会被绕过。
  const noHeader = { agent: { id: 'session-x', options: {} } }
  assert.equal(access.classifyCaller(noHeader).kind, 'unknown')
  assert.match(access.classifyCaller(noHeader).detail, /session\.header/u)
  const brokenHeader = { agent: { id: 'session-x', session: { header: null }, options: {} } }
  assert.equal(access.classifyCaller(brokenHeader).kind, 'unknown')
})

// ---------------------------------------------------------------------------
// 决策矩阵
// ---------------------------------------------------------------------------

test('decideAccess：模式 × 调用方 × 子代理开关 的完整矩阵', () => {
  const matrix = [
    // 全自动
    ['auto', true, 'main', 'allow'],
    ['auto', true, 'subagent', 'allow'],
    ['auto', false, 'main', 'allow'],
    ['auto', false, 'subagent', 'deny'],
    // 全自动 + 判不出来：放行（详见 src/access.js 里的取舍说明——拒绝它会把主 Agent 的
    // 正常调用误伤成「无法归属会话」，而「禁止子代理」不依赖这条）
    ['auto', true, 'unknown', 'allow'],
    ['auto', false, 'unknown', 'allow'],
    // 需要询问
    ['ask', true, 'main', 'ask'],
    ['ask', false, 'main', 'ask'],
    ['ask', true, 'subagent', 'deny'],
    ['ask', false, 'subagent', 'deny'],
    ['ask', true, 'unknown', 'deny'],
    // 禁用
    ['off', true, 'main', 'deny'],
    ['off', true, 'subagent', 'deny'],
    ['off', false, 'main', 'deny'],
    ['off', false, 'unknown', 'deny'],
  ]
  for (const [mode, allowSubagents, kind, expected] of matrix) {
    const decision = access.decideAccess({ mode, allowSubagents, caller: { kind } })
    assert.equal(decision.effect, expected, `${mode}/${allowSubagents}/${kind} 期望 ${expected}`)
  }
})

test('decideAccess：非法模式退回全自动（配置被手改坏也不该把人锁死）', () => {
  assert.equal(access.decideAccess({ mode: 'whatever', allowSubagents: true, caller: { kind: 'main' } }).effect, 'allow')
})

test('decideAccess：禁用时给模型的说明要说清「没有重试的意义」', () => {
  const decision = access.decideAccess({ mode: 'off', allowSubagents: true, caller: { kind: 'main' } })
  assert.equal(decision.code, 'CUA_DISABLED')
  assert.match(decision.message, /不要重试/u)
  assert.match(decision.message, /没有任何变化/u)
})

test('interpretApprovalOutcome：只有 allowed-once 是授权', () => {
  assert.equal(access.interpretApprovalOutcome('allowed-once').allowed, true)
  for (const outcome of ['rejected', 'cancelled', 'unavailable', undefined, 'whatever']) {
    assert.equal(access.interpretApprovalOutcome(outcome).allowed, false, `${outcome} 必须拒绝`)
  }
})

// ---------------------------------------------------------------------------
// 命令参数解析
// ---------------------------------------------------------------------------

test('parseCommandArguments：两种写法、读状态、--json 与非法输入', () => {
  assert.deepEqual(access.parseCommandArguments('mode=ask subagents=off'), {
    ok: true,
    patch: { accessMode: 'ask', allowSubagents: false },
    json: false,
  })
  assert.deepEqual(access.parseCommandArguments('mode ask'), { ok: true, patch: { accessMode: 'ask' }, json: false })
  assert.deepEqual(access.parseCommandArguments('subagents on'), { ok: true, patch: { allowSubagents: true }, json: false })
  assert.deepEqual(access.parseCommandArguments('auto'), { ok: true, patch: { accessMode: 'auto' }, json: false })
  // 裸 `off` 归**模式**而不是子代理开关：用户说「关掉电脑操控」时指的是它。
  // 子代理开关要写清楚：`subagents off`。
  assert.deepEqual(access.parseCommandArguments('off'), { ok: true, patch: { accessMode: 'off' }, json: false })
  assert.deepEqual(access.parseCommandArguments('subagents off'), {
    ok: true,
    patch: { allowSubagents: false },
    json: false,
  })
  assert.deepEqual(access.parseCommandArguments(''), { ok: true, json: false })
  assert.deepEqual(access.parseCommandArguments('status'), { ok: true, json: false })
  assert.deepEqual(access.parseCommandArguments('mode=off --json'), {
    ok: true,
    patch: { accessMode: 'off' },
    json: true,
  })
  assert.equal(access.parseCommandArguments('mode 飞快').ok, false)
  assert.equal(access.parseCommandArguments('mode').ok, false)
  assert.equal(access.parseCommandArguments('坏参数').ok, false)
})

// ---------------------------------------------------------------------------
// 闸门在真实注册路径上生效（createGuardedExecute）
// ---------------------------------------------------------------------------

/** 造一个被调用的工具定义，记录 handler 是否真的执行过。 */
function trackedDefinition({ result = { ok: true } } = {}) {
  const calls = []
  return {
    calls,
    definition: {
      name: 'left_click',
      parameters: { type: 'object', properties: { x: { type: 'number' } }, required: [], additionalProperties: false },
      async execute(args) {
        calls.push(args)
        return result
      },
    },
  }
}

/** 假的指示器：记录 note 调用。 */
function fakeIndicator() {
  const notes = []
  return { notes, note: (name, options) => notes.push({ name, options }) }
}

/** 假的审批服务。 */
function fakeApproval(outcome) {
  const requests = []
  return {
    requests,
    async request(request) {
      requests.push(request)
      return outcome
    },
  }
}

async function runTool({ settings, exec, approval, definition, indicator }) {
  const tool = definition ?? trackedDefinition()
  const observe = indicator ?? fakeIndicator()
  const guarded = productionGuard(tool.definition, observe, undefined, gateFor(settings, approval))
  let error
  let value
  try {
    value = await guarded({}, exec)
  } catch (caught) {
    error = caught
  }
  return { error, value, calls: tool.calls, notes: observe.notes }
}

/** 闸门的生产形状：`{read(), approval?}`（`read()` 每次调用返回当前设置）。 */
function gateFor(settings, approval) {
  return { read: () => settings, ...(approval === undefined ? {} : { approval }) }
}

const { createGuardedExecute: productionGuard } = await import('../src/index.js')

test('禁用（off）：拒绝、说明原因、handler 未被调用、指示器不亮', async () => {
  const { error, calls, notes } = await runTool({
    settings: { accessMode: 'off', allowSubagents: true },
    exec: mainExec(),
  })
  assert.ok(error, '必须抛错')
  assert.equal(error.code, 'CUA_DISABLED')
  assert.equal(error.name, 'AccessDeniedError')
  assert.deepEqual(calls, [], '桌面绝不能被碰')
  assert.deepEqual(notes, [], '屏幕上什么都没发生，指示器不该亮')
})

test('子代理被关闭：拒绝且不改桌面；打开后放行', async () => {
  const blocked = await runTool({
    settings: { accessMode: 'auto', allowSubagents: false },
    exec: subagentExec(),
  })
  assert.equal(blocked.error?.code, 'CUA_SUBAGENT_BLOCKED')
  assert.deepEqual(blocked.calls, [])
  assert.deepEqual(blocked.notes, [])

  const allowed = await runTool({
    settings: { accessMode: 'auto', allowSubagents: true },
    exec: subagentExec(),
  })
  assert.equal(allowed.error, undefined)
  assert.equal(allowed.calls.length, 1)
  assert.equal(allowed.notes.length, 1, '放行时才亮指示器')
})

test('主 Agent 在全自动模式下直接执行', async () => {
  const { error, calls, notes } = await runTool({
    settings: { accessMode: 'auto', allowSubagents: false },
    exec: mainExec(),
  })
  assert.equal(error, undefined)
  assert.equal(calls.length, 1)
  assert.equal(notes[0]?.name, 'left_click')
})

test('需要询问 + 用户允许一次：执行；且审批拿到了 agent/callId/reason', async () => {
  const approval = fakeApproval('allowed-once')
  const { error, calls } = await runTool({
    settings: { accessMode: 'ask', allowSubagents: true },
    exec: mainExec(),
    approval,
  })
  assert.equal(error, undefined)
  assert.equal(calls.length, 1)
  assert.equal(approval.requests.length, 1)
  assert.equal(approval.requests[0].toolName, 'left_click')
  assert.equal(approval.requests[0].callId, 'call-main')
  assert.equal(approval.requests[0].agent.id, 'session-main')
  assert.match(approval.requests[0].reason, /移动鼠标/u)
})

test('需要询问 + 用户拒绝：拒绝且桌面没被碰', async () => {
  const { error, calls, notes } = await runTool({
    settings: { accessMode: 'ask', allowSubagents: true },
    exec: mainExec(),
    approval: fakeApproval('rejected'),
  })
  assert.equal(error?.code, 'CUA_APPROVAL_DENIED')
  assert.deepEqual(calls, [])
  assert.deepEqual(notes, [])
})

test('需要询问 + 审批不可用（DSH 权限预设不询问）：fail-closed', async () => {
  const { error, calls } = await runTool({
    settings: { accessMode: 'ask', allowSubagents: true },
    exec: mainExec(),
    approval: fakeApproval('unavailable'),
  })
  assert.equal(error?.code, 'CUA_APPROVAL_DENIED')
  assert.deepEqual(calls, [])
  assert.match(error.message, /没有任何变化/u)
})

test('需要询问 + 环境没有审批服务：fail-closed，并告诉用户怎么改', async () => {
  const { error, calls } = await runTool({
    settings: { accessMode: 'ask', allowSubagents: true },
    exec: mainExec(),
  })
  assert.equal(error?.code, 'CUA_APPROVAL_UNAVAILABLE')
  assert.deepEqual(calls, [])
  assert.match(error.message, /全自动/u)
})

test('需要询问 + 子代理：拒绝（子代理不该替用户弹审批）', async () => {
  const approval = fakeApproval('allowed-once')
  const { error, calls } = await runTool({
    settings: { accessMode: 'ask', allowSubagents: true },
    exec: subagentExec(),
    approval,
  })
  assert.equal(error?.code, 'CUA_SUBAGENT_CANNOT_ASK')
  assert.deepEqual(calls, [])
  assert.equal(approval.requests.length, 0, '压根不该发起审批')
})

test('需要询问 + 无法归属会话：拒绝', async () => {
  const { error } = await runTool({
    settings: { accessMode: 'ask', allowSubagents: true },
    exec: { callId: 'call-x', signal: new AbortController().signal },
    approval: fakeApproval('allowed-once'),
  })
  assert.equal(error?.code, 'CUA_CALLER_UNKNOWN')
})

test('全自动下判不出调用方：放行（避免误伤没有 agent 的正常调用）', async () => {
  // 这一条是被真机 e2e 打回来的：DSH 里工具调用可以没有 agent，
  // 拦它会让主 Agent 的正常调用报出「无法归属会话」。子代理另有 origin 标记兜住。
  const relaxed = await runTool({
    settings: { accessMode: 'auto', allowSubagents: false },
    exec: { agent: { id: 'session-x', options: {} }, callId: 'c', signal: new AbortController().signal },
  })
  assert.equal(relaxed.error, undefined)
  assert.equal(relaxed.calls.length, 1)

  // 完全没有 agent 也一样
  const anonymous = await runTool({
    settings: { accessMode: 'auto', allowSubagents: false },
    exec: { callId: 'c2', signal: new AbortController().signal },
  })
  assert.equal(anonymous.error, undefined)
  assert.equal(anonymous.calls.length, 1)
})

test('审批服务抛错：按拒绝处理（不把异常当放行）', async () => {
  const { error, calls } = await runTool({
    settings: { accessMode: 'ask', allowSubagents: true },
    exec: mainExec(),
    approval: {
      async request() {
        throw new Error('no open turn')
      },
    },
  })
  assert.equal(error?.code, 'CUA_APPROVAL_FAILED')
  assert.deepEqual(calls, [])
})

test('缺失闸门（不传 access）时保持旧行为：直接执行', async () => {
  const tool = trackedDefinition()
  const guarded = productionGuard(tool.definition, fakeIndicator(), undefined, undefined)
  await guarded({}, mainExec())
  assert.equal(tool.calls.length, 1)
})

// ---------------------------------------------------------------------------
// /computer-use 命令：落盘 + 立即生效
// ---------------------------------------------------------------------------

/** 命令 handler 的调用垫片。 */
async function applyWithCommands({ settings, homeDir, approval }) {
  useHome(homeDir)
  const handlers = new Map()
  const commands = {
    register(definition) {
      handlers.set(definition.name, definition)
      return () => handlers.delete(definition.name)
    },
  }
  const ctx = createFakeContext({ services: { commands, ...(approval === undefined ? {} : { approval }) } })
  await apply(ctx, { warmup: false, installSkill: false, indicator: false, ...settings })
  return { ctx, handlers }
}

test('/computer-use：改设置会落盘、立即生效，并返回机器可读状态', async () => {
  const homeDir = await freshHome()
  const { ctx, handlers } = await applyWithCommands({ settings: {}, homeDir })
  const handler = handlers.get('computer-use')?.handler
  assert.ok(handler, '/computer-use 命令必须被注册')

  // 初始：默认全自动 + 不允许子代理；子代理调用被拒
  const before = ctx.registrations.find((definition) => definition.name === 'left_click')
  await assert.rejects(
    () => before.execute({}, subagentExec()),
    (error) => error.code === 'CUA_SUBAGENT_BLOCKED',
  )

  // 打开子代理 + 切到需要询问（客户端菜单一次提交两个字段）
  const updated = await handler({ rawInput: 'mode=ask subagents=on --json' })
  assert.equal(updated.kind, 'success')
  assert.deepEqual(JSON.parse(updated.text), { mode: 'ask', allowSubagents: true, modeLabel: '需要询问' })

  // 落盘：重启后也是这个值
  const persisted = await readConfig()
  assert.equal(persisted.accessMode, 'ask')
  assert.equal(persisted.allowSubagents, true)

  // 立即生效：主 Agent 现在走审批（没有 approval 服务 → fail-closed 拒绝）
  await assert.rejects(
    () => before.execute({}, mainExec()),
    (error) => error.code === 'CUA_APPROVAL_UNAVAILABLE',
  )

  // 关掉一切
  const off = await handler({ rawInput: 'mode=off' })
  assert.match(off.text, /禁用/u)
  await assert.rejects(
    () => before.execute({}, mainExec()),
    (error) => error.code === 'CUA_DISABLED',
  )
  assert.equal((await readConfig()).accessMode, 'off')
})

test('/computer-use：非法参数返回可读错误，且不改配置', async () => {
  const homeDir = await freshHome()
  const { handlers } = await applyWithCommands({ settings: {}, homeDir })
  const handler = handlers.get('computer-use')?.handler
  const result = await handler({ rawInput: 'mode 飞快' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /模式只能是/u)
  assert.equal((await readConfig()).accessMode, 'auto')
})

test('/computer-use：纯读状态既不写盘也不改状态', async () => {
  const homeDir = await freshHome()
  const { handlers } = await applyWithCommands({ settings: { accessMode: 'off', allowSubagents: true }, homeDir })
  const handler = handlers.get('computer-use')?.handler
  const status = await handler({ rawInput: '--json' })
  assert.deepEqual(JSON.parse(status.text), { mode: 'off', allowSubagents: true, modeLabel: '禁用' })
  const human = await handler({ rawInput: '' })
  assert.equal(human.text, '电脑操控：禁用（允许子代理）')
  assert.equal((await readConfig()).accessMode, 'auto', '读状态不该写盘')
})

// ---------------------------------------------------------------------------
// request_access 自报访问设置（运行时可自查）
// ---------------------------------------------------------------------------

/** 造一个够用的假运行时（只覆盖 request_access 需要的部分）。 */
function accessRuntime(report) {
  return {
    longTimeoutMs: 60000,
    async call(cmd) {
      if (cmd === 'screen_info') return { monitors: [{ id: 1 }], virtual: { width: 2560, height: 1600 } }
      return {}
    },
    async probe() {
      return { ok: true, info: { protocol: 'dsh-cua/1', dpiAware: true } }
    },
    ...(report === undefined ? {} : { accessReport: () => report }),
    defaultScreenshotArgs: () => ({}),
    screenshotBudget: () => 524288,
    jpegQuality: () => 80,
    async saveFrame() {},
    async attachImage() {},
  }
}

test('request_access：把当前访问设置一起报出来（界面改了设置，这里立刻能看出来）', async () => {
  const { createToolDefinitions } = await import('../src/tools.js')
  const { native } = createToolDefinitions(
    accessRuntime({ mode: 'off', allowSubagents: false, label: '电脑操控：禁用（仅主 Agent）' }),
  )
  const requestAccess = native.find((definition) => definition.name === 'request_access')
  const result = await requestAccess.execute({}, {})
  assert.equal(result.access.mode, 'off')
  assert.equal(result.access.allowSubagents, false)
  assert.match(result.text, /access_mode="off" subagents="blocked"/u)
  assert.match(result.text, /电脑操控访问设置：电脑操控：禁用（仅主 Agent）/u)
})

test('request_access：没有访问报告时保持向后兼容（不出现 access 行）', async () => {
  const { createToolDefinitions } = await import('../src/tools.js')
  const { native } = createToolDefinitions(accessRuntime(undefined))
  const requestAccess = native.find((definition) => definition.name === 'request_access')
  const result = await requestAccess.execute({}, {})
  assert.equal(result.access, undefined)
  assert.doesNotMatch(result.text, /access_mode/u)
})

test('/computer-use：审批可用时，询问模式在真实注册路径上放行', async () => {  const homeDir = await freshHome()
  const approval = fakeApproval('allowed-once')
  const { ctx } = await applyWithCommands({
    settings: { accessMode: 'ask', allowSubagents: true },
    homeDir,
    approval,
  })
  const definition = ctx.registrations.find((item) => item.name === 'left_click')
  // 没有真实后端：走到 handler 就会因后端不可用而失败——那正好证明闸门放行了。
  await assert.rejects(
    () => definition.execute({}, mainExec()),
    (error) => error.code !== 'CUA_APPROVAL_DENIED' && error.code !== 'CUA_DISABLED',
  )
  assert.equal(approval.requests.length, 1)
})
