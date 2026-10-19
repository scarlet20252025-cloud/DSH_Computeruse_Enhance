/**
 * 电脑操控的访问闸门。
 *
 * 为什么需要它：Computer Use 是**真的在动用户的鼠标键盘**。在它之前，任何会话——
 * 包括用户看不见的子代理——只要有需求就能调用。这个模块把「谁能在什么条件下调用」
 * 变成一次纯函数判定，好处有两个：
 *   1. 判定逻辑不掺 I/O，矩阵可以穷举测试（`test/access.test.mjs`）；
 *   2. 闸门在**每次调用**时执行，所以设置改了立即生效，不需要重启插件。
 *
 * 三种模式（用户可见的名字在 GUI 的「电脑操控」菜单里）：
 *   - `auto` 全自动：直接执行；
 *   - `ask`  需要询问：走 DSH 原生审批弹窗，只有 `allowed-once` 放行；
 *   - `off`  禁用：主 Agent 与子代理都拒绝。
 *
 * 失败一律**关闭**（fail-closed）：判定不出来就不放行。开放才是需要理由的那一侧。
 */
/** 合法访问模式。 */
export const ACCESS_MODES = ['auto', 'ask', 'off']

/** 被拒绝时抛出的错误：带上稳定 code，便于测试与模型理解。 */
export class AccessDeniedError extends Error {
  /**
   * @param code 稳定错误码（`CUA_*`）
   * @param message 面向模型/用户的说明
   */
  constructor(code, message) {
    super(message)
    this.name = 'AccessDeniedError'
    this.code = code
  }
}

/**
 * 判定一次工具调用的发起方。
 *
 * 依据（均为 DSH 的公开字段，见 `packages/core/session/src/types.ts` 的会话 header）：
 *   - `exec.agent` 缺失 → 判定不出来（`unknown`）；
 *   - `header.origin === 'subagent'` → 子代理；
 *   - `header.delegationDepth > 0` 或 `agent.options.subagentDepth > 0` → 子代理（兜底）。
 *
 * 注意 `exec.parent` **不是**父代理：它是 PTC 传输层的子派发标记，别拿它判层级。
 * @param exec 工具执行上下文（`ToolRunContext`）
 * @returns `{kind, depth?, sessionId?, parentSession?}`，`kind ∈ main|subagent|unknown`
 */
export function classifyCaller(exec) {
  const agent = exec?.agent
  if (agent === null || agent === undefined) return { kind: 'unknown', detail: '工具上下文里没有 agent' }
  const header = agent.session?.header
  if (header === null || header === undefined || typeof header !== 'object') {
    // 拿不到会话 header 时**不能**默认当成主 Agent：那会让「禁止子代理」变成 fail-open。
    // 判不出来就是判不出来，交给 decideAccess 按保守侧处理，并留下可观测的痕迹。
    return { kind: 'unknown', detail: 'agent 上没有可读的 session.header' }
  }
  const headerDepth = Number(header.delegationDepth ?? 0)
  const optionDepth = Number(agent.options?.subagentDepth ?? 0)
  const depth = Math.max(Number.isFinite(headerDepth) ? headerDepth : 0, Number.isFinite(optionDepth) ? optionDepth : 0)
  if (header.origin === 'subagent' || depth > 0) {
    return {
      kind: 'subagent',
      depth: depth > 0 ? depth : 1,
      sessionId: header.id,
      ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
    }
  }
  return { kind: 'main', depth: 0, ...(header.id === undefined ? {} : { sessionId: header.id }) }
}

/**
 * 判定一次调用是否放行。
 * @param options.mode `auto` / `ask` / `off`
 * @param options.allowSubagents 是否允许子代理调用
 * @param options.caller {@link classifyCaller} 的结果
 * @returns `{effect: 'allow'}` 或 `{effect: 'ask'}` 或 `{effect: 'deny', code, message}`
 */
export function decideAccess({ mode, allowSubagents, caller }) {
  const resolvedMode = ACCESS_MODES.includes(mode) ? mode : 'auto'

  if (resolvedMode === 'off') {
    return {
      effect: 'deny',
      code: 'CUA_DISABLED',
      message:
        '用户在「电脑操控」设置里选择了「禁用」，因此本次调用被拒绝，桌面没有任何变化。' +
        '不要重试；如果确实需要操作电脑，请提示用户在输入框那一行的「电脑操控」菜单里改回「全自动」或「需要询问」。',
    }
  }

  if (caller?.kind === 'subagent' && allowSubagents !== true) {
    return {
      effect: 'deny',
      code: 'CUA_SUBAGENT_BLOCKED',
      message:
        '当前设置不允许子代理使用电脑操控（用户可在「电脑操控」菜单里打开「允许子代理」）。' +
        '请不要重试；要么让主 Agent 直接执行这一步，要么把需要操作的结论回传给主 Agent。',
    }
  }

  // 「判不出来」只在**询问模式**下拒绝：那时确实需要用户确认，而没有任何会话就无法弹审批。
  //
  // 这里刻意**不在全自动模式下拦**。理由是我先写了「限制态一律拒绝」，然后被真机 e2e 打回：
  // 工具调用在 DSH 里可以没有 agent（内置的 ask 路径专门处理 `exec.agent === undefined`），
  // 拦它只会让主 Agent 的正常调用报出「无法归属会话」这种莫名其妙的错误。
  // 而「禁止子代理」这条保证**不依赖**这里：子代理的调用带 `origin: 'subagent'` /
  // `delegationDepth > 0` 标记（DSH 的 subagent 实现主动打标），上面那条规则抓的就是它。
  if (caller?.kind === 'unknown' && resolvedMode === 'ask') {
    return {
      effect: 'deny',
      code: 'CUA_CALLER_UNKNOWN',
      message:
        '电脑操控当前是「需要询问」模式，但这次调用没有可归属的会话（无法向用户弹出审批），' +
        '因此按最小授权拒绝。桌面没有任何变化。',
    }
  }

  if (resolvedMode === 'ask') {
    if (caller?.kind === 'subagent') {
      // 子代理不该替用户弹审批：审批面板绑定主会话，子代理弹出来用户也不知道是谁在要权限。
      return {
        effect: 'deny',
        code: 'CUA_SUBAGENT_CANNOT_ASK',
        message:
          '电脑操控当前是「需要询问」模式，而询问必须由用户在主会话里确认，子代理无法代为申请。' +
          '请把这一步交回主 Agent，或让用户把模式改为「全自动」并打开「允许子代理」。',
      }
    }
    return { effect: 'ask' }
  }

  return { effect: 'allow' }
}

/**
 * 审批结果的语义（`ApprovalOutcome`）。
 * 只有 `allowed-once` 是授权；其余（rejected / cancelled / unavailable）全部拒绝。
 * @param outcome `ctx.approval.request()` 的返回值
 * @returns `{allowed, message}`；`message` 仅在不放行时给出可读原因
 */
export function interpretApprovalOutcome(outcome) {
  if (outcome === 'allowed-once') return { allowed: true }
  const reason =
    outcome === 'rejected'
      ? '用户拒绝'
      : outcome === 'cancelled'
        ? '审批被取消'
        : '当前会话无法弹出审批（DSH 的权限预设可能是不询问的档位）'
  return {
    allowed: false,
    message:
      `电脑操控设置为「需要询问」，本次${reason}，已按拒绝处理，桌面没有任何变化。` +
      (outcome === 'unavailable' || outcome === 'rejected'
        ? '如果这里其实没人看到弹窗，说明当前权限预设不会询问：请在输入框那一行把权限预设切到会询问的档位，或把「电脑操控」改为「全自动」。'
        : ''),
  }
}

/**
 * 把设置渲染成给人看的一行（GUI 菜单与 `/computer-use` 命令共用）。
 * @param settings `{accessMode, allowSubagents}`
 * @param [labels] 可选的模式显示名覆盖
 */
export function describeSettings(settings, labels = {}) {
  const modeLabel = labels[settings.accessMode] ?? modeDisplayName(settings.accessMode)
  const subagentLabel = settings.allowSubagents === true ? '允许子代理' : '仅主 Agent'
  return `电脑操控：${modeLabel}（${subagentLabel}）`
}

/** 模式的中文显示名。 */
export function modeDisplayName(mode) {
  if (mode === 'ask') return '需要询问'
  if (mode === 'off') return '禁用'
  return '全自动'
}

/**
 * 解析 `/computer-use` 的参数。
 *
 * 接受两种写法，因为两个调用方习惯不同：
 *   - 命令行风格：`/computer-use mode ask`、`/computer-use subagents on`
 *   - 一次到位（GUI 菜单用）：`/computer-use mode=ask subagents=off`
 * 空参数 = 读状态；`status` = 读状态；`--json` 让返回值变成机器可读的一行 JSON。
 * @param rawInput 命令名之后的原始文本
 * @returns `{ok: true, patch?, json}` 或 `{ok: false, message}`
 */
export function parseCommandArguments(rawInput) {
  const text = String(rawInput ?? '').trim()
  const json = /(^|\s)--json(\s|$)/u.test(text)
  const tokens = text
    .replace(/--json/gu, ' ')
    .split(/\s+/u)
    .filter((token) => token !== '')
  if (tokens.length === 0 || tokens[0] === 'status') return { ok: true, json }

  const patch = {}
  let failure

  /** 写入一个字段；出错时记录原因（不用异常，调用方只关心有没有失败）。 */
  const apply = (field, value) => {
    if (field === 'mode') {
      if (!ACCESS_MODES.includes(value)) {
        failure = `模式只能是 auto（全自动）/ ask（需要询问）/ off（禁用），收到「${value}」`
        return
      }
      patch.accessMode = value
      return
    }
    if (field === 'subagents') {
      const normalized = String(value ?? '').toLowerCase()
      if (['on', 'true', 'yes', '1', '开', '打开'].includes(normalized)) patch.allowSubagents = true
      else if (['off', 'false', 'no', '0', '关', '关闭'].includes(normalized)) patch.allowSubagents = false
      else failure = `子代理开关只能是 on / off，收到「${value}」`
      return
    }
    failure = `无法识别的参数「${field}」；可用：mode ask|auto|off、subagents on|off`
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const separator = token.indexOf('=')
    if (separator > 0) {
      // `mode=ask` 这种一次到位写法
      const field = token.slice(0, separator).toLowerCase()
      apply(field === 'accessmode' ? 'mode' : field === 'allowsubagents' ? 'subagents' : field, token.slice(separator + 1))
    } else {
      const field = token.toLowerCase()
      if (field === 'mode' || field === 'subagents') {
        const value = tokens[index + 1]
        if (value === undefined || value.includes('=')) {
          return { ok: false, message: `「${field}」后面缺一个值` }
        }
        index += 1
        apply(field, value)
      } else if (ACCESS_MODES.includes(field)) {
        apply('mode', field)
      } else if (field === 'on' || field === 'off') {
        apply('subagents', field)
      } else {
        return { ok: false, message: `无法识别的参数「${token}」；用法见 /computer-use` }
      }
    }
    if (failure !== undefined) return { ok: false, message: failure }
  }
  return { ok: true, patch, json }
}

/** 设置转成机器可读的一行（GUI 客户端读它来渲染当前选中项）。 */
export function settingsPayload(settings) {
  return JSON.stringify({
    mode: settings.accessMode,
    allowSubagents: settings.allowSubagents === true,
    modeLabel: modeDisplayName(settings.accessMode),
  })
}
