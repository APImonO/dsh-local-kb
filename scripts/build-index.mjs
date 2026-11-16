#!/usr/bin/env node
/**
 * 建索引命令行。
 *
 * 用法：
 *   node scripts/build-index.mjs --source D:\path\to\md
 *   node scripts/build-index.mjs --source A --source B --limit 200
 *   node scripts/build-index.mjs --source A --full        # 忽略旧索引
 */

import { resolve } from 'node:path'

import { resolveConfig } from '../src/config.js'
import { buildIndex } from '../src/ingest.js'

function parseArgs(argv) {
  const parsed = { sources: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--source' || arg === '-s') parsed.sources.push(argv[++i])
    else if (arg === '--limit') parsed.limit = Number(argv[++i])
    else if (arg === '--index') parsed.indexDir = argv[++i]
    else if (arg === '--full') parsed.full = true
    else if (arg === '--max-chars') parsed.maxChars = Number(argv[++i])
    else if (arg === '--overlap') parsed.overlap = Number(argv[++i])
    else if (arg === '--batch') parsed.batchSize = Number(argv[++i])
    else if (arg === '--help' || arg === '-h') parsed.help = true
  }
  return parsed
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('用法: node scripts/build-index.mjs --source <目录> [--source <目录>] [--limit N] [--full]')
  process.exit(0)
}

const envConfig = resolveConfig({ indexDir: args.indexDir })
const sources = args.sources.length
  ? args.sources.map((item) => resolve(item))
  : envConfig.sources

if (!sources.length) {
  console.error('缺少 --source（要索引的目录）')
  process.exit(1)
}

const logger = {
  info: (message) => console.log(`[info] ${message}`),
  warn: (message) => console.warn(`[warn] ${message}`),
  debug: (message) => {
    if (process.env.KB_VERBOSE) console.log(`[debug] ${message}`)
  }
}

console.log(`索引目录：${envConfig.indexDir}`)
console.log(`数据源  ：${sources.join(', ')}`)

const startedAt = Date.now()
buildIndex({
  sources,
  indexDir: envConfig.indexDir,
  modelRoot: envConfig.modelRoot,
  batchSize: args.batchSize ?? envConfig.batchSize,
  maxChars: args.maxChars,
  overlap: args.overlap,
  limit: args.limit,
  full: args.full,
  logger
})
  .then((stats) => {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log('')
    console.log('建索引完成')
    console.log(`  文档      ${stats.docs} 篇`)
    console.log(`  分块      ${stats.chunks} 个`)
    console.log(`  新嵌入    ${stats.embedded} 块（复用 ${stats.reused} 块）`)
    console.log(`  向量体积  ${(stats.vectorBytes / 1024 / 1024).toFixed(1)} MB`)
    console.log(`  总耗时    ${seconds}s`)
  })
  .catch((error) => {
    console.error(`建索引失败：${error?.stack ?? error}`)
    process.exit(1)
  })
