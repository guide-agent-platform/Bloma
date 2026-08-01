# 测试计划

> 项目：向导 Agent 多智能体协同开发平台  
> 文档ID：DOC-6.1  
> 版本：v1.1 | 日期：2026-07-25 | 状态：已完成
> 依赖：DOC-1.1 `user-stories.md`、DOC-2.5 `interaction-spec.md`、DOC-3.1 `architecture.md`、DOC-4.1 `api-spec.md`

---

## 1. 测试目标

测试体系需要证明平台在 Phase 1 中满足以下目标：

- P0 用户能完成从模式选择到可运行 MVP 的主链路。
- 草图、MVP、点选纠错、快照回滚、自愈、裁判让渡均有 GWT 验收。
- Proma core 约束不被破坏：IPC 四层、主进程密钥管理、Agent 流式状态、权限队列、Local-First 存储。
- 自动修复不会无限循环，达到上限后能熔断回滚。
- P0 用户可见文案不暴露代码、堆栈、HTTP 状态码、XSS/SQL 注入等术语。
- 科研埋点可记录、可脱敏、可离线导出。

---

## 2. 测试分层

测试文件的命名、稳定 ID、结果分类、已知失败和报告格式统一遵循 DOC-6.2 `testing-standards.md`。本文件定义测试范围和门禁，DOC-6.2 定义测试如何编写与报告。

| 层级 | 范围 | 工具建议 | 阻塞级别 |
|---|---|---|---|
| 单元测试 | 纯函数、状态机、schema 校验、错误码映射 | Vitest | PR 阻塞 |
| 主进程集成测试 | IPC handler、Local-First 存储、权限 Map、safeStorage wrapper | Vitest + Electron mock | PR 阻塞 |
| Renderer 集成测试 | Jotai atoms、全局监听器、权限队列 UI 状态 | Vitest + Testing Library | PR 阻塞 |
| MCP 工具测试 | 沙箱创建、代码写入、测试执行、快照、回滚 | Vitest / Node test | 合并前阻塞 |
| E2E 测试 | 两道门、草图、MVP、纠错、回滚、裁判让渡 | Playwright | Release 阻塞 |
| GWT 验收 | P0 用户故事和交互规格 | Cucumber / Playwright-BDD | Release 阻塞 |
| 文档一致性测试 | PRD/GWT/PlantUML/接口文档一致性 | 自定义脚本 | Release 阻塞 |
| 隐私与安全测试 | API Key、脱敏、沙箱越权、用户文案 | 自定义脚本 + Playwright | Release 阻塞 |

---

## 3. 测试范围

### 3.1 Phase 1 必测

| 模块 | 必测能力 |
|---|---|
| ModeController | 首次选择、不可返回两道门、快消升级长期 |
| WorkspaceShell | 对话区、预览区、文档区、时间轴基础展示 |
| AgentOrchestrator | `activeSessions`、SDK env merge、流式事件、JSONL 部分持久化 |
| IpcBridgeAndAtoms | IPC 常量、preload 白名单、全局监听器、atomFamily 分会话状态 |
| PermissionService | `pendingRequests` Map、用户响应 resolve、危险工具必须确认 |
| ProgrammingOrchestrator | 草图生成、MVP 生成、自动修复计数、熔断 |
| SandboxRuntime | 沙箱目录限制、预览启动、错误捕获 |
| SnapshotManager | 创建快照、线性回滚、rollback guard |
| DocumentEngine | 检查点同步 PRD/GWT/报告 |
| JudgeEngine | 硬约束、软约束、退回、让渡 |
| AnalyticsCollector | 13 类事件、JSONL 写入、脱敏 |

### 3.2 Phase 1 暂不阻塞

| 能力 | 原因 |
|---|---|
| 研究看板完整交互 | 属于 Phase 4 |
| 多工作区切换 | 对 P0 用户屏蔽 |
| 复杂插件市场管理 | 复用 Proma 能力，Phase 1 只验证不破坏 |
| 完整长期迭代项目管理 | Phase 1 只覆盖长期模式入口、规划和裁判差异 |

---

## 4. Mock 策略

| 依赖 | 单元/集成 | E2E/GWT |
|---|---|---|
| Agent SDK | 默认 mock `SDKMessage` 流、429/5xx、权限请求 | 至少 1 条 smoke 使用真实 SDK 配置，CI 可跳过 |
| 模型渠道 | mock `ChannelManager`，验证 `safeStorage` 调用 | 本地手动验收验证真实渠道 |
| `safeStorage` | mock encrypt/decrypt；验证 renderer 不接触明文 | Electron 环境 smoke |
| 文件系统 | 使用临时 `PROMA_HOME` | 使用临时 `PROMA_HOME` |
| 沙箱进程 | 单元 mock；集成启动最小静态项目 | E2E 启动真实预览 |
| 截图 | 单元 mock 路径；E2E 用 Playwright screenshot | E2E 真实截图 |
| 时间 | fake timers 测 5s/10s/60s/120s | 少量真实等待用缩短阈值配置 |

规则：

- 不允许测试写入真实 `~/.proma/`，必须设置临时 `PROMA_HOME`。
- 不允许把真实 API Key 写入测试 fixture。
- SDK mock 必须覆盖正常流、部分失败、权限请求、取消和超时。

---

## 5. CI 方案

### 5.1 Pull Request 阶段

必须通过：

- TypeScript 类型检查。
- lint。
- 单元测试。
- 主进程 IPC 集成测试。
- Renderer atoms 集成测试。
- 文档链接和 schema 校验。

建议命令：

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run docs:check
```

### 5.2 Release Candidate 阶段

必须通过：

- 全量 E2E。
- GWT 验收。
- 沙箱越权测试。
- 快照回滚事务测试。
- 埋点脱敏导出测试。

建议命令：

```bash
npm run test:e2e
npm run test:gwt
npm run test:security
npm run test:release
```

---

## 6. GWT Feature 文件

本轮创建 6 个 `.feature` 文件：

| 文件 | 覆盖 |
|---|---|
| `features/mode-selection.feature` | 两道门、模式不可切换、升级入口 |
| `features/generation-workflow.feature` | 需求澄清、草图、MVP、GWT、文档同步 |
| `features/point-correction.feature` | 点选纠错、高亮、你猜、重复纠错 |
| `features/timeline-rollback.feature` | 快照创建、确认回滚、线性回滚、事务恢复 |
| `features/self-healing-judge.feature` | 自动修复、熔断、裁判硬约束、让渡、安全问题 |
| `features/proma-core-boundary.feature` | IPC 四层、safeStorage、权限 Map、JSONL、全局监听器 |

---

## 7. 质量门禁

### 7.1 合并门禁

代码合并前必须满足：

- 新增 IPC channel 有 shared 类型、main handler、preload API、renderer consumer。
- 新增 Agent 事件有 atom 更新测试。
- 新增工具有权限等级和权限测试。
- 新增持久化只写临时 `PROMA_HOME` 下的 JSON/JSONL/文件目录。
- P0 交互变更有 GWT 场景。

### 7.2 发布门禁

发布前必须满足：

- 6 个 feature 文件全部通过。
- 自动修复失败后能回滚到最近健康快照。
- 裁判退回达到上限后用户能选择继续、接受或补充说明。
- 用户可见错误文案不包含技术细节。
- API Key 明文不会进入 renderer、日志、JSONL、埋点。
- 运行时不创建 SQLite 文件或服务端数据库连接。

---

## 8. 风险与补救

| 风险 | 表现 | 补救 |
|---|---|---|
| SDK 真实调用不稳定 | CI 偶发失败 | CI 默认 mock，真实 SDK 走 nightly smoke |
| E2E 等待时间过长 | 反馈慢 | 测试环境允许缩短阈值，但保留生产阈值单元测试 |
| Electron 测试复杂 | 本地和 CI 表现不同 | 主进程逻辑优先抽为可测试服务，Electron 只保留薄集成 |
| 生成代码不可预测 | GWT 难稳定 | 对 Agent 输出加结构化 schema，测试验证行为而非具体 UI 细节 |
| 快照文件体积大 | CI 慢 | fixture 使用小型项目，release 另跑大样本 |

---

## 9. 修订记录

| 版本 | 日期 | 修订内容 |
|------|------|----------|
| v1.0 | 2026-07-10 | 首版，定义测试分层、范围、Mock 策略、CI、GWT 文件、质量门禁和风险补救 |
| v1.1 | 2026-07-25 | 增加 DOC-6.2 测试编写与报告规范引用 |
