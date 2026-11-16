/**
 * 建索引：扫描目录 → 分块 → 嵌入 → 落盘。
 *
 * 增量策略：按"块内容的哈希"复用旧向量。改了一个文件，只有它变动的块
 * 需要重新嵌入；其余块直接搬旧向量，重建 2 万块索引时通常只需几秒。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import { chunkMarkdown } from './chunk.js'
import { MODEL_ID } from './config.js'
import { embedTexts } from './embed.js'
import { chunkId, indexExists, loadIndex, saveIndex, sha256 } from './store.js'

const TEXT_EXTENSIONS = new Set(['.md', '.mdx', '.markdown', '.txt'])

/** 递归列出可索引文件。 */
export async function listFiles(root) {
  const found = []
  const walk = async (dir) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (TEXT_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase())) {
        found.push(full)
      }
    }
  }
  await walk(root)
  return found.sort()
}

/**
 * @param {object} options
 * @param {string[]} options.sources - 要索引的目录（或单个文件）
 * @param {string} options.indexDir
 * @param {string} options.modelRoot
 * @param {number} [options.limit] - 最多处理多少个文件（先小样本验证用）
 * @param {number} [options.maxChars]
 * @param {number} [options.overlap]
 * @param {number} [options.batchSize]
 * @param {boolean} [options.full] - true 表示不读旧索引，全部重新嵌入
 * @param {{ info?: Function, warn?: Function }} [options.logger]
 */
export async function buildIndex(options) {
  const {
    sources,
    indexDir,
    modelRoot,
    limit,
    maxChars = 520,
    overlap = 80,
    batchSize = 16,
    full = false,
    logger = {}
  } = options

  const startedAt = Date.now()

  // 1. 收集文件
  const files = []
  for (const source of sources) {
    const absolute = resolve(source)
    const info = await stat(absolute).catch(() => null)
    if (!info) {
      logger.warn?.(`跳过不存在的路径：${absolute}`)
      continue
    }
    if (info.isDirectory()) {
      files.push(...(await listFiles(absolute)))
    } else {
      files.push(absolute)
    }
  }
  const limited = limit ? files.slice(0, limit) : files
  if (!limited.length) throw new Error('没有找到可索引的文件（支持 .md / .mdx / .txt）')

  // 2. 读旧索引，准备复用向量
  const reusable = new Map()
  if (!full && indexExists(indexDir)) {
    try {
      const previous = await loadIndex(indexDir)
      if (previous.manifest.model === MODEL_ID) {
        previous.chunks.forEach((chunk, index) => {
          const vector = previous.vectors.slice(index * previous.manifest.dim, (index + 1) * previous.manifest.dim)
          reusable.set(chunk.id ?? chunkId(chunk.text), vector)
        })
        logger.info?.(`复用旧索引：${reusable.size} 块可命中`)
      }
    } catch (error) {
      logger.warn?.(`旧索引不可用，将全量重建：${error?.message ?? error}`)
    }
  }

  // 3. 分块
  const chunks = []
  const docs = []
  for (const file of limited) {
    const raw = await readFile(file, 'utf8')
    const docHash = sha256(raw).slice(0, 16)
    const pieces = chunkMarkdown(raw, { filePath: relative(resolve(sources[0]), file), maxChars, overlap })
    for (const piece of pieces) {
      // 嵌入用的文本比存下来的正文多两行"身份"：产品名（常来自 URL）和小节。
      // 标题是"规格参数｜台式电脑"这种泛化文字时，这一步是唯一能救回向量的地方。
      const embedInput = [piece.identity, piece.title, piece.section, piece.text].filter(Boolean).join('\n')
      chunks.push({ id: chunkId(embedInput), ...piece, embedInput, doc: docHash })
    }
    docs.push({ path: relative(resolve(sources[0]), file), hash: docHash, chunks: pieces.length })
  }

  // 4. 只嵌入缺失的块
  const pending = []
  const pendingIndex = []
  chunks.forEach((chunk, index) => {
    if (!reusable.has(chunk.id)) {
      pending.push(chunk.embedInput)
      pendingIndex.push(index)
    }
  })

  logger.info?.(
    `文档 ${docs.length} 篇 / 分块 ${chunks.length} 个；需要新嵌入 ${pending.length} 个（复用 ${chunks.length - pending.length} 个）`
  )

  if (pending.length) {
    const created = await embedTexts(pending, { modelRoot, batchSize, logger })
    created.forEach((vector, index) => {
      reusable.set(chunks[pendingIndex[index]].id, vector)
    })
  }

  const vectors = chunks.map((chunk) => reusable.get(chunk.id))

  const manifest = await saveIndex(indexDir, {
    // embedInput 只用于嵌入，不落盘（否则索引体积翻倍）
    chunks: chunks.map(({ embedInput, ...rest }) => rest),
    vectors,
    manifest: {
      createdAt: new Date().toISOString(),
      builtInMs: Date.now() - startedAt,
      sources: sources.map((source) => resolve(source)),
      docs,
      embedded: pending.length,
      reused: chunks.length - pending.length
    }
  })

  return {
    ...manifest,
    docs: docs.length,
    embedded: pending.length,
    reused: chunks.length - pending.length,
    durationMs: Date.now() - startedAt,
    vectorBytes: chunks.length * 512 * 4
  }
}
