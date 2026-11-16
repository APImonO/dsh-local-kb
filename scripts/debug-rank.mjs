#!/usr/bin/env node
import { resolveConfig } from '../src/config.js'
import { embedQuery } from '../src/embed.js'
import { search } from '../src/search.js'
import { loadIndex } from '../src/store.js'

const [, , needle, question] = process.argv
const cfg = resolveConfig({})
const index = await loadIndex(cfg.indexDir)
const vector = await embedQuery(question, { modelRoot: cfg.modelRoot, logger: {} })
const hits = search(index, vector, { query: question, topK: 15, minScore: 0, lexicalWeight: cfg.lexicalWeight })

const needleIndexes = index.chunks
  .map((chunk, i) => ({ chunk, i }))
  .filter(({ chunk }) => chunk.text.includes(needle))
  .map(({ i }) => i)

console.log(`问题：${question}`)
console.log(`含「${needle}」的块：${needleIndexes.join(', ')}\n`)
hits.forEach((hit, rank) => {
  const globalIndex = index.chunks.indexOf(hit.chunk)
  const hitMark = needleIndexes.includes(globalIndex) ? '  <-- 目标' : ''
  console.log(
    `${rank + 1}. [${hit.score.toFixed(3)} cos=${hit.cosine.toFixed(3)} lex=${hit.lexical.toFixed(2)}] #${globalIndex} ` +
      `${hit.chunk.title.slice(0, 28)} :: ${hit.chunk.text.slice(0, 40).replace(/\s+/g, ' ')}${hitMark}`
  )
})
