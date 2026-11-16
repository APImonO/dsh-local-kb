import assert from 'node:assert/strict'
import test from 'node:test'

import { chunkMarkdown, splitFrontMatter } from '../src/chunk.js'

test('splitFrontMatter 取标题和来源', () => {
  const raw = ['---', 'title: "规格参数｜台式电脑"', 'source: "https://example.com/a"', '---', '', '# 标题', '正文'].join('\n')
  const { meta, body } = splitFrontMatter(raw)
  assert.equal(meta.title, '规格参数｜台式电脑')
  assert.equal(meta.source, 'https://example.com/a')
  assert.ok(body.includes('正文'))
  assert.ok(!body.includes('source:'))
})

test('没有 front matter 也能分块', () => {
  const chunks = chunkMarkdown('# 标题\n\n第一段内容。\n\n第二段内容。', { filePath: 'a.md' })
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].title, '标题')
  assert.ok(chunks[0].text.includes('第一段'))
})

test('按标题切成小节', () => {
  const raw = ['# 总览', '开头说明。', '## 内存', '最高支持 64GB。', '## 接口', 'USB 3.2 x2。'].join('\n')
  const chunks = chunkMarkdown(raw)
  const sections = chunks.map((chunk) => chunk.section)
  assert.deepEqual(sections, ['总览', '内存', '接口'])
})

test('超长段落按 overlap 硬切', () => {
  const long = '甲'.repeat(1200)
  const chunks = chunkMarkdown(`# 长文\n${long}`, { maxChars: 500, overlap: 100 })
  assert.ok(chunks.length >= 3)
  assert.ok(chunks.every((chunk) => chunk.text.length <= 500))
})

test('空文档不产生块', () => {
  assert.deepEqual(chunkMarkdown('', { filePath: 'empty.md' }), [])
})
