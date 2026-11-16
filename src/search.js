/**
 * 检索：向量余弦（主）+ 中文二元组词汇匹配（辅）。
 *
 * 纯向量在中文短查询上会飘（"支持多大内存"这种问法，向量距离和"内存规格"
 * 未必最近）。加一点词汇重叠做重排，召回明显更稳，代价是几十毫秒。
 */

const CJK = /[\u4e00-\u9fff]/

/** 取查询/文本的匹配单元：中文按二元组，英文按单词（连字符视为分隔符）。 */
export function terms(text) {
  const value = String(text ?? '').toLowerCase()
  const set = new Set()
  const asciiWords = value.match(/[a-z0-9][a-z0-9._]*/g) ?? []
  for (const word of asciiWords) {
    if (word.length >= 2) set.add(word)
  }

  let run = ''
  const flushRun = () => {
    if (run.length >= 2) {
      for (let i = 0; i < run.length - 1; i += 1) set.add(run.slice(i, i + 2))
    }
    run = ''
  }
  for (const char of value) {
    if (CJK.test(char)) run += char
    else flushRun()
  }
  flushRun()
  return set
}

/** 词汇重叠分：交并比的平方根，压制长文本占便宜的问题。 */
export function lexicalScore(queryTerms, textTerms) {
  if (!queryTerms.size || !textTerms.size) return 0
  let hit = 0
  for (const term of queryTerms) {
    if (textTerms.has(term)) hit += 1
  }
  if (!hit) return 0
  return hit / Math.sqrt(queryTerms.size * textTerms.size)
}

/**
 * 在索引里检索。
 *
 * 两路召回：
 *   1. 向量：全体块算余弦，取前 50
 *   2. 元数据倒排：标题 / 小节 / source(URL) 里的精确词（型号、型号 slug）
 *      —— 像 S300TA 这种型号往往只出现在 URL，向量根本看不见它
 * 两路合并后统一重排。
 *
 * @param {{ chunks: object[], vectors: Float32Array }} index
 * @param {Float32Array} queryVector - 已归一化
 * @param {{ query: string, topK?: number, minScore?: number, lexicalWeight?: number }} options
 * @returns {{ score: number, cosine: number, lexical: number, chunk: object }[]}
 */
export function search(index, queryVector, options = {}) {
  const { query = '', topK = 5, minScore = 0.45, lexicalWeight = 0.25 } = options
  const { chunks, vectors } = index
  const dim = queryVector.length
  const total = chunks.length
  if (!total) return []

  // 第一路：纯向量
  const cosines = new Float32Array(total)
  const scored = []
  for (let i = 0; i < total; i += 1) {
    const base = i * dim
    let dot = 0
    for (let d = 0; d < dim; d += 1) dot += queryVector[d] * vectors[base + d]
    cosines[i] = dot
    scored.push({ index: i, cosine: dot })
  }
  scored.sort((a, b) => b.cosine - a.cosine)
  const candidateSet = new Set(scored.slice(0, Math.max(50, topK * 10)).map((item) => item.index))

  // 第二路：元数据精确词（只认稀有词：型号这类）
  const queryTerms = terms(query)
  const postings = metaPostings(index)
  const metaHits = new Set()
  for (const term of queryTerms) {
    const posting = postings.get(term)
    if (!posting) continue
    // "支持""内存"这种泛词会命中几十上百个块，加分等于噪声
    if (posting.length > RARE_POSTING_LIMIT) continue
    for (const chunkIndex of posting) {
      candidateSet.add(chunkIndex)
      metaHits.add(chunkIndex)
    }
  }

  // 第三路：正文里的英文/数字 token 精确匹配（13600K / H410 / A620M 这类）
  // 只有"全库罕见"的 token 才加分：nuc / 13 这种到处都是的词加分等于噪声。
  const bodyPostings = textPostings(index)
  const exactHits = new Set()
  for (const term of asciiTerms(query)) {
    const posting = bodyPostings.get(term)
    if (!posting) continue
    for (const chunkIndex of posting) {
      candidateSet.add(chunkIndex)
      if (posting.length <= RARE_POSTING_LIMIT) exactHits.add(chunkIndex)
    }
  }

  // 第四路：文档级定位（"查询点的是哪一篇"）
  const rareDocs = rankDocsByMeta(index, query)

  // 统一重排
  // 点名的文档要把所有块都拉进候选：规格页常有"处理器在表格里、
  // 内存在另一段"的情况，只拿向量命中的那一块会漏掉答案。
  if (rareDocs.size) {
    for (let i = 0; i < total; i += 1) {
      if (rareDocs.has(chunks[i].doc)) candidateSet.add(i)
    }
  }

  const lexicalQueryTerms = terms(query)
  const results = []
  for (const chunkIndex of candidateSet) {
    const chunk = chunks[chunkIndex]
    const chunkTerms = terms([chunk.title, chunk.section, chunk.source, chunk.text].join(' '))
    const lexical = lexicalQueryTerms.size ? lexicalScore(lexicalQueryTerms, chunkTerms) : 0
    // 加分只给"正文里真的出现了这个型号"的块。
    // 标题/URL 匹配是整篇共享的，用它加分会让免责声明块盖过规格表格块。
    const metaBoost = exactHits.has(chunkIndex) ? 0.3 : 0
    const score = (1 - lexicalWeight) * cosines[chunkIndex] + lexicalWeight * lexical + metaBoost
    results.push({ score, cosine: cosines[chunkIndex], lexical, chunk })
  }
  results.sort((a, b) => b.score - a.score)

  // 命中了型号这类实体词时，先把该文档自己的块排上来（文档内再按分数排），
  // 把"某个型号的某一页"和"全库最像的一段废话"分开。
  const ordered = rareDocs.size
    ? [
        ...results.filter((item) => rareDocs.has(item.chunk.doc)),
        ...results.filter((item) => !rareDocs.has(item.chunk.doc))
      ]
    : results

  return ordered.filter((item) => item.cosine >= minScore || item.score >= minScore + 0.15).slice(0, topK)
}

/** 元数据词的出现次数超过这个值，就不再当作"有区分度"的信号。 */
const RARE_POSTING_LIMIT = 10

/**
 * 元数据倒排：标题 / 小节 / source 里的词 → 块下标。
 * 只收"够少见"的词（出现超过 1500 次的词没有区分度，跳过）。
 */
const metaPostingsCache = new WeakMap()

export function metaPostings(index) {
  const cached = metaPostingsCache.get(index)
  if (cached) return cached

  /** @type {Map<string, number[]>} */
  const postings = new Map()
  index.chunks.forEach((chunk, chunkIndex) => {
    const metaTerms = terms([chunk.title, chunk.section, chunk.source].join(' '))
    for (const term of metaTerms) {
      const list = postings.get(term)
      if (list) list.push(chunkIndex)
      else postings.set(term, [chunkIndex])
    }
  })

  const MAX_POSTING = 1500
  for (const [term, list] of postings) {
    if (list.length > MAX_POSTING) postings.delete(term)
  }
  metaPostingsCache.set(index, postings)
  return postings
}

/** 只取英文/数字 token（型号、序列号、接口名）。 */
export function asciiTerms(text) {
  const set = new Set()
  for (const word of String(text ?? '').toLowerCase().match(/[a-z0-9][a-z0-9._]*/g) ?? []) {
    if (word.length >= 2) set.add(word)
  }
  return set
}

/**
 * 正文里的英文/数字 token 倒排。
 *
 * 为什么要它：像 13600K、H410、A620M 这种型号，标题里常常没有，
 * 向量也排不进前 50；但它们出现在正文里，精确匹配是可靠信号。
 */
const textPostingsCache = new WeakMap()

export function textPostings(index) {
  const cached = textPostingsCache.get(index)
  if (cached) return cached

  /** @type {Map<string, number[]>} */
  const postings = new Map()
  index.chunks.forEach((chunk, chunkIndex) => {
    for (const term of asciiTerms(chunk.text)) {
      const list = postings.get(term)
      if (list) list.push(chunkIndex)
      else postings.set(term, [chunkIndex])
    }
  })

  const MAX_POSTING = 400
  for (const [term, list] of postings) {
    if (list.length > MAX_POSTING) postings.delete(term)
  }
  textPostingsCache.set(index, postings)
  return postings
}

/** 预热倒排索引（插件加载后调用一次，避免首个查询超时）。 */
export function warmup(index) {
  metaPostings(index)
  textPostings(index)
  docMeta(index)
}

/**
 * 文档级元数据：每个文档的标题 / 小节 / source 里的英文数字 token。
 * 用来判断"查询里的型号到底指哪一篇文档"。
 */
const docMetaCache = new WeakMap()

export function docMeta(index) {
  const cached = docMetaCache.get(index)
  if (cached) return cached

  /** @type {Map<string, Set<string>>} */
  const byDoc = new Map()
  for (const chunk of index.chunks) {
    const doc = chunk.doc ?? chunk.source
    let set = byDoc.get(doc)
    if (!set) {
      set = new Set()
      byDoc.set(doc, set)
    }
    for (const term of asciiTerms([chunk.title, chunk.section, chunk.source].join(' '))) {
      set.add(term)
    }
  }

  const df = new Map()
  for (const set of byDoc.values()) {
    for (const term of set) df.set(term, (df.get(term) ?? 0) + 1)
  }

  const result = { byDoc, df, docCount: byDoc.size }
  docMetaCache.set(index, result)
  return result
}

/**
 * 哪些文档的元数据最像"查询里点名的那个东西"。
 *
 * 用 idf 加权：命中 "s300ta"（全库 1 篇）比命中 "nuc"（196 篇）有分量得多，
 * 所以 "NUC 13 Extreme Kit" 能定位到那一篇，而不会被 nuc 的大量文档淹没。
 */
export function rankDocsByMeta(index, query, limit = 3) {
  const { byDoc, df, docCount } = docMeta(index)
  const queryTerms = asciiTerms(query)
  if (!queryTerms.size) return new Set()

  const scored = []
  for (const [doc, terms] of byDoc) {
    let score = 0
    let matched = 0
    for (const term of queryTerms) {
      if (!terms.has(term)) continue
      const freq = df.get(term) ?? 1
      score += Math.log(1 + docCount / freq)
      matched += 1
    }
    if (matched) scored.push({ doc, score, matched })
  }
  if (!scored.length) return new Set()

  scored.sort((a, b) => b.score - a.score)
  const top = scored[0]
  return new Set(
    scored
      .filter((item, position) => position < limit && (item.matched >= 2 || item.score >= top.score * 0.9))
      .map((item) => item.doc)
  )
}

/**
 * 把检索结果拼成可注入的文本块，带来源标注。
 * @param {{ score: number, chunk: object }[]} hits
 * @param {number} maxChars
 */
export function formatContext(hits, maxChars = 1600) {
  if (!hits.length) return ''
  const lines = ['以下是从本地知识库检索到的资料，回答时优先使用，并在结尾用 [来源: 文件] 标注：']
  let used = lines[0].length

  for (const hit of hits) {
    const { title, source, section, text } = hit.chunk
    const label = section && section !== title
      ? `${title || source} · ${section}`
      : title || section || source
    const body = String(text).replace(/\s+/g, ' ').trim()
    const block = `\n【${label}】\n${body}`
    if (used + block.length > maxChars) {
      const room = maxChars - used
      if (room > 120) lines.push(block.slice(0, room) + '…')
      break
    }
    lines.push(block)
    used += block.length
  }

  if (lines.length === 1) return ''
  return lines.join('\n')
}
