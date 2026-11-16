#!/usr/bin/env node
/**
 * 检索质量评估：拿一组"答案已知"的问题，看正确内容出现在第几名。
 *
 * 用法：node scripts/eval.mjs
 *
 * 判定标准：正确块出现在 top-1 记 2 分、top-3 记 1 分、更后记 0 分；
 * 同时报告平均分，作为调 chunk 大小 / 阈值的依据。
 */

import { resolveConfig } from '../src/config.js'
import { embedQuery } from '../src/embed.js'
import { search } from '../src/search.js'
import { loadIndex } from '../src/store.js'

/** 每条：问题 + 正确答案里必须出现的片段（取自语料原文）。 */
const CASES = [
  { q: '华硕 S300TA 最高支持多大内存', expect: '64GB' },
  { q: 'S300TA 的电源功率是多少', expect: '200W' },
  { q: 'S300TA 这台台式机多重', expect: '7.00 kg' },
  { q: 'A620M-AYW WIFI 主板内存最高支持多少', expect: '128GB' },
  { q: 'NUC 13 Extreme Kit 用的是什么处理器', expect: '13600K' },
  { q: 'ExpertCenter PB64 迷你电脑最大内存', expect: '32GB' },
  { q: 'S300TA 支持什么无线网卡', expect: 'Wi-Fi 5' },
  { q: 'S300TA 用什么芯片组', expect: 'H410' }
]

const cfg = resolveConfig({})
const index = await loadIndex(cfg.indexDir)
console.log(`索引 ${index.chunks.length} 块，模型 ${index.manifest.model}\n`)

// 这套题是按"中文产品规格页"写的样例。别人拿自己的文档建索引时，
// 答案字符串多半不在库里 —— 那就如实说明并跳过，而不是打印 0/8 让人以为检索坏了。
const allText = index.chunks.map((chunk) => chunk.text).join('\n')
const present = CASES.filter((testCase) => allText.includes(testCase.expect))
if (present.length < CASES.length / 2) {
  console.log('⚠️  示例语料不匹配：下面这些期望答案在索引里基本找不到。')
  console.log('   这套评估是针对"中文产品规格页"写的；换成你自己的语料后，请按实际内容改 scripts/eval.mjs 里的 CASES。')
  console.log(`   命中 ${present.length}/${CASES.length} 个期望字符串。\n`)
  process.exit(0)
}

let total = 0
let best = 0
const rows = []

for (const testCase of CASES) {
  const vector = await embedQuery(testCase.q, { modelRoot: cfg.modelRoot, logger: {} })
  const hits = search(index, vector, {
    query: testCase.q,
    topK: 5,
    minScore: 0,
    lexicalWeight: cfg.lexicalWeight
  })
  const rank = hits.findIndex((hit) => String(hit.chunk.text).includes(testCase.expect))
  const rankNumber = rank < 0 ? 99 : rank + 1
  const points = rankNumber === 1 ? 2 : rankNumber <= 3 ? 1 : 0
  total += points
  best += 2
  rows.push({ q: testCase.q, expect: testCase.expect, rank: rankNumber, points })
}

for (const row of rows) {
  const mark = row.points === 2 ? '✅' : row.points === 1 ? '🟡' : '❌'
  console.log(`${mark} 第 ${row.rank === 99 ? '-' : row.rank} 名  期望含「${row.expect}」  ${row.q}`)
}

const hit1 = rows.filter((row) => row.rank === 1).length
const hit3 = rows.filter((row) => row.rank <= 3).length
console.log('')
console.log(`top-1 命中 ${hit1}/${rows.length}，top-3 命中 ${hit3}/${rows.length}，得分 ${total}/${best}`)
