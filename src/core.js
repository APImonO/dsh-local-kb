/**
 * 知识库内核：索引加载、检索、状态、建索引任务。
 *
 * 插件（DSH）和 MCP 服务共用这一层，两边只负责各自的"外壳"：
 * 插件把结果注入对话，MCP 把结果包成 JSON-RPC 响应。
 */

import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'

import { indexPaths, resolveConfig } from './config.js'
import { embedQuery } from './embed.js'
import { buildIndex } from './ingest.js'
import { formatContext, search, warmup } from './search.js'
import { loadIndex } from './store.js'

/**
 * @param {Record<string, unknown>} config - 同 resolveConfig 的入参
 * @param {{ info?: Function, warn?: Function, debug?: Function }} [logger]
 */
export function createKnowledgeBase(config = {}, logger = {}) {
  const cfg = resolveConfig(config)

  let cache = null
  let loading = null
  let job = null

  async function load() {
    if (cache) return cache
    if (loading) return loading

    loading = (async () => {
      if (!existsSync(indexPaths(cfg.indexDir).manifest)) {
        throw new Error(`索引不存在：${cfg.indexDir}（先运行 npm run build-index）`)
      }
      const index = await loadIndex(cfg.indexDir)
      // 倒排索引在第一次检索时构建，这里预热一次，避免首个请求超时
      warmup(index)
      cache = index
      logger.info?.(`dsh-local-kb: 索引已加载 ${index.chunks.length} 块（${index.manifest.model}）`)
      return cache
    })().finally(() => {
      loading = null
    })

    return loading
  }

  return {
    cfg,

    /** 原始检索结果（带分数和块元数据）。 */
    async search(query, overrides = {}) {
      if (!query || !String(query).trim()) return []
      const index = await load()
      const vector = await embedQuery(query, { modelRoot: cfg.modelRoot, logger })
      if (!vector) return []
      return search(index, vector, {
        query,
        topK: overrides.topK ?? cfg.topK,
        minScore: overrides.minScore ?? cfg.minScore,
        lexicalWeight: overrides.lexicalWeight ?? cfg.lexicalWeight,
        maxPerDoc: overrides.maxPerDoc ?? cfg.maxPerDoc
      })
    },

    /** 拼成可注入/可直接阅读的文本块。 */
    async context(query, overrides = {}) {
      const hits = await this.search(query, overrides)
      return { hits, text: formatContext(hits, overrides.maxChars ?? cfg.maxChars) }
    },

    /** 索引概况。 */
    async status() {
      const lines = []
      try {
        if (existsSync(indexPaths(cfg.indexDir).manifest)) {
          const manifest = JSON.parse(await readFile(indexPaths(cfg.indexDir).manifest, 'utf8'))
          lines.push(`索引：${manifest.chunks} 块 / 模型 ${manifest.model} / 维度 ${manifest.dim}`)
          lines.push(`文档：${manifest.docs?.length ?? '未知'} 篇`)
          lines.push(`最后构建：${manifest.createdAt ?? '未知'}（耗时 ${manifest.builtInMs ?? '?'} ms）`)
          if (Array.isArray(manifest.sources)) lines.push(`来源：${manifest.sources.join(', ')}`)
        } else {
          lines.push(`索引不存在：${cfg.indexDir}`)
        }
      } catch (error) {
        lines.push(`读取索引失败：${error?.message ?? error}`)
      }
      lines.push(
        `注入开关：${cfg.inject ? '开' : '关'} / topK=${cfg.topK} / 阈值=${cfg.minScore} / 预算=${cfg.maxChars} 字`
      )
      if (job) {
        lines.push(
          `索引任务：${job.state}` +
            (job.stats ? ` · ${job.stats.chunks} 块（新嵌入 ${job.stats.embedded}）` : '') +
            (job.error ? ` · ${job.error}` : '')
        )
      }
      return lines.join('\n')
    },

    /** 已索引的文档列表。 */
    async docs(limit = 50) {
      const manifestPath = indexPaths(cfg.indexDir).manifest
      if (!existsSync(manifestPath)) throw new Error(`索引不存在：${cfg.indexDir}`)
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      const docs = Array.isArray(manifest.docs) ? manifest.docs : []
      return docs.slice(0, Math.max(1, Math.min(limit, 2000)))
    },

    /** 后台建索引；同一时间只允许一个任务。 */
    ingest(options = {}) {
      if (job && job.state === 'running') {
        return { started: false, reason: '已有索引任务在跑', job }
      }
      const sources = (options.sources?.length ? options.sources : cfg.sources ?? []).map(String)
      if (!sources.length) {
        return { started: false, reason: '没有指定 sources，也没有默认配置' }
      }

      job = { state: 'running', startedAt: new Date().toISOString(), sources }
      buildIndex({
        sources,
        indexDir: cfg.indexDir,
        modelRoot: cfg.modelRoot,
        batchSize: cfg.batchSize,
        full: Boolean(options.full),
        logger
      })
        .then((stats) => {
          job = { ...job, state: 'done', stats, finishedAt: new Date().toISOString() }
          cache = null
        })
        .catch((error) => {
          job = { ...job, state: 'failed', error: String(error?.message ?? error), finishedAt: new Date().toISOString() }
        })

      return { started: true, sources, job }
    },

    /** 当前索引（MCP 里用于探测模型是否可用）。 */
    async ready() {
      try {
        const index = await load()
        return { ready: true, chunks: index.chunks.length, model: index.manifest.model }
      } catch (error) {
        return { ready: false, error: String(error?.message ?? error) }
      }
    },

    /** 索引文件的修改时间（诊断用）。 */
    async indexMtime() {
      const info = await stat(indexPaths(cfg.indexDir).manifest).catch(() => null)
      return info?.mtimeMs ?? 0
    },

    reload() {
      cache = null
    },

    get job() {
      return job
    }
  }
}
