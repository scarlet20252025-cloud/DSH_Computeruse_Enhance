/**
 * 参数校验与 schema 构造。
 *
 * 本文件的重点是**与官方实现等价**：`tools/ref-extract-validator.mjs` 提取出的
 * `@deepseek-ai/dsh-tools` 提供真正的 `validateJsonSchemaValue`，
 * 我们用它跑同一批输入，逐字比较违规文案。这样「插件自带的校验器会不会比
 * 注册表更宽或更严」这件事由官方实现自己回答，而不是我自己写期望值自证。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assertArgs, bool, coerceArgs, enumOf, int, objectSchema, str, validateArgs } from '../src/schema.js'
import { createToolDefinitions } from '../src/tools.js'
import { createFakeRuntime, refAvailable, loadDshPackage, UPSTREAM_TOOL_NAMES } from './helpers.mjs'

test('validateArgs 覆盖常用子集：required / 类型 / 枚举 / additionalProperties', () => {
  const schema = objectSchema(
    {
      name: str('名字'),
      count: int('数量'),
      mode: enumOf(['a', 'b'], '模式'),
      flag: bool('开关'),
    },
    ['name'],
  )

  assert.deepEqual(validateArgs(schema, { name: 'x' }), [])
  assert.deepEqual(validateArgs(schema, { name: 'x', count: 3, mode: 'a', flag: true }), [])
  assert.deepEqual(validateArgs(schema, {}), ['missing required property "name"'])
  assert.deepEqual(validateArgs(schema, { name: 1 }), ['"name" must be a string'])
  assert.deepEqual(validateArgs(schema, { name: 'x', count: 1.5 }), ['"count" must be an integer'])
  assert.deepEqual(validateArgs(schema, { name: 'x', mode: 'c' }), ['"mode" must be one of ["a","b"]'])
  assert.deepEqual(validateArgs(schema, { name: 'x', nope: 1 }), [
    '"nope" is not a declared property (additionalProperties: false)',
  ])
})

test('validateArgs 支持 oneOf 的「恰好一个分支」语义', () => {
  const schema = objectSchema({
    app: {
      oneOf: [
        { type: 'string' },
        { type: 'object', properties: { pid: int('pid') }, additionalProperties: true },
      ],
    },
  })
  assert.deepEqual(validateArgs(schema, { app: 'notepad' }), [])
  assert.deepEqual(validateArgs(schema, { app: { pid: 12 } }), [])
  assert.deepEqual(validateArgs(schema, { app: true }), [
    '"app" must match exactly one oneOf branch (matched 0)',
  ])
})

test('validateArgs 递归进入 object / array，且顺序与官方一致', () => {
  const schema = objectSchema({
    region: { type: 'object', properties: { width: int('w') }, required: ['width'], additionalProperties: false },
    args: { type: 'array', items: { type: 'string' } },
  })
  assert.deepEqual(validateArgs(schema, { region: { width: 10 }, args: ['a'] }), [])
  assert.deepEqual(validateArgs(schema, { region: {} }), ['missing required property "region.width"'])
  assert.deepEqual(validateArgs(schema, { args: [1] }), ['"args[0]" must be a string'])
  assert.deepEqual(validateArgs(schema, { region: { width: 10, extra: 1 }, args: [] }), [
    '"region.extra" is not a declared property (additionalProperties: false)',
  ])
})

test('coerceArgs 只做无损宽化，不动其它字段（有意的上游差异）', () => {
  const schema = objectSchema({ x: int('x'), y: int('y'), flag: bool('f'), text: str('t') })
  const coerced = coerceArgs(schema, { x: '12', y: 3.5, flag: 'true', text: '7' })
  assert.equal(coerced.x, 12)
  assert.equal(coerced.y, 3.5, '非整数不宽化，留给校验器报错')
  assert.equal(coerced.flag, true)
  assert.equal(coerced.text, '7', '字符串字段保持字符串')
  assert.equal(coerceArgs(schema, { x: 'abc' }).x, 'abc')
})

test('assertArgs 抛出的文案与 DSH 同形', () => {
  const schema = objectSchema({ x: int('x') }, ['x'])
  assert.throws(() => assertArgs(schema, {}), /^Error: invalid arguments: missing required property "x"$/u)
})

test('全部工具定义的 parameters 与 output.schema 都通过官方子集断言', async (t) => {
  if (!refAvailable()) {
    t.skip('run `node tools/ref-extract-validator.mjs` to enable the official validator cross-check')
    return
  }
  const tools = await loadDshPackage('@deepseek-ai/dsh-tools')
  const runtime = createFakeRuntime()
  const { native, single } = createToolDefinitions(runtime)
  assert.equal(native.length, UPSTREAM_TOOL_NAMES.length)
  for (const definition of [...native, single.definition]) {
    tools.assertSupportedJsonSchema(definition.parameters)
    tools.assertObjectJsonSchema(definition.parameters)
    tools.assertSupportedJsonSchema(definition.output.schema)
  }
})

test('我们的校验器与官方 validateJsonSchemaValue 行为逐字一致', async (t) => {
  if (!refAvailable()) {
    t.skip('official validator not extracted')
    return
  }
  const tools = await loadDshPackage('@deepseek-ai/dsh-tools')

  // 手工构造的对照 schema（覆盖标量/枚举/常量/数组/嵌套对象/oneOf/额外属性）。
  const ours = objectSchema(
    {
      name: str('name'),
      count: int('count'),
      ratio: { type: 'number', description: 'ratio' },
      flag: bool('flag'),
      mode: enumOf(['a', 'b'], 'mode'),
      tags: { type: 'array', items: { type: 'string' }, description: 'tags' },
      nested: {
        type: 'object',
        properties: { depth: int('depth') },
        required: ['depth'],
        additionalProperties: false,
      },
      choice: {
        oneOf: [{ type: 'string' }, { type: 'integer' }],
      },
    },
    ['name'],
  )
  const official = structuredClone(ours)

  const cases = [
    {},
    { name: 'x' },
    { name: 1 },
    { name: 'x', count: '1' },
    { name: 'x', count: 1.5 },
    { name: 'x', ratio: 'nope' },
    { name: 'x', ratio: Number.NaN },
    { name: 'x', flag: 'true' },
    { name: 'x', mode: 'c' },
    { name: 'x', mode: 'a' },
    { name: 'x', tags: 'nope' },
    { name: 'x', tags: [1, 'ok'] },
    { name: 'x', nested: {} },
    { name: 'x', nested: { depth: 2, extra: 1 } },
    { name: 'x', nested: 7 },
    { name: 'x', choice: 3 },
    { name: 'x', choice: 'str' },
    { name: 'x', choice: null },
    { name: 'x', unknown: true },
    { name: 'x', count: 1, mode: 'b', nested: { depth: 1 } },
  ]

  for (const args of cases) {
    const officialViolations = tools.validateJsonSchemaValue(official, args, '')
    const ourViolations = validateArgs(ours, args)
    assert.deepEqual(
      ourViolations,
      officialViolations,
      `mismatch for ${JSON.stringify(args)}`,
    )
  }
})

test('用官方 defineTool 定义的同形工具，其 parameters 与我们的产物一致', async (t) => {
  if (!refAvailable()) {
    t.skip('official validator not extracted')
    return
  }
  const tools = await loadDshPackage('@deepseek-ai/dsh-tools')
  const official = tools.defineTool({
    name: 'probe',
    description: 'probe',
    parameters: {
      x: { type: 'integer', required: true },
      mode: { type: 'string', enum: ['a', 'b'] },
    },
    output: { schema: { type: 'string' }, render: () => [] },
    execute: async () => 'ok',
  })
  const ours = objectSchema({ x: int('x'), mode: enumOf(['a', 'b'], 'mode') }, ['x'])
  assert.deepEqual(ours.properties.x.type, official.parameters.properties.x.type)
  assert.deepEqual(ours.properties.mode.enum, official.parameters.properties.mode.enum)
  assert.deepEqual(ours.required, official.parameters.required)
})
