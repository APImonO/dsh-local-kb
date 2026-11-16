#!/usr/bin/env node
/**
 * 调试：追踪某个关键词对应的块在检索里的真实位置（向量排名 / 各分项）。
 * 用法：node scripts/debug-hit.mjs "S300TA" "华硕 S300TA 最高支持多大内存"
 */

import { resolveConfig } from '../src/config.js'
import { embedQuery } from '../src/embed.js'
import { metaPostings, terms } from '../src/search.js'
import { loadIndex } from '../src/store.js'

const [, , needle, question] = process.argv
if (!needle || !question) {
  console.error('用法: node scripts/debug-hit.mjs "<关键词>" "<问题>"')
  process.exit(1)
}

const cfg = resolveConfig({})
const index = await loadIndex(cfg.indexDir)
const vector = await embedQuery(question, { modelRoot: cfg.modelRoot, logger: {} })

const dim = vector.length
const cosines = new Float32Array(index.chunks.length)
for (let i = 0; i < index.chunks.length; i += 1) {
  const base = i * dim
  let dot = 0
  for (let d = 0; d < dim; d += 1) dot += vector[d] * index.vectors[base + d]
  cosines[i] = dot
}
const order = [...cosines.keys()].sort((a, b) => cosines[b] - cosines[a])
const rankOf = new Map(order.map((chunkIndex, rank) => [chunkIndex, rank]))

const targets = index.chunks
  .map((chunk, chunkIndex) => ({ chunk, chunkIndex }))
  .filter(({ chunk }) => `${chunk.title} ${chunk.source} ${chunk.text}`.toLowerCase().includes(needle.toLowerCase()))
  .slice(0, 5)

console.log(`问题：${question}`)
console.log(`关键词「${needle}」命中 ${targets.length} 个块\n`)

const postings = metaPostings(index)
for (const term of terms(question)) {
  if (postings.has(term)) {
    console.log(`  元数据倒排命中词: ${term} → ${postings.get(term).length} 块`)
  }
}

for (const { chunk, chunkIndex } of targets) {
  console.log(`块 #${chunkIndex}`)
  console.log(`  标题  ${chunk.title}`)
  console.log(`  小节  ${chunk.section}`)
  console.log(`  source ${chunk.source}`)
  console.log(`  余弦  ${cosines[chunkIndex].toFixed(3)}  向量排名 ${rankOf.get(chunkIndex) + 1} / ${index.chunks.length}`)
  console.log('')
}
