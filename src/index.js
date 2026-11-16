/**
 * dsh-local-kb — DSH 插件外壳。
 *
 * 职责只有两件：
 *   1. 在 `agent/pre-step` 里对每条新的用户消息检索一次，把命中片段注入本轮对话；
 *   2. 注册 kb_* 工具，供模型主动查询 / 重建索引 / 看状态。
 *
 * 检索、索引、状态都委托给 core.js，跟 MCP 版共用同一套实现。
 */

import { createKnowledgeBase } from './core.js'
import { chunkId } from './store.js'

/** Cordis 插件名。 */
export const name = 'local-kb'

/** 不强制依赖任何服务：拿不到 tools 时只保留注入。 */
export const inject = []

const LOG_PREFIX = 'dsh-local-kb:'

function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message || message.role !== 'user') continue
    const content = message.content
    if (typeof content === 'string') return content.trim()
    if (Array.isArray(content)) {
      const text = content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim()
      if (text) return text
    }
    return ''
  }
  return ''
}

function sessionIdOf(payload) {
  try {
    return String(payload?.agent?.session?.header?.id ?? '')
  } catch {
    return ''
  }
}

function withTimeout(promise, ms, fallback) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function textOutput(value) {
  return [{ type: 'text', text: value?.text ?? '' }]
}

/**
 * @param {object} ctx - Cordis 插件上下文
 * @param {Record<string, unknown>} [config] - cordis.patch.yml 里的 config
 */
export function apply(ctx, config = {}) {
  const logger = ctx?.logger ?? {}
  const kb = createKnowledgeBase(config, logger)
  const cfg = kb.cfg

  // 每个会话上一次注入过的用户消息哈希，避免同一轮 step 反复注入
  const injected = new Map()

  ctx.on?.('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind !== 'enter') return decision
    if (!cfg.inject) return decision

    try {
      const question = lastUserText(decision.messages)
      if (!question || question.length < 2) return decision

      const sessionId = sessionIdOf(payload) || 'unknown'
      const fingerprint = chunkId(question)
      if (injected.get(sessionId) === fingerprint) return decision
      if (injected.size > 200) injected.clear()

      const { hits, text } = await withTimeout(kb.context(question), cfg.searchTimeoutMs, { hits: [], text: '' })
      if (!text) return decision

      injected.set(sessionId, fingerprint)
      logger.info?.(`${LOG_PREFIX} 注入 ${hits.length} 条（最高分 ${hits[0].score.toFixed(3)}，${text.length} 字）`)

      return {
        kind: 'enter',
        messages: [...decision.messages, { role: cfg.injectRole, content: text }]
      }
    } catch (error) {
      logger.warn?.(`${LOG_PREFIX} 检索失败，本轮不注入：${error?.message ?? error}`)
      return decision
    }
  })

  const tools = ctx.get?.('tools')
  if (!tools?.register) {
    logger.info?.(`${LOG_PREFIX} tools 服务不可用，仅保留自动注入`)
    return
  }

  tools.register({
    name: 'kb_search',
    description:
      '在本地知识库里检索资料。当你需要确认某个事实、规格、文档细节，而它可能收录在本地资料里时使用；' +
      '返回命中的片段、相似度和来源文件。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的问题或关键词' },
        topK: { type: 'number', description: '返回几条，默认用配置值' }
      },
      required: ['query'],
      additionalProperties: false
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        required: ['ok'],
        additionalProperties: false
      },
      render: (_args, value) => textOutput(value)
    },
    async execute(args) {
      const query = String(args?.query ?? '').trim()
      if (!query) return { ok: false, text: 'query 不能为空' }
      try {
        const hits = await kb.search(query, Number.isFinite(args?.topK) ? { topK: args.topK } : {})
        if (!hits.length) return { ok: true, text: `没有找到与「${query}」相关的内容` }
        const text = hits
          .map((hit, index) => {
            const { title, source, section, text: body } = hit.chunk
            const label = section && section !== title ? `${title || source} · ${section}` : title || section || source
            return `${index + 1}. [${hit.score.toFixed(3)}] ${label}\n   ${String(body).replace(/\s+/g, ' ').slice(0, 400)}`
          })
          .join('\n\n')
        return { ok: true, text }
      } catch (error) {
        return { ok: false, text: `检索失败：${error?.message ?? error}` }
      }
    }
  })

  tools.register({
    name: 'kb_ingest',
    description:
      '把目录里的 Markdown/文本文件建进本地知识库索引（后台执行，这个工具只负责启动）。' +
      '用 kb_status 看进度。日常对话不需要调用它。',
    parameters: {
      type: 'object',
      properties: {
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: '要索引的目录或文件（绝对路径），默认用配置里的 sources'
        },
        full: { type: 'boolean', description: 'true = 忽略旧索引全部重嵌' }
      },
      additionalProperties: false
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        required: ['ok'],
        additionalProperties: false
      },
      render: (_args, value) => textOutput(value)
    },
    async execute(args) {
      const result = kb.ingest({ sources: args?.sources, full: Boolean(args?.full) })
      if (!result.started) return { ok: false, text: result.reason }
      return { ok: true, text: `已开始建索引：${result.sources.join(', ')}（用 kb_status 查进度）` }
    }
  })

  tools.register({
    name: 'kb_status',
    description: '查看本地知识库索引状态：块数、文档数、模型、最后构建时间，以及正在跑的索引任务。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        required: ['ok'],
        additionalProperties: false
      },
      render: (_args, value) => textOutput(value)
    },
    async execute() {
      try {
        return { ok: true, text: await kb.status() }
      } catch (error) {
        return { ok: false, text: `读取状态失败：${error?.message ?? error}` }
      }
    }
  })

  tools.register({
    name: 'kb_docs',
    description: '列出已索引的文档（路径与块数），用于确认某份资料到底有没有进库。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多列多少篇，默认 50' }
      },
      additionalProperties: false
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        required: ['ok'],
        additionalProperties: false
      },
      render: (_args, value) => textOutput(value)
    },
    async execute(args) {
      try {
        const docs = await kb.docs(Number.isFinite(args?.limit) ? args.limit : 50)
        if (!docs.length) return { ok: true, text: '索引里还没有文档' }
        return { ok: true, text: docs.map((doc, index) => `${index + 1}. ${doc.path}（${doc.chunks} 块）`).join('\n') }
      } catch (error) {
        return { ok: false, text: `读取文档列表失败：${error?.message ?? error}` }
      }
    }
  })

  logger.info?.(
    `${LOG_PREFIX} 已加载：indexDir=${cfg.indexDir} inject=${cfg.inject} topK=${cfg.topK} minScore=${cfg.minScore}`
  )
}
