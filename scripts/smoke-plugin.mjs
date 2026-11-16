#!/usr/bin/env node
/**
 * 插件冒烟测试：不装进 DSH，用假的 ctx 把插件的真实行为跑一遍。
 *
 * 验证三件事：
 *   1. apply() 能注册工具、挂上 pre-step 钩子
 *   2. 用户提问时真的会注入检索结果
 *   3. 同一个问题在同一会话里只注入一次（去重）
 */

import { apply } from '../src/index.js'
import { resolveConfig } from '../src/config.js'

const cfg = resolveConfig({})

const handlers = new Map()
const tools = new Map()
let injectedRounds = 0

const ctx = {
  logger: {
    info: (m) => console.log(`[info] ${m}`),
    warn: (m) => console.warn(`[warn] ${m}`),
    debug: () => {}
  },
  on(event, handler) {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
  get(name) {
    if (name === 'tools') {
      return {
        register(tool) {
          tools.set(tool.name, tool)
        }
      }
    }
    return undefined
  }
}

apply(ctx, { minScore: 0.4 })

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ${message}`)
    process.exit(1)
  }
  console.log(`✅ ${message}`)
}

assert(handlers.has('agent/pre-step'), 'pre-step 钩子已挂上')
assert(tools.size === 4, `注册了 4 个工具（实际 ${tools.size}：${[...tools.keys()].join(', ')}）`)

const preStep = handlers.get('agent/pre-step')
const payload = { agent: { session: { header: { id: 'smoke-session' } } } }
const question = process.argv[2] ?? '华硕 S300TA 最高支持多大内存'
const next = async () => ({
  kind: 'enter',
  messages: [{ role: 'user', content: question }]
})

// 先探一下这份索引里到底有没有相关内容：没有就验证"不该注入"，
// 有就验证注入与去重。冒烟不该依赖特定语料。
const searchTool = tools.get('kb_search')
const probe = await searchTool.execute({ query: question })
const expectInjection = probe.ok === true && !probe.text.includes('没有找到')

const first = await preStep(payload, next)
assert(first.kind === 'enter', 'pre-step 返回值结构正确')

if (!expectInjection) {
  assert(first.messages.length === 1, '索引里没有相关内容时不注入（不打扰对话）')
  console.log('ℹ️  当前索引与示例问题无关，跳过注入断言；换用自己的语料后会走完整路径')
  process.exit(0)
}

assert(first.messages.length === 2, `注入了 1 条消息（总 ${first.messages.length} 条）`)
const injected = first.messages[1].content
assert(injected.startsWith('【本地知识库检索结果】'), '注入内容带标记前缀（便于和用户发言区分）')
assert(injected.includes('来源'), '注入内容带来源标注')
assert(injected.length > 40, `注入内容有实质内容（${injected.length} 字）`)
if (injected.includes('64GB')) console.log('  （顺带命中示例答案 64GB）')

// 同一轮里的后续 step：用户发言条数没变，不重复注入
const second = await preStep(payload, next)
assert(second.messages.length === 1, '同一轮内不重复注入')

// 新的一轮：用户又发了一句（上一轮注入的内容还在历史里）
const third = await preStep(payload, async () => ({
  kind: 'enter',
  messages: [
    { role: 'user', content: question },
    { role: 'user', content: injected },
    { role: 'user', content: '那它的电源功率呢' }
  ]
}))
assert(third.messages.length === 4, '新的一轮会重新注入（即使问题内容相似）')

const searchResult = await searchTool.execute({ query: 'S300TA 电源功率' })
assert(searchResult.ok === true, 'kb_search 执行成功')
assert(searchResult.text.length > 0, `kb_search 有输出（${searchResult.text.split('\n')[0]}）`)

const statusTool = tools.get('kb_status')
const status = await statusTool.execute({})
assert(status.text.includes('块'), 'kb_status 能报出索引状态')
console.log('\n--- kb_status ---')
console.log(status.text)
