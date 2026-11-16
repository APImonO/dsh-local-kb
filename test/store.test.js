import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DIM } from '../src/config.js'
import { loadIndex, saveIndex } from '../src/store.js'

function vectorWith(first) {
  const vector = new Float32Array(DIM)
  vector[0] = first
  return vector
}

test('saveIndex 写完后没有残留临时文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kb-store-'))
  try {
    await saveIndex(dir, {
      chunks: [
        { id: 'a', title: 'A', source: 'a.md', section: '', text: '甲' },
        { id: 'b', title: 'B', source: 'b.md', section: '', text: '乙' }
      ],
      vectors: [vectorWith(1), vectorWith(0.5)],
      manifest: { docs: [], test: true }
    })

    const files = (await readdir(dir)).sort()
    assert.deepEqual(files, ['chunks.jsonl', 'manifest.json', 'vectors.f32'])
    assert.ok(files.every((name) => !name.includes('.tmp')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('写出后能原样读回（块数、维度、向量的值）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kb-store-'))
  try {
    await saveIndex(dir, {
      chunks: [{ id: 'a', title: 'A', source: 'a.md', section: '', text: '甲' }],
      vectors: [vectorWith(0.25)],
      manifest: { docs: [{ path: 'a.md', hash: 'x' }] }
    })

    const index = await loadIndex(dir)
    assert.equal(index.manifest.dim, DIM)
    assert.equal(index.chunks.length, 1)
    assert.equal(index.chunks[0].text, '甲')
    assert.ok(Math.abs(index.vectors[0] - 0.25) < 1e-6)
    assert.equal(index.manifest.docs[0].path, 'a.md')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('向量文件被截断时 loadIndex 明确报错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kb-store-'))
  try {
    await saveIndex(dir, {
      chunks: [{ id: 'a', title: 'A', source: 'a.md', section: '', text: '甲' }],
      vectors: [vectorWith(1)],
      manifest: { docs: [] }
    })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'vectors.f32'), Buffer.alloc(DIM)) // 故意少写
    await assert.rejects(() => loadIndex(dir), /向量文件损坏/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
