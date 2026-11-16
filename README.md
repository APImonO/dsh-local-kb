# dsh-local-kb

本地知识库：把一堆 Markdown 建成本地向量索引，**聊到相关问题时自动检索、带来源注入**。
两种形态，同一套内核：

| 形态 | 用途 | 触发方式 |
|---|---|---|
| **MCP 服务** | Claude Desktop / Cursor / 任何 MCP 客户端 | 模型调用 `kb_search` 等工具 |
| **DSH 插件** | DeepSeek Harness | `agent/pre-step` 钩子**自动注入**，另有工具可手动查 |

嵌入在进程内用 ONNX 跑（`bge-small-zh-v1.5` 量化版，约 23 MB），**不依赖任何外部服务**：不要 Open WebUI，不要向量数据库，不要 GPU。

## 为什么这么做

1. DeepSeek API 没有 embedding 接口，向量必须自己解决。
2. 查询嵌入是每轮对话都要做的事——起一个 Python 进程意味着每轮 0.5–2 秒启动开销，所以放进 Node 进程内跑。
3. 2 万块 × 512 维只有 35 MB，暴力余弦 30 毫秒级；引 SQLite/faiss 只是增加编译和版本问题。

## 支持哪些文档

| 格式 | 处理方式 |
|---|---|
| `.md` `.mdx` `.markdown` `.txt` | 直接读，按标题分块 |
| `.csv` `.tsv` | 转成 Markdown 表格（引号、逗号转义都处理），表格结构保住 |
| `.html` `.htm` | 剥掉脚本/样式/导航/页脚，再用 turndown 转 Markdown |
| `.pdf` | **按页**抽取（pdfjs-dist），每页加 `## 第 N 页` 标题，引用能定位到页 |
| `.docx` | mammoth 转 Markdown，标题层级、列表、加粗都保留 |

解析失败的单个文件不会中断整批：会被跳过并在建索引结束时列出原因（缺依赖、加密 PDF、损坏文件）。

> 这套设计沿用源项目 kb-forge 的做法（Python 侧是 pypdf / python-docx / trafilatura），在 Node 里用 pdfjs-dist / mammoth / turndown 做等价的事。

## 快速开始

```bash
npm install

# 1. 下载模型（默认走 hf-mirror；海外可设 KB_MIRROR=https://huggingface.co）
npm run fetch-model

# 2. 建索引（指向你的资料目录，可多个 --source；md/pdf/docx/html/csv 混着放没问题）
npm run build-index -- --source /path/to/docs

# 3. 检索
npm run query -- "某个问题" --context
```

> 已验证：在干净目录里 `git clone` → `npm ci` → `fetch-model` → `build-index` → `query` → `mcp-smoke` → `npm test` 全部通过。

`--context` 会把**真正会注入给模型的那段文本**打印出来，方便判断阈值和预算。

## 作为 MCP 服务

```jsonc
// claude_desktop_config.json
{
  "mcpServers": {
    "local-kb": {
      "command": "node",
      "args": ["/absolute/path/to/dsh-local-kb/scripts/mcp-server.mjs"],
      "env": {
        "KB_INDEX_DIR": "/absolute/path/to/dsh-local-kb/index-data"
      }
    }
  }
}
```

暴露四个工具：

| 工具 | 作用 |
|---|---|
| `kb_search` | 检索，返回片段 + 相似度 + 来源 |
| `kb_ingest` | 后台建索引（只负责启动，进度用 `kb_status` 看） |
| `kb_status` | 块数、文档数、模型、最后构建时间、任务进度 |
| `kb_docs` | 列出已索引的文档与块数 |

协议：JSON-RPC 2.0 over stdio，`protocolVersion 2024-11-05`，一行一个消息。
验证协议本身：`node scripts/mcp-smoke.mjs`（真的 spawn 子进程对话）。

> 自己写 MCP 客户端配置时注意：`env` 里的 `KB_INDEX_DIR` 必须是绝对路径，否则按插件的包根目录解析。

## 作为 DSH 插件

```bash
dsh plugin --profile desktop add /absolute/path/to/dsh-local-kb
```

或手动：profile 的 `package.json` 里加依赖 + 把 `dsh-local-kb` 写进 `dsh.profile.bundles`，然后重装。

装好后：

- 每条**新的**用户消息触发一次检索，命中就注入一条带来源的消息；同一会话同一问题只注入一次
- 注册 `kb_search` / `kb_ingest` / `kb_status` / `kb_docs`
- 检索失败、超时、索引缺失都静默降级——**知识库坏了不影响正常对话**

## 配置

`cordis.patch.yml` 的 `config`，或同名环境变量：

| 配置 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `indexDir` | `KB_INDEX_DIR` | `index-data` | 索引目录 |
| `modelRoot` | `KB_MODEL_ROOT` | `models` | 模型目录 |
| `topK` | `KB_TOP_K` | 5 | 注入/返回几条 |
| `minScore` | `KB_MIN_SCORE` | 0.45 | 余弦低于此值不注入 |
| `maxChars` | `KB_MAX_CHARS` | 1600 | 注入内容字符上限 |
| `inject` | `KB_INJECT` | true | 自动注入总开关 |
| `injectRole` | `KB_INJECT_ROLE` | user | 注入消息角色 |
| `lexicalWeight` | `KB_LEXICAL_WEIGHT` | 0.25 | 词汇重排权重（0 = 纯向量） |
| `maxPerDoc` | `KB_MAX_PER_DOC` | 2 | 同一文档最多保留几块 |
| `searchTimeoutMs` | `KB_SEARCH_TIMEOUT_MS` | 800 | 检索超时，超时按没命中处理 |
| `sources` | `KB_SOURCES` | 空 | `kb_ingest` 默认索引的目录，`;` 分隔 |

## 实测（RTX 4060 Laptop / i7-13650HX / Node 20，CPU 推理）

语料：2,318 篇网页存档（8.09 M 字符，中文规格页为主）

| 指标 | 数值 |
|---|---|
| 分块 | 17,701 块 |
| 全量建索引 | 420 s（约 7 分钟） |
| 增量重建（无改动） | 2.5 s |
| 索引体积 | 34.6 MB |
| 查询嵌入（预热） | p50 4 ms |
| 端到端检索 | p50 40 ms / p95 225 ms |
| 检索质量（8 题人工标注） | top-1 6/8、top-3 8/8 |

混合格式验证（Markdown + PDF + Word + HTML + CSV 各一份）：5 篇文档 → 7 块，建索引 1.3 s，五种格式的查询都能命中对应内容。

## 设计要点

- **分块**：标题优先，段落兜底；超长段落按 80 字重叠硬切。
- **嵌入文本 ≠ 展示文本**：建索引时把"产品名/文件名 + 标题 + 小节"拼进嵌入输入。中文厂商页面标题常是"规格参数｜台式电脑"，型号只在 URL 里，不这么做就永远搜不到。
- **三路召回**：向量 top-50 + 元数据稀有词 + 正文英文/数字 token 倒排；命中型号时把整篇文档的块拉进候选（规格页常有"处理器在表格、内存在另一段"）。
- **稀有词才加分**：`nuc`、`支持` 这类泛词加分等于噪声，只有全库罕见的 token 才给加权。
- **增量**：按块内容哈希复用旧向量，改一个文件只重嵌它变动的块。
- **索引原子写**：先写 `.tmp-<pid>` 再 `rename`，manifest 最后落盘；崩溃不会留下半新半旧的索引。
- **按 mtime+size 跳过未改动文件**：没改的文件连解析都不做（混入 PDF 后省的时间很明显）。
- **注入按轮去重**：同一轮对话的多次 step 只注入一次；新的一轮会重新注入。注入消息带 `【本地知识库检索结果】` 前缀，和用户发言区分。
- **单文档限额**：同一文档最多进 2 块（`maxPerDoc`），避免 top-5 被一篇长文档占满。

## 已知限制

- **PDF 只抽文本层**：扫描件/图片型 PDF 需要 OCR，本项目没做（会抽出空文本并跳过）
- 中文模型（bge-small-zh）跨语言弱：中文问句查英文页面只能进 top-2
- 注入会追加一条消息，**可能让上游前缀缓存失效**，增加 token 成本；已按用户回合去重
- 索引单进程独占写，别在 `kb_ingest` 跑的时候同时写索引
- CPU 推理，全量建索引是分钟级
- 没有 `.doc`（Word 97）、`.xlsx`、`.pptx` 支持；老格式建议先另存为 `.docx`

## 脚本

| 命令 | 作用 |
|---|---|
| `npm run fetch-model` | 从镜像下载 ONNX 模型 |
| `npm run build-index -- --source <dir>` | 建索引（`--limit N` 小样本、`--full` 全重嵌） |
| `npm run query -- "问题" --context` | 检索并预览注入文本 |
| `npm run mcp` | 启动 MCP stdio 服务 |
| `npm test` | 30 个单元测试（分块 / 检索数学 / 索引读写 / MCP 协议 / 文档解析） |
| `npm run smoke` | 用假 ctx 跑插件行为（不安装） |
| `npm run bench` | 预热后的延迟基准 |
| `npm run eval` | 8 题检索质量评估（样例针对中文规格页，换语料会提示跳过） |
| `scripts/mcp-smoke.mjs` | MCP 端到端（spawn 子进程） |

## License

MIT
