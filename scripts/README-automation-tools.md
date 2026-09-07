# 自动化基础设施入库备注

> 建立：2026-08-27 | 用途：说明本次加入仓库的自动化工具脚本与文档集，供团队理解与维护。

## 一、加入内容

### 1. 工具脚本（scripts/，5 个）

| 文件 | 行数 | 作用 | 依赖 |
|---|---|---|---|
| `scripts/multi-vendor-run.mjs` | 260 | **多厂商测试编排**：test-gen / test-review / verdict；硬性三模型（deepseek-v4-flash + glm-5.3-flash + qwen3.8-flash），共享上下文 + 提前压缩 | Node ≥ 20（fetch）、Electron（解密渠道 key） |
| `scripts/vision-diagnose.mjs` | 324 | 视觉模型诊断前端截图，输出结构化 UI/交互问题 JSON | Node ≥ 20、Proma Cloud 或渠道 key |
| `scripts/smart-pr.mjs` | 169 | **智能提 PR**：收集改动 → commit → push → GitHub API 建 PR（凭据从 git credential 读取） | Node ≥ 20、git、GitHub 凭据 |
| `scripts/bloma-vision-mcp.cjs` | 155 | 视觉诊断 MCP server（stdio）：暴露 `vision_diagnose` / `ui_screenshot` 工具 | Node、Bloma 的 playwright |
| `scripts/_screenshot-worker.cjs` | 28 | Playwright 截图 worker（MCP server 内部调用） | Bloma 的 playwright |

**未入库**：`scripts/channel-key-reader.cjs`（Electron safeStorage 渠道 key 解密器——涉及本机密钥能力，**不进仓库**，各开发者本机按需自建）。

### 2. 伪代码文档集（docs/03_ARCHITECTURE/pseudocode/，8 个 md，340K）

架构伪代码文档（00-总索引 ~ 07-问题定位速查），Bloma 定位问题/改代码/开发前的必查资料。属于项目知识资产，随仓库共享。

## 二、未入库/不处理项

| 项 | 说明 |
|---|---|
| `scripts/channel-key-reader.cjs` | 密钥解密工具，本机私有，不提交 |
| `undefined/` | 自动化运行残留（14 个「权限检查失败」jsonl），非代码，保留在本机不提交 |

## 三、使用方式

- 自动化任务（Proma Automation「Bloma 持续 TDD 开发与多厂商多角色审查」）每轮自动调用这些脚本
- 手动使用：
  - `node scripts/multi-vendor-run.mjs test-gen --context <文件> --shared <共享上下文>`
  - `node scripts/vision-diagnose.mjs <截图> --api-key <key>`
  - `node scripts/smart-pr.mjs --title "<commit message>" --body <PR描述> --dry-run`
- 详细说明见各文件头注释

## 四、注意事项

1. **密钥安全**：脚本不硬编码任何 key；channel-key-reader.cjs 不入库，避免密钥解密能力外泄
2. **依赖**：需 Node ≥ 20（fetch 原生）、Bloma 项目已装 playwright/electron
3. **路径**：脚本用 `process.cwd()` 定位项目根，调用前需 `cd /d/QQ/TEEm/Bloma`
4. **提交边界**：默认只提交代码与测试改动，docs 原件/伪代码由文档负责人确认后统一管理
