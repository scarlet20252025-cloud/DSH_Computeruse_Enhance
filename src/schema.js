/**
 * 参数校验：DSH `dsh-tools` 注册表只接受**原始 JSON Schema 子集**
 * （`type` / `oneOf` / `properties` / `required` / `additionalProperties` /
 * `items` / `enum` / `const` + 注解），且注册时会对 `output.schema` 做
 * `assertSupportedJsonSchema`。本插件不走 `defineTool`（`@deepseek-ai/dsh-tools`
 * 在插件侧不可解析，见 README「为什么不用 defineTool」），所以自己实现同一套
 * 子集语义的校验器，错误文案也对齐 DSH 的 `invalid arguments: ...` 形态。
 *
 * 与 DSH 的一处**有意差异**：模型经 MCP/原生函数调用传来的参数常把数字写成字符串
 * （`"3"`）或把布尔写成 `"true"`。DSH 内置工具是严格拒绝，我们先做一次
 * `coerceArgs` 宽化再校验，只在无法无损转换时才报错——Computer Use 的动作参数
 * 多、一次误报就要重跑一整轮，宽化收益远大于风险。
 */

/** 可声明的基础类型。 */
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null'])

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function typeOfValue(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * 把声明为 number/integer/boolean 的字符串参数宽化回真实类型。
 * 不修改入参对象；不可无损转换的值原样保留，交给校验器报错。
 */
export function coerceArgs(schema, args) {
  if (!isPlainObject(schema) || !isPlainObject(args)) return args
  const properties = isPlainObject(schema.properties) ? schema.properties : undefined
  if (properties === undefined) return args
  let changed = false
  const out = { ...args }
  for (const [key, value] of Object.entries(args)) {
    const node = properties[key]
    if (!isPlainObject(node) || typeof value !== 'string') continue
    const type = node.type
    if (type === 'number' || type === 'integer') {
      if (value.trim() === '') continue
      const num = Number(value)
      if (!Number.isFinite(num)) continue
      if (type === 'integer' && !Number.isInteger(num)) continue
      out[key] = num
      changed = true
      continue
    }
    if (type === 'boolean') {
      const lower = value.trim().toLowerCase()
      if (lower !== 'true' && lower !== 'false') continue
      out[key] = lower === 'true'
      changed = true
    }
  }
  return changed ? out : args
}

/**
 * 校验一个值是否落在 schema 描述的子集内。
 *
 * 语义与文案**逐字对齐**官方 `validateJsonSchemaValue`
 * （`@deepseek-ai/dsh-tools`：`"<path>" must be a string`、
 * `missing required property "<path>"`、`"<path>" must match exactly one oneOf branch (matched N)`、
 * `"<path>" is not a declared property (additionalProperties: false)`），
 * 根路径标签为 `arguments`。测试里用官方实现跑同一批用例做等价性交叉验证。
 * @returns 违规说明数组；空数组表示通过。
 */
export function validateArgs(schema, value, path = '') {
  const violations = []
  checkNode(schema, value, path, violations)
  return violations
}

/** 根路径显示为 `arguments`（官方 `diagnosticPath`）。 */
function diagnosticPath(path) {
  return path === '' ? 'arguments' : path
}

/** 子路径拼接（官方 `propertyPath`）。 */
function propertyPath(path, key) {
  return path === '' ? key : `${path}.${key}`
}

function scalarMatches(type, value) {
  if (type === 'null') return value === null
  if (type === 'string') return typeof value === 'string'
  if (type === 'boolean') return typeof value === 'boolean'
  // 官方把「不是 number」与「不是有限 number」分成两条消息，所以这里必须先只判 typeof。
  if (type === 'number') return typeof value === 'number'
  if (type === 'integer') return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
  return false
}

/** 官方对 number 的第二段校验：`!isJsonNumber` → 非有限值。 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function checkNode(schema, value, path, violations) {
  if (!isPlainObject(schema)) return
  const label = diagnosticPath(path)
  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter(
      (branch) => validateArgs(branch, value, path).length === 0,
    ).length
    if (matched !== 1) {
      violations.push(`"${label}" must match exactly one oneOf branch (matched ${matched})`)
    }
    return
  }
  const type = schema.type
  if (typeof type !== 'string') return

  // 标量：先类型，再 enum/const（官方 checkScalarValue 只在标量分支调用，
  // 因此 object/array 上的 enum/const 会被忽略——这里保持一致）。
  if (SCALAR_TYPES.has(type)) {
    if (!scalarMatches(type, value)) {
      violations.push(`"${label}" must be ${scalarTypeArticle(type)}${type}`)
      return
    }
    if (type === 'number' && !isFiniteNumber(value)) {
      violations.push(`"${label}" must be a finite JSON number`)
      return
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      violations.push(`"${label}" must be one of ${JSON.stringify(schema.enum)}`)
      return
    }
    if (Object.hasOwn(schema, 'const') && value !== schema.const) {
      violations.push(`"${label}" must be ${JSON.stringify(schema.const)}`)
    }
    return
  }

  if (type === 'array') {
    if (!Array.isArray(value)) {
      violations.push(`"${label}" must be an array`)
      return
    }
    if (isPlainObject(schema.items)) {
      value.forEach((entry, index) => {
        checkNode(schema.items, entry, `${path}[${index}]`, violations)
      })
    }
    return
  }

  if (type === 'object') {
    if (!isPlainObject(value)) {
      violations.push(`"${label}" must be an object`)
      return
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {}
    // 顺序与官方一致：required → 逐属性子校验（properties 声明序）→ additionalProperties 尾部。
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key !== 'string') continue
        if (!Object.hasOwn(value, key) || value[key] === undefined) {
          violations.push(`missing required property "${propertyPath(path, key)}"`)
        }
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) continue
      checkNode(child, value[key], propertyPath(path, key), violations)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (Object.hasOwn(properties, key)) continue
        violations.push(`"${propertyPath(path, key)}" is not a declared property (additionalProperties: false)`)
      }
    }
  }
}

/** 官方文案里的冠词：a string / an integer / a number… */
function scalarTypeArticle(type) {
  return type === 'integer' ? 'an ' : 'a '
}

/** 校验失败时抛出与 DSH 同形的参数错误。 */
export function assertArgs(schema, args) {
  const violations = validateArgs(schema, args)
  if (violations.length === 0) return args
  throw new Error(`invalid arguments: ${violations.join('; ')}`)
}

/* ------------------------------------------------------------------ *
 * schema 构造助手：让工具表读起来像声明而不是嵌套字面量
 * ------------------------------------------------------------------ */

/** 声明一个对象根参数 schema。 */
export function objectSchema(properties, required = []) {
  const schema = { type: 'object', properties, additionalProperties: false }
  const declared = required.filter((key) => Object.hasOwn(properties, key))
  if (declared.length > 0) schema.required = declared
  return schema
}

/** 字符串参数。 */
export function str(description, extra) {
  return { type: 'string', description, ...extra }
}

/** 整数参数。 */
export function int(description, extra) {
  return { type: 'integer', description, ...extra }
}

/** 布尔参数。 */
export function bool(description, extra) {
  return { type: 'boolean', description, ...extra }
}

/** 枚举参数（字符串）。 */
export function enumOf(values, description, extra) {
  return { type: 'string', enum: values, description, ...extra }
}

/** 输出 schema：所有工具都返回 `{ text, ... }`，text 是模型面信封。 */
export function textOutputSchema(properties = {}) {
  return {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Model-facing result envelope.' },
      ...properties,
    },
    required: ['text'],
    additionalProperties: true,
  }
}

/**
 * 把工具返回值清洗成**无损 JSON**。
 *
 * 为什么必须有这一步：DSH 的执行器会校验工具返回值，含 `undefined` 的对象会被拒，
 * 整次调用变成失败结果——即使副作用已经真实发生。真机验证时踩到的原样报错：
 *
 *     Error: tool "left_click" returned invalid output: value is not lossless JSON
 *
 * 起因是点击结果里有 `app: undefined` / `state_id: undefined`（后端在坐标点击路径上
 * 根本不返回这两个字段）。这类「可选字段缺席」遍布各工具，所以清洗放在唯一收口处
 * （index.js 的注册包装层），而不是逐个 handler 打补丁。
 *
 * 规则：对象里值为 `undefined`/函数/symbol 的键直接丢弃；数组里的这类元素变 `null`
 * （保位，避免渲染下标错位）；顶层若不是 JSON 值则退化成 `{}`。
 * `null` 保留——它是合法 JSON，且语义上表示「明确为空」。
 */
export function toLosslessJson(value) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map((entry) => toLosslessJson(entry))
  if (type !== 'object') return undefined
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    const cleaned = toLosslessJson(entry)
    if (cleaned === undefined) continue
    out[key] = cleaned
  }
  return out
}
