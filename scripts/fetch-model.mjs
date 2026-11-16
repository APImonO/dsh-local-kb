#!/usr/bin/env node
/**
 * 下载嵌入模型（bge-small-zh-v1.5 的 ONNX 量化版，约 30 MB）。
 *
 * 走 hf-mirror.com：这套网络下 huggingface.co 直连不通（15s 超时），
 * 镜像 200 且 <1s。可以用 KB_MIRROR 覆盖。
 */

import { mkdir, writeFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { MODEL_ID, PACKAGE_ROOT, resolveConfig } from '../src/config.js'

const MIRROR = process.env.KB_MIRROR || 'https://hf-mirror.com'
const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx'
]

const targetRoot = join(resolveConfig({}).modelRoot ?? join(PACKAGE_ROOT, 'models'), MODEL_ID)

async function alreadyThere(file) {
  try {
    const info = await stat(file)
    return info.size > 0
  } catch {
    return false
  }
}

async function download(relativePath) {
  const destination = join(targetRoot, relativePath)
  if (await alreadyThere(destination)) {
    console.log(`跳过（已存在）${relativePath}`)
    return
  }

  const url = `${MIRROR}/${MODEL_ID}/resolve/main/${relativePath}`
  console.log(`下载 ${url}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`下载失败 ${relativePath}: HTTP ${response.status}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, buffer)
  console.log(`完成 ${relativePath} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`)
}

async function main() {
  console.log(`模型：${MODEL_ID}`)
  console.log(`目标：${resolve(targetRoot)}`)
  for (const file of FILES) {
    await download(file)
  }
  console.log('全部就绪，可以运行 npm run build-index 了')
}

main().catch((error) => {
  console.error(`下载模型失败：${error?.message ?? error}`)
  process.exit(1)
})
