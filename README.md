# 向导 Agent 多智能体协同开发平台

> 2026-11-01：[平台旧流程与重复实现清理](docs/05_PROJECT_PLAN/platform-cleanup-20261101.md)。制作与委派统一使用Pi原生执行器；清理旧压缩/调度/工具协议恢复，保留宿主权限、预算与交付门。

> 基于 Proma fork 的零代码软件生成桌面应用文档集  
> 当前状态：需求、UX、架构、接口、测试、Sprint、科研计划已完成  
> 日期：2026-07-10

> 2026-11-01：[模型窗口、主动技能与点选修改](docs/05_PROJECT_PLAN/context-skills-correction-20261101.md)。已知模型按Pi目录使用1M等实际容量，代理可显式覆盖；Agent按需选择技能；草图、浏览器/Electron产物及固定试用版本支持点选反馈，提交保留版本与重试身份。

> 2026-11-01：[Pi 1.4.0 升级与原生接口接入](docs/05_PROJECT_PLAN/pi-runtime-upgrade-20261101.md)。三个Pi包统一锁定，完成宿主完成门、原生消息/工具声明和图片授权桥适配；评测身份与此前修复见[实施审计](docs/05_PROJECT_PLAN/frontier-evaluation-pi-audit-20261101.md)。本机工程验证与真实模型收益分别记录。

> 当前入口（2026-10-28）：新项目统一使用 software-v1，经过短任务单、必要的外观确认、连续 Pi 制作和宿主实际验证。长期型按里程碑核对与发布，待办另行确认。未标记历史项目和 lean-v1 只保留历史/产物访问，继续修改须显式复制；冻结实验只读报告。见 [后续清理记录](docs/05_PROJECT_PLAN/workflow-cleanup-20261028.md)。

> 2026-10-29：[第一轮能力扩展](docs/05_PROJECT_PLAN/capability-expansion-20261029.md)接入产品自有PDF／DOCX文本解析、字面检索与精确引用核对，提供业务关系反例和已有工程导入差异；修复发布依赖的Node查找布局。工程验证通过，真实模型生成收益及AI效果另验。

> 后续优先[多模态与HTTP／Webhook集成](docs/05_PROJECT_PLAN/multimodal-http-first-20261029.md)：首批提供Windows本机图片OCR、产品JSON API客户端及签名通知收件辅助。真实引擎与本地受控服务组合验证通过，真实第三方账号、视觉模型效果及公网部署另验。

> [模型视觉链路完善](docs/05_PROJECT_PLAN/vision-workflow-20261029.md)：保留已有图片附件与模型传输，补齐当前调试截图的按会话读取；提供产品自有视觉API客户端与换图探针。图片已附上、模型已核对、本机协议通过和真实视觉效果分别表达。

> [通用AI服务与效率支持](docs/05_PROJECT_PLAN/ai-service-efficiency-20261029.md)：文本/图片共用AIService，公开路由模板与运行时产品Key分开，支持OpenAI聊天兼容和Anthropic消息协议；提供组件组合目录、故障现场汇总与静态关联测试候选。正式交付门不跳过，速度收益另做实测。

> 当前协作工程优先级：[通过多Agent提高实际生成质量](docs/05_PROJECT_PLAN/multi-agent-generation-quality-plan-20261030.md)。先接只读找错、候选绑定、缺陷复现/修复/复测闭环，再补视觉审阅；研究设计不作为前置。

> 当前研究与协作方向：[立项对照修订及多Agent规划](docs/05_PROJECT_PLAN/multi-agent-research-plan-20261029.md)。现役配置只留需求沟通、界面制作，旧裁判/内审入口已删；[面板改造记录](docs/05_PROJECT_PLAN/flow-routing-ui-20261029.md)。向导、制作与专业子任务均作为可消融机制，不以Agent数量或零Bug承诺作为研究目标。

> 后续模板实施总入口：[产品模板与生成效率完整计划表](docs/05_PROJECT_PLAN/product-template-roadmap-20261029.md)。覆盖8类产品模板、组件契约、诊断/选测支撑、依赖批次、里程碑和固定场景验收；优先多模态与HTTP/Webhook。B0–B8本机模板、连接器设置、组合工作台、独立资源分发与B9对照工具已实施；真实服务、干净系统及真实效率对照仍待条件。当前源码审计修复与重建包见[模板审计记录](docs/05_PROJECT_PLAN/template-audit-20261029.md)；原交付范围见[剩余批次交付记录](docs/05_PROJECT_PLAN/template-rollout-result-20261029.md)。

> 质量工程接手（2026-10-30）：[多Agent生成质量会话交接](docs/05_PROJECT_PLAN/session-handoff-quality-20261030.md)顶部已更新Q1–Q4接线与后续修复；正文旧快照不代表当前未实施。真实模型质量收益仍待验证。[模板与AI服务交接](docs/05_PROJECT_PLAN/session-handoff-templates-20261029.md)保留为此前工程背景。

> 2026-10-27：[Harness 改进计划](docs/05_PROJECT_PLAN/harness-improvement-plan-20261027.md)按验收设施、独立试用和多模型验收分批推进。需求确认时恢复可选的 AI 灵感建议，默认不选；采纳后更新任务单再确认，不额外增加需求整理的模型调用。

> 历史Harness接手（2026-10-27）：[Harness 改进交接](docs/05_PROJECT_PLAN/harness-improvement-handoff-20261027.md)，保留当时已完成版本、验证边界和剩余批次记录；当前入口以上述会话交接与模板总计划为准。

> 历史接线（2026-10-20）：平台生成Windows Python/WebView2桌面应用，[制作流程v2](docs/05_PROJECT_PLAN/production-workflow-v2-20261020.md)保留当时设计；代码清理、硬编码修复和本机旧项目清理结果见[清理实施记录](docs/05_PROJECT_PLAN/hardcoding-cleanup-execution-20261020.md)。

> 2026-10-22后续完善：[全流程实施记录](docs/05_PROJECT_PLAN/workflow-improvement-20261022.md)包含持久MVP确认、宿主原生GUI验收CLI、验证凭据复用及交付规则收敛的实现与验证边界。

> 2026-10-23接续：[确认恢复与独立验收实测](docs/05_PROJECT_PLAN/confirmation-acceptance-20261022.md)记录PRD/UX持久恢复、独立GUI规则准备、存储故障验证和真实模型试跑。自动准备目前须显式开启，真实任务结果与测试fixture结果分别记录。

---

## 1. 项目目的

本项目把 Proma 改造为面向零基础用户的软件生成平台。用户不需要理解代码、架构、数据库或测试，只需要用自然语言说明想法，并通过预览确认结果。

核心体验：

```text
两道门选择
→ 整理并确认本轮短任务单
→ 按需要确认静态界面方向
→ 连续实现、试用与局部修复
→ 宿主独立运行 GUI/CLI、能力与交付检查
→ 快速型交付；长期型确认当前里程碑后发布
→ 保留版本与数据，下一轮范围另行确认
```

平台先整理需求，再由持有持续上下文的制作负责人实现与修复；可按明确归属委派子任务。宿主独立裁定验收结果。第二个验收模型默认关闭，需要明确配置与预算；语音等能力复用成熟运行时与资源。

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
