# 参与贡献

## 本地跑起来

```bash
npm ci
npm run fetch-model                                # 下载 ONNX 模型（约 23 MB，走 hf-mirror）
npm run build-index -- --source /path/to/docs      # 支持 md/txt/csv/html/pdf/docx
npm run query -- "你的问题" --context
```

## 提交前必须通过

```bash
npm test              # 30 个单元测试，不需要模型
node scripts/mcp-smoke.mjs   # MCP 协议端到端（无索引时会验证"如实报错"）
```

有模型文件的话，再跑一次 `npm run smoke` 验证插件行为。

## 分支与提交

- `main` 受保护：不允许强推、不允许删除、必须线性历史（squash only）
- 改动走分支 → PR → squash merge；仓库只开了 squash，会自动删分支
- 提交信息用 `类型: 一句话`，类型取 `feat` / `fix` / `docs` / `test` / `chore`
- 一个 PR 只做一件事；顺手重构请单独提

## 代码约定

- 纯 ESM，Node 20+；不引入构建步骤
- 新增依赖前先说明理由（这个项目的卖点是"零外部服务"）
- 检索相关改动请附 `npm run eval` 前后对比（哪怕只有 8 道题）
- 中文注释可以，但代码标识符用英文

## 报告问题

用 issue 模板，附上：Node 版本、`kb_status` 输出、复现步骤、期望结果。
涉及具体文档解析失败的，附上文件类型（不必上传文件本身）。
