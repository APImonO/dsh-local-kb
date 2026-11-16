/**
 * 索引存储：manifest.json + chunks.jsonl + vectors.f32，全部纯文件。
 *
 * 为什么不上向量数据库：2,318 篇文档约 1.7–2 万块、512 维，
 * 39 MB 的 Float32Array 常驻内存，一次暴力检索 5–15 ms，
 * 引一个 SQLite/faiss 只会增加编译和版本问题。
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { DIM, MODEL_ID, indexPaths } from './config.js'

/** 内容哈希，用作 chunk 的稳定 id（增量时靠它复用旧向量）。 */
export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

export function chunkId(text) {
  return sha256(text).slice(0, 16)
}

/** 索引是否已存在。 */
export function indexExists(indexDir) {
  const paths = indexPaths(indexDir)
  return existsSync(paths.manifest) && existsSync(paths.chunks) && existsSync(paths.vectors)
}

/**
 * 写出索引。
 * @param {string} indexDir
 * @param {{ manifest: object, chunks: object[], vectors: Float32Array[] }} data
 */
export async function saveIndex(indexDir, data) {
  const paths = indexPaths(indexDir)
  await mkdir(dirname(paths.manifest), { recursive: true })

  const lines = data.chunks.map((chunk) => JSON.stringify(chunk)).join('\n')
  await writeFile(paths.chunks, `${lines}\n`, 'utf8')

  const flat = new Float32Array(data.vectors.length * DIM)
  data.vectors.forEach((vector, index) => {
    flat.set(vector, index * DIM)
  })
  await writeFile(paths.vectors, Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength))

  const manifest = {
    version: 1,
    model: MODEL_ID,
    dim: DIM,
    chunks: data.chunks.length,
    ...data.manifest
  }
  await writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

/**
 * 读入索引：向量读成 Float32Array，块读成对象数组。
 * @param {string} indexDir
 */
export async function loadIndex(indexDir) {
  const paths = indexPaths(indexDir)
  const manifest = JSON.parse(await readFile(paths.manifest, 'utf8'))
  if (manifest.dim !== DIM) {
    throw new Error(`索引维度 ${manifest.dim} 与当前模型维度 ${DIM} 不一致，请重建索引`)
  }

  const buffer = await readFile(paths.vectors)
  const expected = manifest.chunks * DIM * 4
  if (buffer.byteLength !== expected) {
    throw new Error(`向量文件损坏：期望 ${expected} 字节，实际 ${buffer.byteLength}`)
  }
  const flat = new Float32Array(buffer.buffer, buffer.byteOffset, manifest.chunks * DIM)

  const raw = await readFile(paths.chunks, 'utf8')
  const chunks = raw
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))

  if (chunks.length !== manifest.chunks) {
    throw new Error(`索引不一致：manifest 说 ${manifest.chunks} 块，实际 ${chunks.length} 块`)
  }

  return { manifest, chunks, vectors: flat }
}
