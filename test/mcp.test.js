import assert from 'node:assert/strict'
import test from 'node:test'

import { createMcpHandler } from '../src/mcp/server.js'

/** 假内核：把 MCP 外壳和真实检索解耦，单测只验协议行为。 */
function fakeKb() {
  return {
    async search(query) {
      if (query === 'empty') return []
      return [
        {
          score: 0.9,
          chunk: { title: '示例页', source: 'a.md', section: '内存', text: `命中：${query}` }
        }
      ]
    },
    async status() {
      return '索引：100 块 / 模型 test'
    },
    async docs(limit) {
      return [{ path: 'a.md', chunks: 3 }].slice(0, limit)
    },
    ingest(options) {
      if (options?.sources?.length === 0) return { started: false, reason: '没有指定 sources' }
      return { started: true, sources: options?.sources ?? ['默认目录'] }
    }
  }
}

test('initialize 返回协议版本和服务器信息', async () => {
  const handle = createMcpHandler({ kb: fakeKb() })
  const response = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.equal(response.id, 1)
  assert.equal(response.result.protocolVersion, '2024-11-05')
  assert.equal(response.result.serverInfo.name, 'dsh-local-kb')
  assert.ok(response.result.capabilities.tools)
})

test('tools/list 暴露四个工具', async () => {
  const handle = createMcpHandler({ kb: fakeKb() })
  const response = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const names = response.result.tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, ['kb_docs', 'kb_ingest', 'kb_search', 'kb_status'])
})

test('tools/call 调 kb_search 返回文本内容', async () => {
  const handle = createMcpHandler({ kb: fakeKb() })
  const response = await handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'kb_search', arguments: { query: '内存' } }
  })
  assert.equal(response.result.isError, false)
  assert.equal(response.result.content[0].type, 'text')
  assert.ok(response.result.content[0].text.includes('命中：内存'))
})

test('kb_search 没有结果时不是错误', async () => {
  const handle = createMcpHandler({ kb: fakeKb() })
  const response = await handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'kb_search', arguments: { query: 'empty' } }
  })
  assert.equal(response.result.isError, false)
  assert.ok(response.result.content[0].text.includes('没有找到'))
})

test('kb_search 缺参数时标记 isError', async () => {
  const handle = createMcpHandler({ kb: fakeKb() })
  const response = await handle({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'kb_search', arguments: {} }
  })
  assert.equal(response.result.isError, true)
})

test('未知方法返回 -32601', async () => {
  const handle = createMcpHandler({ kb: fakeKb() })
  const response = await handle({ jsonrpc: '2.0', id: 6, method: 'nope/method' })
  assert.equal(response.error.code, -32601)
})

test('通知（没有 id）不产生响应', async () => {
  const handle = createMcpHandler({ kb: fakeKb() })
  const response = await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(response, null)
})

test('业务异常被包成 isError 而不是协议错误', async () => {
  const handle = createMcpHandler({
    kb: {
      ...fakeKb(),
      async status() {
        throw new Error('索引损坏')
      }
    }
  })
  const response = await handle({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'kb_status', arguments: {} }
  })
  assert.equal(response.result.isError, true)
  assert.ok(response.result.content[0].text.includes('索引损坏'))
})
