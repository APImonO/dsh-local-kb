import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  delimitedToMarkdown,
  dependencyStatus,
  docxToMarkdown,
  extractText,
  htmlToMarkdown,
  pdfToMarkdown
} from '../src/extract/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => join(here, 'fixtures', name)

test('CSV 转成 Markdown 表格并处理引号', () => {
  const markdown = delimitedToMarkdown('名称,内存\n"X1, Pro",64GB\nX1,32GB\n')
  assert.ok(markdown.includes('| 名称 | 内存 |'))
  assert.ok(markdown.includes('| --- | --- |'))
  assert.ok(markdown.includes('X1, Pro'))
  assert.ok(markdown.includes('64GB'))
})

test('HTML 剥掉脚本和导航后保留正文结构', async () => {
  const markdown = await htmlToMarkdown(`
    <html><head><title>T</title><style>b{}</style></head>
    <body><nav>菜单</nav><h1>规格</h1><p>重量 <b>1.1 kg</b>。</p>
    <ul><li>USB4</li></ul><script>alert(1)</script></body></html>`)
  assert.ok(markdown.includes('# 规格'))
  assert.ok(markdown.includes('**1.1 kg**'))
  assert.ok(!markdown.includes('alert(1)'))
  assert.ok(!markdown.includes('菜单'))
})

test('PDF 按页输出，正文可读', async () => {
  const status = dependencyStatus()
  if (!status.pdf) return // 没装 pdfjs-dist 就跳过
  const { markdown, pages } = await pdfToMarkdown(await readFile(fixture('sample.pdf')))
  assert.equal(pages, 1)
  assert.ok(markdown.includes('第 1 页'))
  assert.ok(markdown.includes('NovaBook X2 memory 96GB'))
})

test('DOCX 解析出标题和段落', async () => {
  const status = dependencyStatus()
  if (!status.docx) return
  const markdown = await docxToMarkdown(await readFile(fixture('sample.docx')))
  assert.ok(markdown.includes('NovaBook X2'))
  assert.ok(markdown.includes('96GB'))
})

test('extractText 按扩展名分发', async () => {
  const { kind } = await extractText(fixture('sample.pdf'))
  assert.equal(kind, 'pdf')
  const markdownDoc = await extractText(fixture('sample.docx'))
  assert.equal(markdownDoc.kind, 'docx')
})

test('不支持的扩展名给出可执行报错', async () => {
  await assert.rejects(() => extractText(fixture('sample.bin')), /不支持的文件类型/)
})
