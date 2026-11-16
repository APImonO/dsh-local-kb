/**
 * Markdown 分块：先按标题切小节，再按长度切块。
 *
 * 为什么不直接按固定长度切：规格页、文档页的结构就是"标题 + 若干段落"，
 * 硬切会把一个小节切成两半，检索时两个半块各拿一半信息。按标题优先切，
 * 召回明显更好，代价是块长度不均。
 */

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
const HEADING = /^(#{1,6})\s+(.*)$/

/**
 * 取出 front matter 里的 title/source，剩下的正文。
 * @param {string} raw
 */
export function splitFrontMatter(raw) {
  const text = String(raw ?? '')
  const match = text.match(FRONT_MATTER)
  if (!match) return { meta: {}, body: text }

  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!kv) continue
    meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return { meta, body: text.slice(match[0].length) }
}

function normaliseTitle(value) {
  return String(value ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const GENERIC_URL_PARTS = new Set([
  'techspec', 'techspecs', 'spec', 'specs', 'specification', 'specifications',
  'index', 'index.html', 'index.htm', 'cn', 'www', 'w3', 'com', 'net', 'org',
  'product', 'products', 'detail', 'details', 'page'
])

/**
 * 从 URL 里猜"这台设备叫什么"。
 *
 * 华硕的中文规格页标题全是「规格参数｜台式电脑｜ASUS 中国」，型号只出现在
 * URL 里（/asus-desktop/asus-s300ta/techspec/）。嵌入时把猜出来的身份
 * 拼进去，向量才可能把"S300TA 支持多大内存"和这一页对上。
 */
export function deriveIdentity(source, title) {
  const cleanedTitle = normaliseTitle(title)
  try {
    const url = new URL(source)
    const parts = url.pathname
      .split('/')
      .filter(Boolean)
      .map((part) => part.replace(/\.(html?|aspx?|php)$/i, ''))
      .filter((part) => part && !GENERIC_URL_PARTS.has(part.toLowerCase()))
    if (parts.length) {
      const tail = parts.slice(-2).join(' ').replace(/[-_]+/g, ' ').trim()
      if (tail) {
        // 型号通常形如 s300ta / pg34wcdn，转成大写更像产品名
        return tail.replace(/\b([a-z]*\d[\w]*)\b/gi, (match) => match.toUpperCase())
      }
    }
  } catch {
    // source 不是 URL（本地文件）时用标题
  }
  return cleanedTitle
}

/**
 * 把一篇 Markdown 切成若干块。
 *
 * @param {string} raw - 原始 Markdown
 * @param {{ filePath?: string, maxChars?: number, overlap?: number }} [options]
 * @returns {{ title: string, source: string, section: string, text: string, offset: number }[]}
 */
export function chunkMarkdown(raw, options = {}) {
  const { filePath = '', maxChars = 520, overlap = 80 } = options
  const { meta, body } = splitFrontMatter(raw)

  const title = normaliseTitle(meta.title) || normaliseTitle(firstHeading(body)) || filePath
  const source = normaliseTitle(meta.source) || filePath
  const identity = deriveIdentity(source, meta.title)

  const chunks = []
  let section = ''
  let buffer = []
  let bufferLength = 0
  let offset = 0

  const flush = () => {
    const text = buffer.join('\n').trim()
    if (text) {
      chunks.push({ title, source, identity, section, text, offset })
      offset += text.length
    }
    buffer = []
    bufferLength = 0
  }

  for (const line of body.split(/\r?\n/)) {
    const heading = line.match(HEADING)
    if (heading) {
      flush()
      section = heading[2].trim()
      continue
    }

    const trimmed = line.trimEnd()
    if (!trimmed) {
      buffer.push('')
      continue
    }

    // 单个段落就超长：先落掉已攒的，再按长度硬切
    if (bufferLength + trimmed.length > maxChars && bufferLength > 0) {
      flush()
    }

    if (trimmed.length > maxChars) {
      const pieces = hardSplit(trimmed, maxChars, overlap)
      for (const piece of pieces) {
        buffer.push(piece)
        bufferLength += piece.length
        flush()
      }
      continue
    }

    buffer.push(trimmed)
    bufferLength += trimmed.length
  }

  flush()
  return chunks
}

function firstHeading(body) {
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const heading = line.match(HEADING)
    if (heading) return heading[2]
  }
  return ''
}

function hardSplit(text, maxChars, overlap) {
  const pieces = []
  const step = Math.max(1, maxChars - overlap)
  for (let start = 0; start < text.length; start += step) {
    pieces.push(text.slice(start, start + maxChars))
    if (start + maxChars >= text.length) break
  }
  return pieces
}
