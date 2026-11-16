/**
 * 配置解析：默认值 → 环境变量 → 插件 config（cordis.patch.yml）。
 *
 * 所有相对路径都按"包根目录"解析，这样插件装进 profile 的 node_modules 之后
 * 也能找到自己的 index-data/。
 */

import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 包根目录（src/ 的上一层）。 */
export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 索引里用的模型标识（对应 models/ 下的目录名）。 */
export const MODEL_ID = 'Xenova/bge-small-zh-v1.5'

/** 向量维度：bge-small-zh 固定 512。 */
export const DIM = 512

function numberOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function boolOr(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  return !/^(0|false|no|off)$/i.test(String(value))
}

function pathOr(value, fallback) {
  const raw = value === undefined || value === null || value === '' ? fallback : String(value)
  return isAbsolute(raw) ? raw : resolve(PACKAGE_ROOT, raw)
}

/**
 * @param {Record<string, unknown>} [config] cordis.patch.yml 里那一行的 config
 */
export function resolveConfig(config = {}) {
  const env = process.env

  return {
    /** 索引目录：manifest.json / chunks.jsonl / vectors.f32 所在处。 */
    indexDir: pathOr(config.indexDir ?? env.KB_INDEX_DIR, 'index-data'),

    /** 模型目录：models/<MODEL_ID>/。 */
    modelRoot: pathOr(config.modelRoot ?? env.KB_MODEL_ROOT, 'models'),

    /** 每次注入取几条。 */
    topK: numberOr(config.topK ?? env.KB_TOP_K, 5),

    /** 低于这个相似度就不注入（0–1）。 */
    minScore: numberOr(config.minScore ?? env.KB_MIN_SCORE, 0.45),

    /** 注入内容的总字符上限（约等于 token 预算 / 1.5）。 */
    maxChars: numberOr(config.maxChars ?? env.KB_MAX_CHARS, 1600),

    /** 总开关：false 时完全不干预对话。 */
    inject: boolOr(config.inject ?? env.KB_INJECT, true),

    /** 注入用的消息角色：user 最安全，system 更强但可能影响语气。 */
    injectRole: String(config.injectRole ?? env.KB_INJECT_ROLE ?? 'user'),

    /** 检索里词汇匹配的权重（0 = 纯向量）。 */
    lexicalWeight: numberOr(config.lexicalWeight ?? env.KB_LEXICAL_WEIGHT, 0.25),

    /** 检索耗时上限（毫秒），超时按"没有命中"处理。 */
    searchTimeoutMs: numberOr(config.searchTimeoutMs ?? env.KB_SEARCH_TIMEOUT_MS, 800),

    /** 嵌入批大小。 */
    batchSize: numberOr(config.batchSize ?? env.KB_BATCH_SIZE, 16),

    /** kb_ingest 不带参数时，默认索引这些目录（字符串数组）。 */
    sources: Array.isArray(config.sources)
      ? config.sources.map(String)
      : String(config.sources ?? env.KB_SOURCES ?? '')
          .split(';')
          .map((item) => item.trim())
          .filter(Boolean)
  }
}

/** 索引文件路径。 */
export function indexPaths(indexDir) {
  return {
    manifest: resolve(indexDir, 'manifest.json'),
    chunks: resolve(indexDir, 'chunks.jsonl'),
    vectors: resolve(indexDir, 'vectors.f32')
  }
}
