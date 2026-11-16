/**
 * 文档解析：把各种格式变成"带标题结构的文本"。
 *
 * 设计上抄的是源项目 kb-forge 的思路：
 *   1. 每种格式一个提取器，统一输出 Markdown（分块器只认一种输入）
 *   2. 依赖按需加载，缺依赖时给出可执行的报错，而不是崩在半路
 *   3. 表格尽量保留结构（CSV 转 Markdown 表格，PDF 按页加标题，Word 走 mammoth 的 Markdown）
 *
 * 和源项目的差别：那边是 Python（trafilatura / pypdf / python-docx），
 * 这里在 Node 里用 pdfjs-dist / mammoth / turndown 做等价的事。
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, extname } from 'node:path'

const require = createRequire(import.meta.url)

/** 扩展名 → 处理方式。 */
export const SUPPORTED = {
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.text': 'text',
  '.csv': 'csv',
  '.tsv': 'tsv',
  '.html': 'html',
  '.htm': 'html',
  '.pdf': 'pdf',
  '.docx': 'docx'
}

/** 供 CLI/文档展示的扩展名列表。 */
export const SUPPORTED_EXTENSIONS = Object.keys(SUPPORTED)

/** 某种格式的依赖是否可用（用于状态提示）。 */
export function dependencyStatus() {
  const status = {}
  for (const [kind, moduleName] of [
    ['pdf', 'pdfjs-dist'],
    ['docx', 'mammoth'],
    ['html', 'turndown']
  ]) {
    try {
      require.resolve(moduleName)
      status[kind] = true
    } catch {
      status[kind] = false
    }
  }
  return status
}

function unsupported(kind, moduleName) {
  return new Error(`解析 .${kind} 需要依赖 ${moduleName}（npm install ${moduleName}）`)
}

/** CSV/TSV → Markdown 表格（简单引号处理，够用且无依赖）。 */
export function delimitedToMarkdown(raw, separator = ',') {
  const rows = []
  let row = []
  let field = ''
  let quoted = false

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i]
    if (quoted) {
      if (char === '"') {
        if (raw[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') quoted = true
    else if (char === separator) {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (char !== '\r') {
      field += char
    }
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }

  const cleaned = rows.filter((cells) => cells.some((cell) => cell.trim()))
  if (!cleaned.length) return ''
  const header = cleaned[0]
  const body = cleaned.slice(1)
  const lines = [
    `| ${header.map((cell) => cell.trim()).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((cells) => `| ${cells.map((cell) => cell.trim().replace(/\|/g, '\\|')).join(' | ')} |`)
  ]
  return lines.join('\n')
}

/** HTML → Markdown（先剥掉脚本/样式/导航等噪声）。 */
export async function htmlToMarkdown(html) {
  let TurndownService
  try {
    TurndownService = (await import('turndown')).default
  } catch {
    throw unsupported('html', 'turndown')
  }

  const cleaned = String(html)
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')

  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
  return turndown.turndown(cleaned).trim()
}

/** PDF → Markdown，按页加二级标题，方便引用时定位到页。 */
export async function pdfToMarkdown(buffer) {
  let pdfjs
  try {
    pdfjs = require('pdfjs-dist/legacy/build/pdf.js')
  } catch {
    throw unsupported('pdf', 'pdfjs-dist')
  }

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false
  }).promise

  const parts = []
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber)
    const content = await page.getTextContent()
    const text = content.items
      .map((item) => (item.str ?? '') + (item.hasEOL ? '\n' : ' '))
      .join('')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (text) parts.push(`## 第 ${pageNumber} 页\n\n${text}`)
  }
  await doc.destroy?.()
  return { markdown: parts.join('\n\n'), pages: doc.numPages }
}

/** .docx → Markdown（mammoth 会保留标题层级和列表）。 */
export async function docxToMarkdown(buffer) {
  let mammoth
  try {
    mammoth = (await import('mammoth')).default
  } catch {
    throw unsupported('docx', 'mammoth')
  }
  const result = await mammoth.convertToMarkdown({ buffer })
  return result.value.trim()
}

/**
 * 统一入口：返回 Markdown 文本（已经带好标题结构）。
 *
 * @param {string} file - 文件路径
 * @param {{ logger?: object }} [options]
 * @returns {Promise<{ markdown: string, kind: string, pages?: number }>}
 */
export async function extractText(file, options = {}) {
  const ext = extname(file).toLowerCase()
  const kind = SUPPORTED[ext]
  if (!kind) {
    throw new Error(`不支持的文件类型 ${ext || '(无扩展名)'}：${basename(file)}`)
  }

  if (kind === 'csv' || kind === 'tsv') {
    const raw = await readFile(file, 'utf8')
    return { markdown: delimitedToMarkdown(raw, kind === 'csv' ? ',' : '\t'), kind }
  }

  if (kind === 'markdown' || kind === 'text') {
    return { markdown: await readFile(file, 'utf8'), kind }
  }

  if (kind === 'html') {
    const html = await readFile(file, 'utf8')
    return { markdown: await htmlToMarkdown(html), kind }
  }

  if (kind === 'pdf') {
    const result = await pdfToMarkdown(await readFile(file))
    options.logger?.debug?.(`PDF ${basename(file)}：${result.pages} 页`)
    return { markdown: result.markdown, kind, pages: result.pages }
  }

  if (kind === 'docx') {
    return { markdown: await docxToMarkdown(await readFile(file)), kind }
  }

  throw new Error(`未知类型：${kind}`)
}
