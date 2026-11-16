#!/usr/bin/env node
/**
 * MCP 服务入口（stdio）。
 *
 * 用法：
 *   node scripts/mcp-server.mjs
 *
 * MCP 客户端配置示例（Claude Desktop 的 claude_desktop_config.json）：
 *   {
 *     "mcpServers": {
 *       "local-kb": {
 *         "command": "node",
 *         "args": ["<项目绝对路径>/scripts/mcp-server.mjs"],
 *         "env": { "KB_INDEX_DIR": "<项目绝对路径>/index-data" }
 *       }
 *     }
 *   }
 */

import { startMcpServer } from '../src/mcp/server.js'

startMcpServer({
  logger: {
    info: (message) => process.stderr.write(`[info] ${message}\n`),
    warn: (message) => process.stderr.write(`[warn] ${message}\n`),
    debug: () => {}
  }
})
