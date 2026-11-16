#!/usr/bin/env node
/**
 * MCP 端到端冒烟：真的把 server 当子进程拉起来，按 JSON-RPC 对话。
 *
 * 用法：
 *   node scripts/mcp-smoke.mjs
 *
 * 需要索引已经建好（KB_INDEX_DIR 或默认 index-data）；没有索引时只验协议，
 * kb_search 会如实返回 "索引不存在"，脚本会提示这一点而不是假装通过。
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const server = join(here, 'mcp-server.mjs')

const child = spawn(process.execPath, [server], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env }
})

let buffer = ''
const pending = new Map()
let nextId = 1

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      console.log(`⚠️  收到非 JSON 输出：${line.slice(0, 80)}`)
      continue
    }
    const resolver = pending.get(message.id)
    if (resolver) {
      pending.delete(message.id)
      resolver(message)
    }
  }
})

child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => {
  for (const line of chunk.split('\n')) {
    if (line.trim()) console.log(`  [server] ${line.trim()}`)
  }
})

function request(method, params) {
  const id = nextId++
  const payload = { jsonrpc: '2.0', id, method, params }
  child.stdin.write(`${JSON.stringify(payload)}\n`)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 30000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      resolve(message)
    })
  })
}

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ${message}`)
    child.kill()
    process.exit(1)
  }
  console.log(`✅ ${message}`)
}

try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-smoke', version: '0.0.1' }
  })
  assert(init.result?.serverInfo?.name === 'dsh-local-kb', `initialize 正常（${init.result?.serverInfo?.version}）`)

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

  const list = await request('tools/list', {})
  const names = (list.result?.tools ?? []).map((tool) => tool.name).sort()
  assert(names.length === 4, `tools/list 返回 4 个工具：${names.join(', ')}`)

  const status = await request('tools/call', { name: 'kb_status', arguments: {} })
  const statusText = status.result?.content?.[0]?.text ?? ''
  assert(statusText.length > 0, 'kb_status 返回了状态文本')
  console.log('  ' + statusText.split('\n').join('\n  '))

  const hasIndex = statusText.includes('索引：')
  const search = await request('tools/call', { name: 'kb_search', arguments: { query: '内存最高支持多大' } })
  const searchText = search.result?.content?.[0]?.text ?? ''
  if (hasIndex) {
    assert(search.result?.isError === false, 'kb_search 调用没有报错')
    assert(searchText.length > 0, `kb_search 有输出：${searchText.split('\n')[0]}`)
  } else {
    // 没有索引时，工具应该如实报错而不是假装查到了什么
    assert(search.result?.isError === true, '没有索引时 kb_search 如实返回错误')
    assert(searchText.includes('索引不存在'), `错误信息可执行：${searchText}`)
  }

  const ping = await request('ping', {})
  assert(ping.result !== undefined, 'ping 正常')

  console.log('\nMCP 冒烟通过')
} finally {
  child.kill()
}
