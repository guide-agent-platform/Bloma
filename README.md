# 向导 Agent 多智能体协同开发平台

> 基于 Proma fork 的零代码软件生成桌面应用文档集  
> 当前状态：需求、UX、架构、接口、测试、Sprint、科研计划已完成  
> 日期：2026-07-10

> 当前新项目入口（2026-10-23）：[流程缩减实施记录](docs/05_PROJECT_PLAN/workflow-reduction-implementation-20261023.md)。新普通项目使用短任务单、单稿HTML、连续Pi制作和宿主实际验证；不默认调用AC、完整PRD、架构/脚手架独立阶段或MVP确认。历史项目与冻结实验保留各自协议，本页早期规划不作为新默认流程。

> 2026-10-27：[Harness 改进计划](docs/05_PROJECT_PLAN/harness-improvement-plan-20261027.md)按验收设施、独立试用和多模型验收分批推进。需求确认时恢复可选的 AI 灵感建议，默认不选；采纳后更新任务单再确认，不额外增加需求整理的模型调用。

> 当前执行接手：[Harness 改进交接](docs/05_PROJECT_PLAN/harness-improvement-handoff-20261027.md)，包含已完成版本、验证边界和剩余批次的执行入口。

> 历史接线（2026-10-20）：平台生成Windows Python/WebView2桌面应用，[制作流程v2](docs/05_PROJECT_PLAN/production-workflow-v2-20261020.md)保留当时设计；代码清理、硬编码修复和本机旧项目清理结果见[清理实施记录](docs/05_PROJECT_PLAN/hardcoding-cleanup-execution-20261020.md)。

> 2026-10-22后续完善：[全流程实施记录](docs/05_PROJECT_PLAN/workflow-improvement-20261022.md)包含持久MVP确认、宿主原生GUI验收CLI、验证凭据复用及交付规则收敛的实现与验证边界。

> 2026-10-23接续：[确认恢复与独立验收实测](docs/05_PROJECT_PLAN/confirmation-acceptance-20261022.md)记录PRD/UX持久恢复、独立GUI规则准备、存储故障验证和真实模型试跑。自动准备目前须显式开启，真实任务结果与测试fixture结果分别记录。

---

## 1. 项目目的

本项目把 Proma 改造为面向零基础用户的软件生成平台。用户不需要理解代码、架构、数据库或测试，只需要用自然语言说明想法，并通过预览确认结果。

核心体验：

```text
两道门选择
→ 向导 Agent 澄清需求
→ 生成验证草图
→ 用户看预览确认或点选纠错
→ 生成 MVP
→ 自动测试和裁判审查
→ 快照、回滚、继续迭代
```

平台内部由三类 Agent 协作：

- 向导 Agent：唯一面向用户的对话对象。
- 编程 Agent：负责生成、运行、测试、修复代码。
- 裁判 Agent：负责质量门禁，只判定，不修复。

---

## 2. Proma Core 对齐原则

所有实现必须继承 `proma-core-demo` 的底层约束：

- IPC 四层链路：`shared/types.ts -> main/ipc.ts -> preload/bridge.ts -> renderer atoms`。
- Renderer 不直接访问 Node.js、文件系统、API Key 或 Agent SDK。
- API Key 只在 main 进程解密，并通过 Electron `safeStorage` 加密保存到 `channels.json`。
- Agent 流式输出通过 `AgentOrchestrator -> AgentEvent -> IPC -> Jotai atomFamily(sessionId) -> UI`。
- 工具权限使用 `canUseTool()` + `pendingRequests Map` + UI 决策回传。
- 运行时存储只使用 `~/.proma/` 下的 JSON、JSONL 和工作区文件目录。
- SQLite 只允许作为科研离线导出格式，不进入运行时架构。

---

## 3. 文档导航

### 3.1 需求层

| 文档 | 说明 |
|---|---|
| `user-stories.md` | 35 条用户故事，覆盖用户、向导 Agent、编程 Agent、裁判 Agent、研究者 |
| `glossary.md` | 核心术语表 |

### 3.2 UX 层

| 文档 | 说明 |
|---|---|
| `sitemap.md` | 页面树、页面说明、全局 UI 元素和技术边界 |
| `user-flows.md` | 端到端用户流程 |
| `design-system.md` | 视觉、组件、状态和文案规范 |
| `interaction-spec.md` | 模式选择、点选纠错、快照回滚、等待反馈等交互规格 |
| `wireframes/` | 6 个 HTML 线框原型 |

### 3.3 架构层

| 文档 | 说明 |
|---|---|
| `architecture.md` | 总体架构、Proma fork 策略、Agent、沙箱、快照、MCP |
| `component-design.md` | 12 个核心模块设计 |
| `prompt-engineering.md` | 向导/编程/裁判 Agent Prompt 结构和 Proma core 运行边界 |
| `data-model.md` | Local-First 存储、实体、埋点、权限、渠道 |
| `class-diagram.puml` | Proma core 对齐后的核心类图 |
| `sequence-diagrams/` | 5 个关键时序图 |

### 3.4 接口层

| 文档 | 说明 |
|---|---|
| `api-spec.md` | IPC、Renderer Bridge、Agent 流、权限、项目、沙箱、快照、文档、埋点、MCP 工具和错误码 |

### 3.5 测试层

| 文档 | 说明 |
|---|---|
| `test-plan.md` | 测试分层、Mock 策略、CI、发布门禁 |
| `testing-standards.md` | 功能域、测试 ID、文件写法、结果分类和测试报告规范 |
| `features/` | 6 个 GWT Feature 文件 |

Feature 文件：

- `features/mode-selection.feature`
- `features/generation-workflow.feature`
- `features/point-correction.feature`
- `features/timeline-rollback.feature`
- `features/self-healing-judge.feature`
- `features/proma-core-boundary.feature`

### 3.6 计划层

| 文档 | 说明 |
|---|---|
| `sprint-plan.md` | Phase 1 四个 Sprint，固定三人分工，交付物和验收标准 |
| `research-plan.md` | 研究问题、实验设计、指标体系、13 类埋点映射、论文大纲 |

### 3.7 状态文件

| 文档 | 说明 |
|---|---|
| `07_VERSIONS/changelog.md` | 版本变更记录（当前状态与剩余工作以 changelog + git log 为准） |

---

## 4. 当前完成状态

已完成：

- 需求层：用户故事、术语表。
- UX 层：站点地图、用户流程、线框图、设计系统、交互规格。
- 架构层：架构设计、组件设计、Prompt、数据模型、类图、时序图。
- 接口层：API 规范。
- 测试层：测试计划和 6 个 GWT Feature。
- 测试规范：测试编写、稳定 ID、失败分类和报告要求。
- 计划层：Sprint 计划和科研计划。
- 顶层：README。

架构层已按 `C:\Users\17359\OneDrive\Desktop\proma-core-demo` 完成 v1.1 对齐。

---

## 5. 三人分工

Phase 1 按固定三人团队推进：

| 角色 | 职责 |
|---|---|
| A：工程负责人 / 全栈 | Proma fork、主进程、IPC、AgentOrchestrator、权限服务、沙箱运行、MCP 工具 |
| B：前端 / UX 工程 | 工作区 UI、Jotai atoms、全局监听器、预览区、点选纠错、时间轴、P0 用户文案 |
| C：测试 / 研究工程 | GWT Feature、E2E、文档一致性、埋点、脱敏导出、研究指标校验 |

---

## 6. Phase 1 实现顺序

| Sprint | 周期 | 主题 |
|---|---|---|
| Sprint 0 | 1 周 | Proma core 对齐与开发底座 |
| Sprint 1 | 2 周 | 草图生成闭环 |
| Sprint 2 | 2 周 | MVP 与质量门禁 |
| Sprint 3 | 2 周 | 纠错、回滚与研究数据 |

进入实现前建议先做：

1. 在真实代码仓库中确认 `proma-core-demo` 与目标 fork 的目录差异。
2. 建立 `shared/types.ts` 的 IPC 单一真相源。
3. 设置临时 `PROMA_HOME` 测试环境，避免写入真实用户数据。
4. 先跑通 `proma-core-boundary.feature` 对应的底层测试骨架。

---

## 7. 发布门禁

Phase 1 发布前必须满足：

- 6 个 GWT Feature 全部通过。
- 自动修复失败后能回滚到最近健康快照。
- 裁判退回达到上限后用户能选择继续、接受或补充说明。
- 用户可见错误文案不包含代码、堆栈、HTTP 状态码、XSS、SQL 注入等技术细节。
- API Key 明文不会进入 renderer、日志、JSONL、埋点。
- 运行时不创建 SQLite 文件或服务端数据库连接。
- 13 类埋点能写入 `analytics.jsonl` 并脱敏导出。

---

## 8. 推荐阅读顺序

如果准备进入实现，建议按以下顺序阅读：

1. `architecture.md`
2. `api-spec.md`
3. `data-model.md`
4. `component-design.md`
5. `sprint-plan.md`
6. `test-plan.md`
7. `features/proma-core-boundary.feature`
8. `features/generation-workflow.feature`

如果准备做 UX 或产品评审，建议按以下顺序阅读：

1. `glossary.md`
2. `user-flows.md`
3. `interaction-spec.md`
4. `design-system.md`
5. `wireframes/`
6. `features/`

---

## 9. 开发与测试环境

### 9.1 环境准备

- Node.js 22.13 或更新版本（本次验证使用 24.12.0），npm 10 或更新版本（本次验证使用 11.6.4）。
- Windows 10/11；Electron 动态验收需要桌面会话。
- 首次拉取后执行 `npm ci`，依赖版本以 `package-lock.json` 为准。
- 不提交 `node_modules/`、`dist/`、`dist-main/`、`coverage/`、`test-results/`、`.vitest/`、`.proma-test/` 或日志文件。
- 新增或升级依赖时提交 `package.json` 和 `package-lock.json`，不要提交安装目录或构建产物。

### 9.2 主要依赖

| 用途 | 依赖 |
|---|---|
| 桌面运行 | Electron |
| Renderer | React、React DOM、Jotai |
| 类型与构建 | TypeScript、Vite、esbuild |
| 自动化测试 | Vitest、Testing Library、jsdom、Playwright Electron |

### 9.3 验证命令

```bash
npm run typecheck
npm run build
npm run test:unit
npm run test:integration
npm run test:regression:sprint0
npm run test:regression:sprint1
npm run test:acceptance:sprint0
npm run test:acceptance:sprint1
npm run test:acceptance:sprint2
npm run test:acceptance:sprint3
npm run test:electron-smoke
npm run test:all
npm run docs:check
```

测试写入文件时必须使用临时 `PROMA_HOME`，完整规则见 `docs/06_TESTS/testing-standards.md`。

## 10. 修订记录

| 版本 | 日期 | 修订内容 |
|------|------|----------|
| v1.0 | 2026-07-10 | 首版，建立项目总览、文档导航、Proma core 约束、三人分工、实现顺序和发布门禁 |
| v1.1 | 2026-07-25 | 增加测试编写与报告规范导航 |
| v1.2 | 2026-07-25 | 增加开发依赖、测试命令和 Git 产物边界说明 |
| v1.3 | 2026-07-25 | 增加 Sprint 1 Playwright Electron E2E 命令与依赖 |
