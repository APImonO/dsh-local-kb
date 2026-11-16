import assert from 'node:assert/strict'
import test from 'node:test'

import { formatContext, lexicalScore, search, terms } from '../src/search.js'

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
