/**
 * MCP 服务（stdio）：把同一套知识库内核暴露给任何 MCP 客户端
 * （Claude Desktop、Cursor、其他 harness 等）。
 *
 * 传输：stdio，一行一个 JSON-RPC 2.0 消息；日志一律写 stderr，
 * 绝不能污染 stdout —— 那是协议通道。
 */

import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'

import { createKnowledgeBase } from '../core.js'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json')

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_NAME = 'dsh-local-kb'

const TOOLS = [
  {
    name: 'kb_search',
    description:
      '在本地知识库里检索资料。当你需要确认某个事实、规格或文档细节，而它可能收录在本地资料里时使用。' +
      '返回命中的片段、相似度和来源文件。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的问题或关键词' },
        topK: { type: 'integer', minimum: 1, maximum: 50, description: '返回几条（默认用配置值）' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'kb_ingest',
    description:
      '把目录里的 Markdown/文本文件建进本地知识库索引（后台执行，本工具只负责启动）。' +
      '用 kb_status 看进度。',
    inputSchema: {
      type: 'object',
      properties: {
        sources: { type: 'array', items: { type: 'string' }, description: '要索引的目录或文件（绝对路径）' },
        full: { type: 'boolean', description: 'true = 忽略旧索引全部重嵌' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'kb_status',
    description: '查看本地知识库索引状态：块数、文档数、模型、最后构建时间，以及索引任务进度。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'kb_docs',
    description: '列出已索引的文档（路径与块数），用于确认某份资料到底有没有进库。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 2000, description: '最多列多少篇，默认 50' }
      },
      additionalProperties: false
    }
  }
]

function formatHits(hits) {
  if (!hits.length) return '没有找到相关内容'
  return hits
    .map((hit, index) => {
      const { title, source, section, text } = hit.chunk
      const label = section && section !== title ? `${title || source} · ${section}` : title || section || source
      const snippet = String(text).replace(/\s+/g, ' ').slice(0, 400)
      return `${index + 1}. [${hit.score.toFixed(3)}] ${label}\n   ${snippet}`
    })
    .join('\n\n')
}

/**
 * 纯函数式处理器，方便单测直接喂 JSON-RPC 消息。
 * @param {{ kb: ReturnType<typeof createKnowledgeBase>, logger?: object }} options
 */
export function createMcpHandler({ kb, logger = {} }) {
  async function callTool(name, args = {}) {
    if (name === 'kb_search') {
      const query = String(args.query ?? '').trim()
      if (!query) return { isError: true, text: 'query 不能为空' }
      const hits = await kb.search(query, Number.isFinite(args.topK) ? { topK: args.topK } : {})
      return { isError: false, text: formatHits(hits) }
    }

    if (name === 'kb_ingest') {
      const result = kb.ingest({ sources: args.sources, full: Boolean(args.full) })
      if (!result.started) return { isError: true, text: result.reason }
      return { isError: false, text: `已开始建索引：${result.sources.join(', ')}（用 kb_status 查进度）` }
    }

    if (name === 'kb_status') {
      return { isError: false, text: await kb.status() }
    }

    if (name === 'kb_docs') {
      const docs = await kb.docs(Number.isFinite(args.limit) ? args.limit : 50)
      if (!docs.length) return { isError: false, text: '索引里还没有文档' }
      const lines = docs.map((doc, index) => `${index + 1}. ${doc.path}（${doc.chunks} 块）`)
      return { isError: false, text: lines.join('\n') }
    }

    return { isError: true, text: `未知工具：${name}` }
  }

  return async function handle(message) {
    const { id, method, params } = message ?? {}

    if (method === 'initialize') {
      return {
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: pkg.version }
        }
      }
    }

    if (method === 'ping') {
      return { id, result: {} }
    }

    if (method === 'tools/list') {
      return { id, result: { tools: TOOLS } }
    }

    if (method === 'tools/call') {
      const name = params?.name
      const args = params?.arguments ?? {}
      try {
        const outcome = await callTool(name, args)
        return {
          id,
          result: { content: [{ type: 'text', text: outcome.text }], isError: Boolean(outcome.isError) }
        }
      } catch (error) {
        const text = `执行失败：${error?.message ?? error}`
        logger.warn?.(`dsh-local-kb(mcp): ${text}`)
        return { id, result: { content: [{ type: 'text', text }], isError: true } }
      }
    }

    // 通知类消息（没有 id）不返回任何东西
    if (id === undefined || id === null) {
      return null
    }

    return {
      id,
      error: { code: -32601, message: `不支持的方法：${String(method)}` }
    }
  }
}

/**
 * 启动 stdio MCP 服务。
 * @param {{ config?: object, logger?: object, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [options]
 */
export function startMcpServer(options = {}) {
  const { config = {}, input = process.stdin, output = process.stdout } = options
  const logger = options.logger ?? {
    info: (message) => process.stderr.write(`[info] ${message}\n`),
    warn: (message) => process.stderr.write(`[warn] ${message}\n`),
    debug: () => {}
  }

  const kb = createKnowledgeBase(config, logger)
  const handle = createMcpHandler({ kb, logger })

  const send = (payload) => {
    if (!payload) return
    output.write(`${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`)
  }

  const rl = createInterface({ input, crlfDelay: Infinity })
  rl.on('line', async (line) => {
    const text = line.trim()
    if (!text) return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      send({ id: null, error: { code: -32700, message: 'JSON 解析失败' } })
      return
    }
    const response = await handle(message)
    send(response)
  })

  logger.info?.(`dsh-local-kb(mcp): 已就绪（${SERVER_NAME} ${pkg.version}，协议 ${PROTOCOL_VERSION}）`)
  return { kb, handle, close: () => rl.close() }
}
