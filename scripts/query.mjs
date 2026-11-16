#!/usr/bin/env node
/**
 * 检索命令行（不需要装进 DSH，用来验收检索质量）。
 *
 * 用法：
 *   node scripts/query.mjs "华硕 S300TA 最高支持多大内存"
 *   node scripts/query.mjs "问题" --top 8 --min-score 0.4
 */

import { resolveConfig } from '../src/config.js'
import { embedQuery } from '../src/embed.js'
import { formatContext, search } from '../src/search.js'
import { loadIndex } from '../src/store.js'

function parseArgs(argv) {
  const parsed = { queryParts: [], top: undefined, minScore: undefined, context: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--top') parsed.top = Number(argv[++i])
    else if (arg === '--min-score') parsed.minScore = Number(argv[++i])
    else if (arg === '--context') parsed.context = true
    else if (arg === '--index') parsed.indexDir = argv[++i]
    else parsed.queryParts.push(arg)
  }
  parsed.query = parsed.queryParts.join(' ').trim()
  return parsed
}

const args = parseArgs(process.argv.slice(2))
if (!args.query) {
  console.error('用法: node scripts/query.mjs "问题" [--top 5] [--min-score 0.45] [--context]')
  process.exit(1)
}

const cfg = resolveConfig({ indexDir: args.indexDir })
const logger = { info: () => {}, warn: (m) => console.warn(m), debug: () => {} }

const startedAt = Date.now()
const index = await loadIndex(cfg.indexDir)
const vector = await embedQuery(args.query, { modelRoot: cfg.modelRoot, logger })
const hits = search(index, vector, {
  query: args.query,
  topK: args.top ?? cfg.topK,
  minScore: args.minScore ?? cfg.minScore,
  lexicalWeight: cfg.lexicalWeight
})
const elapsed = Date.now() - startedAt

console.log(`索引 ${index.chunks.length} 块 / 模型 ${index.manifest.model}`)
console.log(`问题：${args.query}`)
console.log(`耗时：${elapsed} ms / 命中 ${hits.length} 条\n`)

for (const [i, hit] of hits.entries()) {
  const { title, source, section, text } = hit.chunk
  const label = section && section !== title
    ? `${title || source} · ${section}`
    : title || section || source
  console.log(`${i + 1}. [${hit.score.toFixed(3)}] ${label}`)
  console.log(`   ${String(text).replace(/\s+/g, ' ').slice(0, 220)}`)
  console.log('')
}

if (args.context) {
  console.log('--- 会被注入的内容 ---')
  console.log(formatContext(hits, cfg.maxChars))
}
