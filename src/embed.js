/**
 * ONNX 嵌入：从本地 models/ 目录加载 bge-small-zh-v1.5，进程内推理。
 *
 * 为什么不走 Python：查询嵌入是每一轮对话都要做的事，起一个 Python 进程
 * 意味着每轮 0.5–2 秒的启动 + 模型加载。ONNX 在 Node 里跑，一句话几十毫秒。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { env, pipeline } from '@huggingface/transformers'

import { DIM, MODEL_ID } from './config.js'

/** 进程内单例。 */
let extractorPromise = null

/**
 * 告诉 transformers.js 只从本地找模型，绝不联网。
 * @param {string} modelRoot - models/ 目录
 */
function prepareEnv(modelRoot) {
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.localModelPath = modelRoot
  env.useBrowserCache = false
}

/** 模型目录是否齐全（缺文件时给出可执行的报错，而不是让 onnxruntime 抛内部错误）。 */
export function checkModelFiles(modelRoot) {
  const dir = join(modelRoot, MODEL_ID)
  const required = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']
  const missing = required.filter((file) => !existsSync(join(dir, file)))
  return { dir, missing, ok: missing.length === 0 }
}

/**
 * 懒加载嵌入管线。首次调用会加载模型（~1–3 秒），之后复用。
 * @param {string} modelRoot
 * @param {{ logger?: { info?: Function, warn?: Function } }} [options]
 */
export async function getExtractor(modelRoot, options = {}) {
  if (extractorPromise) return extractorPromise

  const check = checkModelFiles(modelRoot)
  if (!check.ok) {
    throw new Error(
      `dsh-local-kb: 模型文件缺失（${check.dir}）：${check.missing.join(', ')}。` +
        '运行 `npm run fetch-model` 从镜像下载（约 30 MB）。'
    )
  }

  prepareEnv(modelRoot)
  extractorPromise = pipeline('feature-extraction', MODEL_ID, {
    dtype: 'q8',
    device: 'cpu'
  }).then((pipe) => {
    options.logger?.info?.(`dsh-local-kb: 嵌入模型已加载（${MODEL_ID}, q8, ${DIM} 维）`)
    return pipe
  }).catch((error) => {
    extractorPromise = null
    throw error
  })

  return extractorPromise
}

/**
 * 把一批文本变成单位向量（便于用点积当余弦）。
 * @param {string[]} texts
 * @param {{ modelRoot: string, batchSize?: number, logger?: object }} options
 * @returns {Promise<Float32Array[]>}
 */
export async function embedTexts(texts, options) {
  const { modelRoot, batchSize = 16, logger } = options
  if (!texts.length) return []

  const extractor = await getExtractor(modelRoot, { logger })
  const vectors = []

  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize)
    const output = await extractor(batch, { pooling: 'cls', normalize: true })
    const rows = output.tolist()
    for (const row of rows) {
      const vec = new Float32Array(DIM)
      for (let i = 0; i < DIM; i += 1) vec[i] = row[i] ?? 0
      vectors.push(vec)
    }
    if (logger?.debug) {
      logger.debug(`dsh-local-kb: 已嵌入 ${Math.min(start + batchSize, texts.length)}/${texts.length}`)
    }
  }

  return vectors
}

/** 单条查询用（内部就是 embedTexts 的壳，方便 mock）。 */
export async function embedQuery(text, options) {
  const [vector] = await embedTexts([text], options)
  return vector ?? null
}

/** 测试用：清掉单例，便于换模型目录重测。 */
export function resetExtractor() {
  extractorPromise = null
}
