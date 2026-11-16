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

const cfg = resolveConfig({ indexDir: 'index-data' })

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

apply(ctx, { indexDir: cfg.indexDir, minScore: 0.4 })

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ${message}`)
    process.exit(1)
  }
  console.log(`✅ ${message}`)
}

assert(handlers.has('agent/pre-step'), 'pre-step 钩子已挂上')
assert(tools.size === 3, `注册了 3 个工具（实际 ${tools.size}：${[...tools.keys()].join(', ')}）`)

const preStep = handlers.get('agent/pre-step')
const payload = { agent: { session: { header: { id: 'smoke-session' } } } }
const next = async () => ({
  kind: 'enter',
  messages: [{ role: 'user', content: '华硕 S300TA 最高支持多大内存' }]
})

const first = await preStep(payload, next)
assert(first.kind === 'enter', 'pre-step 返回值结构正确')
assert(first.messages.length === 2, `注入了 1 条消息（总 ${first.messages.length} 条）`)
const injected = first.messages[1].content
assert(injected.includes('知识库'), '注入内容带知识库说明')
assert(injected.includes('64GB'), '注入内容含正确答案 64GB')

const second = await preStep(payload, next)
assert(second.messages.length === 1, '同一会话同一问题不会重复注入')

const searchTool = tools.get('kb_search')
const searchResult = await searchTool.execute({ query: 'S300TA 电源功率' })
assert(searchResult.ok === true, 'kb_search 执行成功')
assert(searchResult.text.includes('200W'), 'kb_search 命中 200W')

const statusTool = tools.get('kb_status')
const status = await statusTool.execute({})
assert(status.text.includes('块'), 'kb_status 能报出索引状态')
console.log('\n--- kb_status ---')
console.log(status.text)
