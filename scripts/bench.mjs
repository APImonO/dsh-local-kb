#!/usr/bin/env node
/**
 * 检索性能基准：索引和模型只加载一次，测预热后的真实延迟。
 *
 * 命令行版的 `query.mjs` 每次都要冷启动（加载模型 ~200 ms），
 * 那是脚本开销，不是插件里的查询延迟。这个脚本用"小样本"的方式
 * 模拟插件常驻进程的真实情况。
 *
 * 用法：node scripts/bench.mjs ["问题1" "问题2" ...]
 */

import { resolveConfig } from '../src/config.js'
import { embedQuery, getExtractor } from '../src/embed.js'
import { search } from '../src/search.js'
import { loadIndex } from '../src/store.js'

const cfg = resolveConfig({})
const logger = { info: () => {}, warn: (m) => console.warn(m), debug: () => {} }

const questions = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      '华硕 S300TA 最高支持多大内存',
      '这台机器的处理器型号是什么',
      '支持哪些接口和 USB 规格',
      '机器的重量和尺寸是多少',
      '电源功率多大'
    ]

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[index]
}

console.log('加载索引与模型（只做一次）…')
const t0 = Date.now()
const index = await loadIndex(cfg.indexDir)
await getExtractor(cfg.modelRoot, { logger })
const loadMs = Date.now() - t0
console.log(`索引 ${index.chunks.length} 块 / 模型就绪，用时 ${loadMs} ms\n`)

// 预热：第一次推理含算子初始化，不计入统计
await embedQuery(questions[0], { modelRoot: cfg.modelRoot, logger })

const embedTimes = []
const searchTimes = []
const totalTimes = []

for (let round = 0; round < 3; round += 1) {
  for (const question of questions) {
    const t1 = Date.now()
    const vector = await embedQuery(question, { modelRoot: cfg.modelRoot, logger })
    const t2 = Date.now()
    const hits = search(index, vector, {
      query: question,
      topK: cfg.topK,
      minScore: 0,
      lexicalWeight: cfg.lexicalWeight
    })
    const t3 = Date.now()
    embedTimes.push(t2 - t1)
    searchTimes.push(t3 - t2)
    totalTimes.push(t3 - t1)
    if (round === 0) {
      const top = hits[0]
      console.log(`Q: ${question}`)
      console.log(`   命中 ${hits.length} 条，最高分 ${top ? top.score.toFixed(3) : '-'} · ${top ? top.chunk.title : '-'}`)
    }
  }
}

console.log('\n预热后延迟（毫秒）')
console.log(`  查询嵌入  p50 ${percentile(embedTimes, 50)}  p95 ${percentile(embedTimes, 95)}`)
console.log(`  向量检索  p50 ${percentile(searchTimes, 50)}  p95 ${percentile(searchTimes, 95)}`)
console.log(`  合计      p50 ${percentile(totalTimes, 50)}  p95 ${percentile(totalTimes, 95)}`)
