# Sprint 计划

> 项目：向导 Agent 多智能体协同开发平台  
> 文档ID：DOC-5.1  
> 版本：v1.1 | 日期：2026-07-10 | 状态：已完成  
> 依赖：DOC-1.1 `user-stories.md`、DOC-3.1 `architecture.md`、DOC-4.1 `api-spec.md`、DOC-6.1 `test-plan.md`

---

## 1. 计划目标

Phase 1 的目标是交付一个可验证的桌面端核心闭环：

```text
两道门选择
→ 自然语言澄清
→ 验证草图
→ 用户确认或点选纠错
→ MVP 生成
→ 沙箱运行
→ GWT 测试
→ 裁判审查
→ 快照/回滚
→ 埋点记录
```

团队规模固定为三人，每个 Sprint 不超过 2 周。三人分工如下：

| 角色 | 职责 |
|---|---|
| A：工程负责人 / 全栈 | Proma fork、主进程、IPC、AgentOrchestrator、权限服务、沙箱运行、MCP 工具 |
| B：前端 / UX 工程 | 工作区 UI、Jotai atoms、全局监听器、预览区、点选纠错、时间轴、P0 用户文案 |
| C：测试 / 研究工程 | GWT Feature、E2E、文档一致性、埋点、脱敏导出、研究指标校验 |

协作原则：

- A 先保证 Proma core 边界和主链路可运行。
- B 与 A 并行实现 UI 和 renderer 状态，但不绕过 preload/IPC。
- C 从 Sprint 0 开始同步建立测试和埋点，不等功能全部完成后再补。
- 每个 Sprint 都必须三人共同参与验收：A 看运行链路，B 看 P0 体验，C 看测试与数据。

---

## 2. 总体排期

| Sprint | 周期 | 主题 | 主要成果 |
|---|---|---|---|
| Sprint 0 | 1 周 | Proma core 对齐与开发底座 | 可运行 fork、IPC 基线、Local-First 存储、测试框架 |
| Sprint 1 | 2 周 | 草图生成闭环 | 两道门、对话、Agent 流、草图、预览、草图快照 |
| Sprint 2 | 2 周 | MVP 与质量门禁 | MVP 生成、沙箱运行、GWT、自动修复、裁判基础 |
| Sprint 3 | 2 周 | 纠错、回滚与研究数据 | 点选纠错、时间轴回滚、权限队列、埋点、发布验收 |

---

## 3. Sprint 0：Proma Core 对齐与开发底座

### 目标

把 `proma-core-demo` 的核心能力稳定迁入项目骨架，避免后续功能在错误架构上生长。

### 交付物

| 交付物 | 负责人 | 说明 |
|---|---|---|
| Electron fork 可启动 | A | 保留 Proma 窗口、菜单、基础生命周期 |
| `shared/types.ts` IPC 常量 | A | 覆盖 DOC-4.1 定义的 Phase 1 channel |
| `main/ipc.ts` handler 骨架 | A | 完成参数校验、统一 `ApiResult` |
| `preload/bridge.ts` 白名单 API | A + B | 只暴露 `window.electronAPI` |
| `renderer/agent-atoms.ts` | B | 建立 `atomFamily(sessionId)` 和全局监听器 |
| Local-First 存储适配 | A | 支持临时 `PROMA_HOME`、JSON、JSONL、工作区目录 |
| safeStorage wrapper | A | 渠道 API Key 加密、解密、测试替身 |
| 测试基础设施 | C | Vitest、Testing Library、Playwright 或预留脚本 |
| Proma core 边界测试骨架 | C | 覆盖 IPC、safeStorage、env、JSONL、权限 Map |

### 验收标准

- `proma-core-boundary.feature` 中 IPC、safeStorage、env、JSONL 相关场景有可执行测试骨架。
- Renderer 无法直接访问 `fs`、`path`、`child_process`。
- 新增 IPC channel 不存在硬编码漂移。
- 测试环境不会写入真实 `~/.proma/`。
- `npm run typecheck`、`npm run test:unit` 可运行。

### 风险

| 风险 | 处理 |
|---|---|
| 原 Proma 结构与新文档命名不一致 | 以 `shared/types.ts` 建立适配层，不在业务层散落转换 |
| Electron 测试复杂 | 主逻辑抽成普通 TS service，Electron 层保持薄 |

---

## 4. Sprint 1：草图生成闭环

### 目标

让 P0 用户可以选择模式、输入需求，并在预览区看到可交互验证草图。

### 用户故事

- U-01：两道门模式选择。✅ 已实现（`ModeSelectionPage`）
- GA-01：自然语言澄清需求。✅ 已实现（`GuideAgentService` + ChatPanel）
- PA-01：从需求生成可运行验证草图。✅ 已实现（`generate_sketch` + PreviewPanel）
- UX：等待反馈、预览展示、草图快照。✅ 已实现
- GA-03：从对话中自动整理需求文档。⚠️ 部分：历史"读取"半边已实现（`agent:list-sessions` / `agent:load-messages` + 回访恢复），检查点"提取/更新 PRD 文档"未实现，**规划为下一阶段待办故事**

### 已实现进度（截至 2026-08-07）

Sprint 1 主要交付物已落地；"历史对话管理"补齐了后端读取半边与前端回访恢复：

- ✅ `agent:list-sessions` / `agent:load-messages` IPC 通道 + `main/session-service.ts`（`agent-sessions.json` 索引、`last_session_id` 回填、历史消息尾部截取）
- ✅ renderer 启动/回访恢复：以 `project.last_session_id` 续接会话并加载历史，加载期对话区显示骨架占位（sitemap §2.6）；`agentSessionsAtom` 随流事件同步追加
- ✅ `S0-UI-005` renderer 启动顺序断言修复；`config-paths.ts` Conversation 死代码清理（统一为 Agent 会话术语）
- ⚠️ 待办（后续 Sprint）：GA-03 检查点自动从对话历史提取并更新需求文档（读取半边已就绪，提取/更新未实现）

### 交付物

| 交付物 | 负责人 | 说明 |
|---|---|---|
| 两道门页面 | B | 快消型、长期迭代型入口 |
| 工作区 Shell | B | 左对话、右预览、顶部阶段状态 |
| ChatPanel | B | 用户输入、卡片问题、等待反馈 |
| Agent send/stream | A | `agent:send-message`、`agent:stream-event` 完整链路 |
| `GuideAgentService` 初版 | A | 最多 3 个澄清问题；需求足够时创建草图任务 |
| `generate_sketch` 工具 | A | 生成单文件 HTML 草图 |
| Sandbox 预览 | A + B | 静态 HTML 或本地服务预览 |
| 草图快照 | A | 草图完成后创建 `sketch` 快照 |
| 埋点 | C | `project_created`、`conversation_submitted`、`sketch_generated` |
| Sprint 1 GWT/E2E | C | 覆盖模式选择、澄清、草图、等待反馈 |

### 验收标准

- `mode-selection.feature` 全部场景通过。
- `generation-workflow.feature` 中需求澄清、草图生成、等待反馈场景通过。
- 草图生成目标 FIRT 中位数 < 60 秒。
- 用户可见文案不出现代码、日志、堆栈。
- 草图快照包含截图、摘要、创建时间。

### 退出条件

- 一名内部测试用户能从空状态生成草图。
- 关闭并重启应用后，项目和会话仍可恢复。

---

## 5. Sprint 2：MVP 与质量门禁

### 目标

从已确认草图生成可运行 MVP，并通过 GWT 测试和裁判基础检查。

### 用户故事

- PA-02：从规约生成完整 MVP。
- PA-03：生成并执行 GWT。
- PA-04：自动修复运行和测试错误。
- JA-01：裁判硬约束检查。
- JA-02：裁判软约束评估。
- GA-03：从对话中自动整理需求文档（⚠️ 从 Sprint 1 顺延：历史读取半边已完成，检查点提取/更新 PRD 文档在此 Sprint 或后续排期）。

### 交付物

| 交付物 | 负责人 | 说明 |
|---|---|---|
| 草图确认接口 | A | `project:confirm-sketch` |
| DocumentEngine 初版 | A + C | 草图确认后同步 PRD，MVP 前同步 GWT |
| `generate_mvp` 工具 | A | 正式项目目录、启动命令、风险说明 |
| SandboxRuntime 增强 | A | 运行命令、端口管理、错误摘要 |
| GWTTestRunner | C | 生成和执行 Feature 场景 |
| 自动修复计数 | A | runtime/test repair 最多 3 次 |
| JudgeEngine 基础 | A + C | PRD 必填、GWT 覆盖、基础软约束 |
| MVP 预览状态 | B | MVP 生成、测试、裁判状态在 UI 中可理解 |
| MVP 快照 | A | MVP 通过后创建 `mvp` 快照 |
| 埋点 | C | `mvp_delivered`、`programming_execution`、`judge_verdict` |

### 验收标准

- `generation-workflow.feature` 中 MVP、GWT 场景通过。
- `self-healing-judge.feature` 中自动修复、硬约束、GWT 覆盖场景通过。
- MVP 在沙箱中启动无错误。
- 每个 P0 功能项至少有 1 个 GWT 场景。
- 裁判退回不直接修改代码，只产生判定和修复任务。

### 退出条件

- 从草图确认到 MVP 预览的主链路可演示。
- MVP 失败时能自动修复或给出 P0 可读状态。

---

## 6. Sprint 3：纠错、回滚与研究数据

### 目标

补齐用户修改闭环、失败保护、权限确认和研究数据采集，达到 Phase 1 可发布标准。

### 用户故事

- U-04：点选纠错。
- U-07 / U-09：快照与回滚。
- PA-05：熔断回滚。
- JA-03：裁判让渡。
- JA-04：安全问题独立计数。
- 研究者：13 类埋点事件。

### 交付物

| 交付物 | 负责人 | 说明 |
|---|---|---|
| PreviewInteractionLayer | B | DOM 点击、高亮、区域降级 |
| 点选纠错弹窗 | B | 用户说明、“你猜”、重复纠错追问 |
| `project:submit-correction` | A | 纠错上下文进入 Agent 修复链路 |
| TimelinePanel | B | 快照展开、当前版本、回滚确认 |
| Snapshot rollback | A | `rollback_guard`、事务恢复、线性回滚 |
| PermissionService | A | `pendingRequests` Map、危险工具确认 |
| 安全扫描基础 | A + C | 用户文案不暴露 XSS/SQL 注入 |
| AnalyticsCollector | C | 13 类事件写入 `analytics.jsonl` |
| Release E2E | C | 6 个 Feature 全量跑通 |
| 发布体验审查 | B + C | P0 文案、错误提示、等待反馈、研究数据质量 |

### 验收标准

- `point-correction.feature` 全部场景通过。
- `timeline-rollback.feature` 全部场景通过。
- `self-healing-judge.feature` 中熔断、让渡、安全场景通过。
- `proma-core-boundary.feature` 全部场景通过。
- 自动修复 3 次失败后回滚到最近健康快照。
- API Key 明文不进入 renderer、日志、JSONL、埋点。
- 运行时不创建 SQLite 文件或服务端数据库连接。

### 退出条件

- Phase 1 演示脚本完整跑通。
- 发布门禁测试通过。
- 研究埋点样本可脱敏导出。

---

## 7. 跨 Sprint 里程碑

| 里程碑 | 达成时间 | 判定标准 |
|---|---|---|
| M1：Proma core 底座稳定 | Sprint 0 结束 | IPC、safeStorage、Local-First、atoms 测试通过 |
| M2：草图闭环可演示 | Sprint 1 结束 | 从模式选择到草图预览可连续操作 |
| M3：MVP 闭环可演示 | Sprint 2 结束 | 草图确认到 MVP、GWT、裁判可连续操作 |
| M4：Phase 1 可发布 | Sprint 3 结束 | 6 个 Feature 通过，回滚、权限、埋点完成 |

---

## 8. 依赖与并行策略

| 工作 | 可并行性 | 依赖 |
|---|---|---|
| UI Shell 与 IPC 类型 | A/B 可并行 | DOC-4.1 |
| AgentOrchestrator 与 atoms | A/B 强依赖协作 | Proma core |
| 草图工具与沙箱预览 | A/B 可并行 | Local-First 路径 |
| MVP 生成与文档同步 | A/C 部分并行 | 草图确认事件 |
| GWT 与裁判 | A/C 可并行 | PRD/GWT 文档结构 |
| 点选纠错与快照时间轴 | A/B 可并行 | 预览区和快照接口 |
| 埋点与研究导出 | C 主导，A 提供写入接口 | Analytics schema |

---

## 9. 每日检查清单

- 当前改动是否仍走 IPC 四层链路。
- 是否有 renderer 直接访问 Node.js、文件系统或 API Key。
- 是否有运行时 SQLite 或服务端数据库假设。
- Agent 事件是否按 `session_id` 进入 Jotai atom。
- 用户可见文案是否对 P0 用户友好。
- 新增行为是否有 GWT 或单元测试覆盖。
- 高风险操作前是否创建快照。

---

## 10. Phase 1 不做事项

| 不做事项 | 原因 |
|---|---|
| 多工作区管理 UI | P0 用户不需要，且 Proma 已有底层能力 |
| 完整研究看板 | 放到 Phase 4，Phase 1 只记录数据 |
| 完整插件市场 | 复用 Proma，Phase 1 只新增本平台 MCP/Skill |
| 面向用户的代码编辑器 | P0 用户默认不看代码 |
| 运行时 SQLite | 与 Proma Local-First JSON/JSONL 约束冲突 |

---

## 11. 修订记录

| 版本 | 日期 | 修订内容 |
|------|------|----------|
| v1.0 | 2026-07-10 | 首版，定义 Phase 1 四个 Sprint、交付物、验收标准、退出条件、里程碑和并行策略 |
| v1.1 | 2026-07-10 | 将团队配置修正为固定三人分工，明确 A/B/C 负责人，并移除 2 人降级说明 |
