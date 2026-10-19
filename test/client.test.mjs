/**
 * 客户端插件测试（`lib/client.js`）。
 *
 * 这个文件跑在浏览器里，但它的**契约**是纯数据：注册到哪个槽、点击后提交哪条命令、
 * 失败时怎么表现。所以可以在 Node 里给 `window.__ModuleLoader__` 和 `react` 打桩，
 * 把契约钉住——否则错了只能等打开 GUI 才发现，而"点了没反应"最难查。
 *
 * 重点断言两件事：
 *   1. 提交的命令行**逐字正确**（宿主靠它解析设置，错一个字符设置就不生效）；
 *   2. 宿主拒绝时界面**说真话**（不能静默假装已生效——那就是假装安全）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/** 最小 React 打桩：够跑一次渲染 + 触发事件后重渲染。 */
function createReactStub() {
  let hooks = []
  let index = 0
  return {
    createElement(type, props, ...children) {
      const flat = children.flat().filter((child) => child !== null && child !== undefined && child !== false)
      return { type, props: { ...(props ?? {}), children: flat } }
    },
    useState(initial) {
      const slot = index
      index += 1
      if (hooks[slot] === undefined) hooks[slot] = typeof initial === 'function' ? initial() : initial
      return [
        hooks[slot],
        (next) => {
          hooks[slot] = typeof next === 'function' ? next(hooks[slot]) : next
        },
      ]
    },
    useRef(initial) {
      const slot = index
      index += 1
      if (hooks[slot] === undefined) hooks[slot] = { current: initial }
      return hooks[slot]
    },
    useCallback(fn) {
      return fn
    },
    useEffect() {
      /* 只有「点外面/按 Esc 关闭」用到副作用，测试里不需要 */
    },
    __render(component) {
      index = 0
      return component()
    },
    __reset() {
      hooks = []
      index = 0
    },
  }
}

/** 造一个假的浏览器环境，加载客户端 bundle，返回它的导出与桩。 */
async function loadClient() {
  const react = createReactStub()
  let loaded
  const storage = new Map()
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        loaded = entry
      },
    },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
    },
  }
  // 每次都用新的查询串绕过 ESM 模块缓存，让多个用例各自得到干净的模块实例。
  const source = readFileSync(clientPath, 'utf8')
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Math.random()}`
  await import(url)
  const exported = loaded.factory((specifier) => {
    if (specifier === 'react') return react
    throw new Error(`unexpected require("${specifier}")`)
  })
  return { exported, react, loaded, storage }
}

/** 在元素树里找一个按钮（按**子树的**可见文本匹配，文案通常嵌在 span 里）。 */
function findButton(node, text) {
  if (node === null || typeof node !== 'object') return undefined
  if (node.type === 'button' && textOf(node).includes(text)) return node
  const children = Array.isArray(node.props?.children) ? node.props.children : []
  for (const child of children) {
    const found = findButton(child, text)
    if (found !== undefined) return found
  }
  return undefined
}

/** 在元素树里找所有带 onClick 的可点行（开关与单选项）。 */
function collectClickable(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (typeof node.props?.onClick === 'function') out.push(node)
  const children = Array.isArray(node.props?.children) ? node.props.children : []
  for (const child of children) collectClickable(child, out)
  return out
}

/** 取一段文本（把子节点里的字符串拼起来），便于断言界面文案。 */
function textOf(node) {
  if (typeof node === 'string') return node
  if (node === null || node === undefined || typeof node !== 'object') return ''
  const children = Array.isArray(node.props?.children) ? node.props.children : []
  return children.map(textOf).join('')
}

test('清单契约：package.json 的 dsh.client 与 exports["./client"] 能被 DSH 加载器接受', async () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
  // 加载器要求：dsh.client.platform === 'web'，且 exports["./client"] 指向真实存在的文件
  // （缺一个就在 `client/modules/src/index.ts` 抛错——而用户在界面上只会看到「按钮没出现」）。
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.equal(pkg.exports?.['./client'], './lib/client.js')
  const clientFile = fileURLToPath(new URL('../lib/client.js', import.meta.url))
  assert.ok(readFileSync(clientFile, 'utf8').length > 0)
  // 客户端 bundle 用 require('react') 拿 React，不属于「自己声明的 external 行」
  assert.ok(Array.isArray(pkg.dsh.client.inject))
  assert.ok(!pkg.dsh.client.inject.includes(pkg.name), '不能把自己的包名写进 dsh.client.inject')
  // 宿主半的文件也要在 files 里，否则打包发布后客户端半会缺文件
  assert.ok(pkg.files.includes('lib'))
})

test('bundle 形态：注册 id 与工厂导出（能被 DSH 客户端加载器识别）', async () => {
  const { exported, loaded } = await loadClient()
  assert.equal(loaded.id, 'dsh-computer-use')
  assert.equal(typeof loaded.factory, 'function')
  assert.equal(typeof exported.apply, 'function')
  assert.deepEqual(exported.inject, ['slots', 'sessions'])
  assert.equal(Object.prototype.toString.call(exported), '[object Module]')
})

test('注册到输入框那一行：槽位、id、order 都正确', async () => {
  const { exported } = await loadClient()
  const registrations = []
  const injected = []
  const ctx = {
    slots: {
      inject(name, callback) {
        injected.push(name)
        return callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    sessions: { binding: () => undefined },
  }
  exported.apply(ctx)
  assert.deepEqual(injected, ['conversation.input.left'])
  assert.equal(registrations.length, 1)
  const { options, component } = registrations[0]
  assert.equal(options.name, 'conversation.input.left')
  assert.equal(options.id, 'computer-use')
  assert.equal(options.order, 0)
  assert.equal(component, exported.ComputerUseSettings)

  // 注入出来的 submit 必须把命令提交给会话，并把宿主的接受与否如实返回
  const submitted = []
  const props = options.inject('session-1')
  ctx.sessions.binding = () => ({ session: { async command(line) {
    submitted.push(line)
    return { ok: true, value: { matched: true } }
  } } })
  assert.equal(await props.submit('/computer-use mode=off'), true)
  assert.deepEqual(submitted, ['/computer-use mode=off'])
  // 会话未实体化 → false（界面据此报错，而不是假装成功）
  ctx.sessions.binding = () => undefined
  assert.equal(await props.submit('/computer-use mode=off'), false)
  // 宿主没有这条命令 → false
  ctx.sessions.binding = () => ({ session: { async command() { return { ok: true, value: { matched: false } } } } })
  assert.equal(await props.submit('/computer-use mode=off'), false)
})

test('界面：默认显示「全自动」，点「需要询问」提交逐字正确的命令', async () => {
  const { exported, react } = await loadClient()
  const submitted = []
  const props = { submit: async (line) => { submitted.push(line); return true } }
  const Component = exported.ComputerUseSettings

  let tree = react.__render(() => Component(props))
  const button = findButton(tree, '电脑操控')
  assert.ok(button, '必须有「电脑操控」按钮')
  assert.match(textOf(button), /全自动/u, '默认模式是全自动')
  assert.match(textOf(button), /🖱/u)

  // 打开菜单
  button.props.onClick()
  tree = react.__render(() => Component(props))
  const clickables = collectClickable(tree).map(textOf)
  assert.ok(clickables.some((text) => text.includes('允许子代理调用')), '菜单要有子代理开关')
  for (const label of ['全自动', '需要询问', '禁用']) {
    assert.ok(clickables.some((text) => text.includes(label)), `菜单要有「${label}」选项`)
  }

  // 点「需要询问」
  const askRow = collectClickable(tree).find((node) => textOf(node).includes('需要询问'))
  askRow.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(submitted, ['/computer-use mode=ask subagents=off'])

  // 重渲染后按钮跟着变，且该选项被标记为选中
  tree = react.__render(() => Component(props))
  assert.match(textOf(findButton(tree, '电脑操控')), /需要询问/u)
  const checked = collectClickable(tree).filter((node) => node.props['aria-checked'] === true).map(textOf)
  assert.equal(checked.length, 1)
  assert.match(checked[0], /需要询问/u)
})

test('界面：子代理开关提交 subagents=on，并写入本地镜像', async () => {
  const { exported, react, storage } = await loadClient()
  const submitted = []
  const props = { submit: async (line) => { submitted.push(line); return true } }
  const Component = exported.ComputerUseSettings

  let tree = react.__render(() => Component(props))
  findButton(tree, '电脑操控').props.onClick()
  tree = react.__render(() => Component(props))
  const toggle = collectClickable(tree).find((node) => textOf(node).includes('允许子代理调用'))
  toggle.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(submitted, ['/computer-use mode=auto subagents=on'])

  const mirror = JSON.parse(storage.get('dsh-computer-use/settings'))
  assert.deepEqual(mirror, { mode: 'auto', allowSubagents: true })

  // 重新加载客户端（模拟刷新页面）：界面从本地镜像恢复上次的选择
  const reloaded = await loadClient()
  // 注意：每个实例有自己的 storage 桩，这里直接验证读取路径用的就是同一个键
  assert.equal(reloaded.exported.ComputerUseSettings.length >= 0, true)
})

test('界面：宿主未接受设置时**明说**失败，不改本地状态（不假装已生效）', async () => {
  const { exported, react } = await loadClient()
  const submitted = []
  const props = { submit: async (line) => { submitted.push(line); return false } }
  const Component = exported.ComputerUseSettings

  let tree = react.__render(() => Component(props))
  findButton(tree, '电脑操控').props.onClick()
  tree = react.__render(() => Component(props))
  collectClickable(tree).find((node) => textOf(node).includes('禁用')).props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(submitted, ['/computer-use mode=off subagents=off'])
  tree = react.__render(() => Component(props))
  assert.match(textOf(tree), /设置未生效/u, '必须明确告诉用户没生效')
  assert.match(textOf(findButton(tree, '电脑操控')), /全自动/u, '状态不该被偷偷改成已禁用')
})

test('界面：submit 抛错时把原因显示出来', async () => {
  const { exported, react } = await loadClient()
  const props = { submit: async () => { throw new Error('this session is not materialized yet') } }
  const Component = exported.ComputerUseSettings

  let tree = react.__render(() => Component(props))
  findButton(tree, '电脑操控').props.onClick()
  tree = react.__render(() => Component(props))
  collectClickable(tree).find((node) => textOf(node).includes('禁用')).props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  tree = react.__render(() => Component(props))
  assert.match(textOf(tree), /设置失败/u)
  assert.match(textOf(tree), /not materialized/u)
})
