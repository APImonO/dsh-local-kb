import assert from 'node:assert/strict'
import test from 'node:test'

import { diversify, formatContext, lexicalScore, search, terms } from '../src/search.js'

/** 造一个最小索引：两个 4 维块。 */
function tinyIndex() {
  const chunks = [
    { id: 'a', title: 'A', source: 'a.md', section: '内存', text: '最高支持 64GB 内存' },
    { id: 'b', title: 'B', source: 'b.md', section: '接口', text: 'USB 3.2 接口两个' }
  ]
  const vectors = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0
  ])
  return { chunks, vectors }
}

test('向量相似度决定排序', () => {
  const hits = search(tinyIndex(), new Float32Array([1, 0, 0, 0]), { query: 'x', minScore: 0.1 })
  assert.equal(hits[0].chunk.id, 'a')
})

test('minScore 过滤掉不相关的', () => {
  const hits = search(tinyIndex(), new Float32Array([0, 0, 1, 0]), { query: 'x', minScore: 0.45 })
  assert.equal(hits.length, 0)
})

test('中文二元组能匹配', () => {
  const queryTerms = terms('支持多大内存')
  const docTerms = terms('最高支持 64GB 内存')
  assert.ok(lexicalScore(queryTerms, docTerms) > 0)
})

test('词汇权重能把同义表述顶上第一', () => {
  // 两个块的向量分相同，靠词汇匹配分胜负
  const index = {
    chunks: [
      { id: 'noise', title: 'N', source: 'n.md', section: '', text: '完全无关的内容' },
      { id: 'target', title: 'T', source: 't.md', section: '内存', text: '内存最高支持 64GB' }
    ],
    vectors: new Float32Array([0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0])
  }
  const hits = search(index, new Float32Array([1, 0, 0, 0]), {
    query: '内存支持多少',
    minScore: 0.1,
    lexicalWeight: 0.5
  })
  assert.equal(hits[0].chunk.id, 'target')
})

test('formatContext 遵守字符预算并带来源', () => {
  const hits = [
    { score: 0.9, chunk: { title: '规格页', source: 's.md', section: '内存', text: '甲'.repeat(300) } },
    { score: 0.8, chunk: { title: '规格页', source: 's.md', section: '接口', text: '乙'.repeat(300) } }
  ]
  const context = formatContext(hits, 260)
  assert.ok(context.length <= 260 + 60)
  assert.ok(context.includes('来源'))
  assert.ok(context.includes('规格页'))
})

test('没有命中时返回空串', () => {
  assert.equal(formatContext([], 500), '')
})

test('diversify 限制单篇文档占比并保留溢出补位', () => {
  const hits = [
    { score: 0.9, chunk: { doc: 'a', text: 'a1' } },
    { score: 0.8, chunk: { doc: 'a', text: 'a2' } },
    { score: 0.7, chunk: { doc: 'a', text: 'a3' } },
    { score: 0.6, chunk: { doc: 'b', text: 'b1' } }
  ]
  const ordered = diversify(hits, 2)
  assert.deepEqual(ordered.slice(0, 3).map((item) => item.chunk.text), ['a1', 'a2', 'b1'])
  // 溢出的 a3 仍然保留在末尾，候选不足时可以补位
  assert.equal(ordered.at(-1).chunk.text, 'a3')
})

test('search 的 maxPerDoc 生效', () => {
  // 三个块同一文档且都与查询高度相似
  const index = {
    chunks: [
      { id: '1', doc: 'same', title: 'T', source: 's.md', section: '', text: '内存 64GB' },
      { id: '2', doc: 'same', title: 'T', source: 's.md', section: '', text: '内存 32GB' },
      { id: '3', doc: 'same', title: 'T', source: 's.md', section: '', text: '内存 16GB' },
      { id: '4', doc: 'other', title: 'O', source: 'o.md', section: '', text: '内存 8GB' }
    ],
    vectors: new Float32Array([1, 0, 0, 0, 0.99, 0, 0, 0, 0.98, 0, 0, 0, 0.5, 0, 0, 0])
  }
  const hits = search(index, new Float32Array([1, 0, 0, 0]), {
    query: '内存',
    topK: 3,
    minScore: 0,
    lexicalWeight: 0,
    maxPerDoc: 2
  })
  const docs = hits.map((hit) => hit.chunk.doc)
  assert.equal(docs.filter((doc) => doc === 'same').length, 2)
  assert.ok(docs.includes('other'))
})
