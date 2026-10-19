/*
 * dsh-computer-use 的浏览器半（客户端插件）。
 *
 * 形态说明：DSH 的客户端插件**不是** ESM 模块，而是以经典脚本注册一个工厂
 * （`window.__ModuleLoader__.load({id, factory})`），外部依赖经工厂参数 `require` 解析。
 * 所以这个文件是手写的、不用 JSX（`React.createElement` 代替），也不需要构建步骤。
 *
 * 它做两件事：
 *   1. 在输入框那一行（`conversation.input.left`，紧挨「完全权限」芯片）放一个按钮；
 *   2. 点开是一个菜单：是否允许子代理 + 三选一的模式，选择结果提交宿主命令
 *      `/computer-use …`，由宿主校验并写盘。
 *
 * **界面不是安全边界**：真正的拦截在宿主侧（每次工具调用都过闸门）。这里显示的
 * 状态只是为了让人看懂当前设置；即使界面与配置文件不同步（例如用户手改了 JSON），
 * 被拦住的调用依然会被拦住。
 */
window.__ModuleLoader__.load({
  id: 'dsh-computer-use',
  factory: (require) => {
    // 与 DSH 自带客户端插件的构建产物同形：工厂返回 `module.exports`，
    // 并带上 `Symbol.toStringTag`，让加载器的 ESM 互操作判定与内置插件一致。
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React

    /** 客户端的本地镜像键；宿主配置文件才是权威。 */
    const STORAGE_KEY = 'dsh-computer-use/settings'
    const MODES = [
      { id: 'auto', label: '全自动', hint: '有需求就直接操作电脑' },
      { id: 'ask', label: '需要询问', hint: '每次操作前弹审批，允许一次才执行' },
      { id: 'off', label: '禁用', hint: '完全关闭，子代理也不可用' },
    ]

    /**
     * 读本地镜像（宿主配置的缓存，用于渲染当前选中项）。
     * 容错优先：localStorage 可能被禁用或内容损坏，任何异常都退回默认值。
     */
    function readLocal() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (raw === null) return { mode: 'auto', allowSubagents: false }
        const parsed = JSON.parse(raw)
        return {
          mode: MODES.some((item) => item.id === parsed?.mode) ? parsed.mode : 'auto',
          allowSubagents: parsed?.allowSubagents === true,
        }
      } catch {
        return { mode: 'auto', allowSubagents: false }
      }
    }

    function writeLocal(settings) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
      } catch {
        /* 无痕模式等场景写不进去：忽略，不影响下单次会话的使用 */
      }
    }

    /** 组装一条设置命令。两个字段一起提交，避免两次写盘之间出现中间态。 */
    function commandLine(settings) {
      return `/computer-use mode=${settings.mode} subagents=${settings.allowSubagents ? 'on' : 'off'}`
    }

    const styles = {
      button: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        height: '28px',
        padding: '0 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.14))',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      panel: {
        position: 'absolute',
        bottom: 'calc(100% + 8px)',
        left: 0,
        zIndex: 40,
        width: '288px',
        padding: '10px',
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.14))',
        background: 'var(--dsw-menu-surface-fill, var(--dsw-alias-bg-layer-2, #262a33))',
        boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
        color: 'inherit',
        fontSize: '12px',
        lineHeight: '1.5',
      },
      sectionTitle: { opacity: 0.6, fontSize: '11px', margin: '2px 0 6px' },
      row: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        padding: '6px 8px',
        borderRadius: '8px',
        cursor: 'pointer',
      },
      option: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '8px', cursor: 'pointer' },
      mark: { width: '14px', display: 'inline-block', opacity: 0.9 },
      hint: { opacity: 0.55, marginLeft: '22px', fontSize: '11px' },
      error: { marginTop: '8px', color: 'var(--dsw-alias-state-error-primary, #f25a5a)', fontSize: '11px' },
      divider: { height: '1px', background: 'var(--dsw-alias-border-l1, rgba(255,255,255,0.12))', margin: '8px 0' },
      title: { fontWeight: 600, marginBottom: '2px' },
    }

    /**
     * 输入框那一行的「电脑操控」按钮 + 设置菜单。
     * @param props.submit 提交命令并返回是否被宿主接受（由 slot inject 注入）
     */
    function ComputerUseSettings(props) {
      const [settings, setSettings] = useState(readLocal)
      const [open, setOpen] = useState(false)
      const [error, setError] = useState('')
      const [pending, setPending] = useState(false)
      const rootRef = useRef(null)

      // 点空白处 / Esc 关闭菜单：这是浮层的基本礼貌，否则它会一直盖着输入框。
      useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('mousedown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      const commit = useCallback(
        async (next) => {
          setPending(true)
          setError('')
          try {
            const accepted = await props.submit(commandLine(next))
            if (accepted !== true) {
              setError('宿主没有接受这次设置（/computer-use 命令不可用），设置未生效。')
              return
            }
            // 宿主已写盘并立即生效；本地镜像只是为了让界面显示得对。
            setSettings(next)
            writeLocal(next)
          } catch (caught) {
            setError(`设置失败：${caught && caught.message ? caught.message : String(caught)}`)
          } finally {
            setPending(false)
          }
        },
        [props],
      )

      const mode = MODES.find((item) => item.id === settings.mode) ?? MODES[0]
      const label = `电脑操控：${mode.label}`

      const children = [
        h('div', { key: 'title', style: styles.title }, '电脑操控'),
        h(
          'div',
          { key: 'subnote', style: styles.hint },
          settings.mode === 'off' ? '当前已禁用，子代理同样不可用' : '控制模型能否操作用户的鼠标键盘',
        ),
        h('div', { key: 'divider', style: styles.divider }),
        h(
          'div',
          {
            key: 'subagents',
            style: styles.row,
            role: 'button',
            onClick: () => void commit({ ...settings, allowSubagents: !settings.allowSubagents }),
          },
          h('span', null, '允许子代理调用'),
          h('span', { style: { opacity: 0.8 } }, settings.allowSubagents ? '已开启' : '已关闭'),
        ),
        h('div', { key: 'modespace', style: styles.sectionTitle }, '问一下还是直接做'),
        ...MODES.map((item) =>
          h(
            'div',
            {
              key: item.id,
              style: styles.option,
              role: 'radio',
              'aria-checked': settings.mode === item.id,
              onClick: () => {
                if (settings.mode === item.id) return
                void commit({ ...settings, mode: item.id })
              },
            },
            h('span', { style: styles.mark }, settings.mode === item.id ? '●' : '○'),
            h('span', { style: { fontWeight: settings.mode === item.id ? 600 : 400 } }, item.label),
          ),
        ),
        h('div', { key: 'modehint', style: styles.hint }, mode.hint),
        error === '' ? null : h('div', { key: 'error', style: styles.error }, error),
      ].filter((node) => node !== null)

      return h(
        'div',
        { ref: rootRef, style: { position: 'relative', display: 'inline-flex' } },
        h(
          'button',
          {
            type: 'button',
            style: { ...styles.button, opacity: pending ? 0.6 : 1 },
            title: '电脑操控设置',
            'aria-expanded': open,
            onClick: () => setOpen((value) => !value),
          },
          h('span', { 'aria-hidden': 'true' }, '🖱'),
          h('span', null, label),
        ),
        open ? h('div', { style: styles.panel, role: 'dialog', 'aria-label': '电脑操控设置' }, children) : null,
      )
    }

    /** cordis 服务注入：slot 注册需要 slots，提交命令需要 sessions。 */
    const inject = ['slots', 'sessions']

    /**
     * 客户端插件入口。
     * @param ctx 客户端 cordis 上下文
     */
    function apply(ctx) {
      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'computer-use',
            // 与内置的 permission / plan 芯片同侧、紧邻其后（list 槽按 order 升序）。
            order: 0,
            inject: (sessionId) => ({
              submit: async (line) => {
                const session = ctx.sessions.binding(sessionId)?.session
                if (session === undefined) return false
                const result = await session.command(line)
                return result.ok === true && result.value.matched === true
              },
            }),
          },
          ComputerUseSettings,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.ComputerUseSettings = ComputerUseSettings
    return module.exports
  },
})
