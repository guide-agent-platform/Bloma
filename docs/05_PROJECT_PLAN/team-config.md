# 编程 Agent 团队角色配置

> 项目：向导Agent与编程Agent多智能体协同开发平台
> 文档ID：DOC-5.2
> 版本：v1.0 | 日期：2026-07-10 | 状态：已确认
> 依赖：PRD v5.0（§6.4、§12）、DOC-3.1 `architecture.md`、DOC-3.2 `component-design.md`、DOC-5.1 `sprint-plan.md`、`proma-core-demo`

---

## 1. 文档目标

本文档定义**开发本平台本身**所激活的编程 Agent 角色及其配置。注意区分：

| 本文档描述 | 不是本文档描述 |
|-----------|--------------|
| 开发"向导Agent多智能体协同开发平台"时，人类开发者调用的编程 Agent 角色 | 平台运行时为用户项目自动创建的编程 Agent 团队 |
| 平台自身的工程团队配置 | 用户项目的 Agent 配置（由工程经理按模板决定，见 PRD §12） |

所有 Agent 角色在 Proma Agent SDK 编排下运行，遵守 Proma core 的三条底层约束（详见 `proma-core-demo/README.md`）。

---

## 2. 项目类型判定

| 判定维度 | 结论 |
|---------|------|
| **用户表述** | "桌面应用"——基于 Proma (Electron) fork |
| **技术栈** | Electron 39 + React 18 + TypeScript + Jotai + Tailwind + Claude Agent SDK |
| **匹配模板** | **桌面工具**（PRD §12.3） |
| **硬约束等级** | **标准**（PRD §12.4） |
| **开发模式** | 长期迭代型（平台自身需要完整工程方法论） |

---

## 3. 激活角色清单

按 PRD §6.4 定义的编程 Agent 内部角色体系，本项目激活以下角色：

### 3.1 角色总览

| # | 角色 | 模型建议 | 激活条件 | 约束等级 |
|---|------|---------|---------|:---:|
| R1 | **全栈开发** | Claude Opus 4.x（架构/复杂逻辑）<br>Claude Sonnet 5.x（常规功能） | 始终激活 | 标准 |
| R2 | **测试工程师** | Claude Sonnet 5.x | 始终激活 | 标准 |
| R3 | **代码审查员** | Claude Sonnet 5.x | 长期迭代型必选 | 标准 |
| R4 | **安全扫描器** | 自动化脚本 + Claude Haiku 4.5 | MVP 阶段起激活 | 对开发者透明 |

> **模型选择说明**：以上建议基于 2026-07 可用模型。Opus 用于需要深度推理的架构设计和跨模块重构；Sonnet 用于常规功能开发和测试编写；Haiku 用于低成本的结构化检查。具体模型版本随 Anthropic 发布动态更新。

### 3.2 各角色职责边界

#### R1 全栈开发

| 维度 | 内容 |
|------|------|
| **职责** | 在所有 IPC 四层（shared / main / preload / renderer）产出 TypeScript 代码；实现 10 个核心模块（见 `component-design.md`） |
| **不在职责范围** | 不编写 GWT Feature 文件（由 R2 编写）；不执行裁判门禁判定（由裁判 Agent 判定）；不修改 Proma core 的 Agent SDK 编排逻辑（`orchestrator.ts`）除非架构文档明确允许 |
| **Proma core 约束** | 所有新增 IPC 通道必须从 `shared/types.ts` 常量定义开始，经 `main/ipc.ts` handler → `preload/bridge.ts` 白名单 → `renderer agent-atoms.ts` 全链路对齐。Renderer 代码不得直接 import `fs`、`path`、`child_process` |
| **Token 预算** | 复杂模块（AgentOrchestrator、ProgrammingOrchestrator）允许单次 200K+ tokens；常规功能控制在 50K tokens 内 |
| **输出物** | TypeScript 源文件、模块单元测试骨架、决策标注（见 PRD §5.4） |

#### R2 测试工程师

| 维度 | 内容 |
|------|------|
| **职责** | 为 P0 用户故事编写 GWT Feature 文件（Gherkin 格式）；编写 E2E 测试脚本；维护 `test-plan.md` 中的通过率数据；验证 Proma core 边界不被破坏 |
| **不在职责范围** | 不修改业务代码（发现 bug 交给 R1 修复）；不做裁判判定（交给裁判 Agent）；不设计测试策略（策略由 `test-plan.md` 定义，R2 执行） |
| **Proma core 约束** | 测试环境必须使用临时 `PROMA_HOME`，不得写入真实 `~/.proma/`；API Key 使用测试替身，不得在测试日志中明文出现 |
| **输出物** | `features/*.feature` 文件、E2E 测试脚本、测试报告 |

#### R3 代码审查员

| 维度 | 内容 |
|------|------|
| **职责** | 审查 R1 产出的代码 diff；检查 Proma core 边界违规（Renderer 直接访问 Node.js API、IPC 通道硬编码漂移、API Key 进入 renderer）；检查安全漏洞（XSS、注入） |
| **不在职责范围** | 不直接修改代码（标注问题位置后交 R1 修复）；不检查 PlantUML 一致性（Phase 1 不启用 PlantUML，见 PRD §16.1） |
| **审查重点** | IPC channel 是否从 shared 常量引用；`safeStorage` 是否正确使用；JSONL 追加写入不阻塞主线程；Agent 流式事件是否正确推送 Jotai atoms；权限请求是否走 `canUseTool()` + `pendingRequests Map` |
| **输出物** | 审查意见（按文件+行号标注）、Proma core 边界违规清单 |

#### R4 安全扫描器

| 维度 | 内容 |
|------|------|
| **职责** | 自动扫描代码中的 OWASP Top 10 漏洞；检查依赖项已知 CVE；验证 Electron `webPreferences` 安全配置（`nodeIntegration: false`、`contextIsolation: true`） |
| **不在职责范围** | 不修复漏洞（给出修复建议，R1 执行）；不判定是否可交付（裁判 Agent 判定） |
| **激活时机** | 每次 R1 完成一个模块或 Sprint 交付前自动运行 |
| **输出物** | 安全扫描报告、漏洞清单（含严重等级和修复建议） |

---

## 4. 角色间协作流程

### 4.1 主协作链路

```
人类开发者提出任务
       │
       ▼
┌──────────────┐
│  R1 全栈开发  │ ← 主力执行者。生成/修改代码
└──────┬───────┘
       │ 代码提交
       ▼
┌──────────────┐
│  R3 代码审查员│ ← 审查 diff。发现问题 → 标注 → 退回 R1
└──────┬───────┘
       │ 审查通过
       ▼
┌──────────────┐
│  R2 测试工程师│ ← 编写/更新 GWT Feature + E2E。测试失败 → 退回 R1
└──────┬───────┘
       │ 测试通过
       ▼
┌──────────────┐
│  R4 安全扫描器│ ← 自动安全扫描。发现漏洞 → 标注 → R1 修复 → 重新扫描
└──────┬───────┘
       │ 扫描通过
       ▼
┌──────────────┐
│  裁判 Agent   │ ← 硬约束 + 软约束判定（独立门禁）
└──────────────┘
```

### 4.2 协作规则

| 规则 | 说明 |
|------|------|
| **R1 先行** | 任何功能先由 R1 完成代码实现，R2/R3 不预先设计测试或审查标准——避免"纸上审查" |
| **R3 随动** | R1 每完成一个模块或 user story 的实现后，R3 立即审查，不等 Sprint 结束再集中审查 |
| **R2 并行** | R2 可在 R1 明确接口定义后（如 `shared/types.ts` 更新后）提前编写 Feature 骨架，具体步骤在 R1 交付后补全 |
| **R4 静默** | R4 自动运行，仅在发现高危漏洞时主动通知人类开发者 |
| **不跨角色** | R3 不替 R1 改代码，R2 不替 R1 修 bug。各角色在职责边界内独立工作 |
| **冲突升级** | R3/R2 与 R1 就某个问题是否需修复产生分歧时 → 提交人类开发者（A 角色）裁决 |

### 4.3 与人类开发者的接口

每个 Agent 角色的产出均需人类开发者在合并前确认：

| 角色 | 人类确认节点 |
|------|------------|
| R1 全栈开发 | `git diff` 审核后手动 commit |
| R2 测试工程师 | Feature 文件人类确认步骤语义正确 |
| R3 代码审查员 | 审查意见人类确认后标记为 resolved |
| R4 安全扫描器 | 高危漏洞强制人类确认，低危自动通过 |

---

## 5. 模型绑定策略

### 5.1 按任务复杂度分级

```
简单任务（单文件修改、类型定义、样式调整）
  → Claude Haiku 4.5 或 Claude Sonnet 5.x
  → Token 预算: < 20K

常规任务（单模块实现、Feature 编写、代码审查）
  → Claude Sonnet 5.x
  → Token 预算: < 50K

复杂任务（跨模块架构、AgentOrchestrator 改造、IPC 全链路）
  → Claude Opus 4.8
  → Token 预算: < 200K
```

### 5.2 模型选择决策树

```
任务是否涉及 IPC 四层链路修改？
  ├── 是 → Opus（必须确保 shared/main/preload/renderer 四层一致）
  └── 否 → 任务是否涉及 Agent SDK 编排逻辑？
            ├── 是 → Opus（编排逻辑错误会导致会话卡死/权限丢失）
            └── 否 → 任务是否跨 3 个以上模块？
                      ├── 是 → Opus 或 Sonnet（视复杂度）
                      └── 否 → Sonnet 或 Haiku（视文件数量）
```

### 5.3 视觉任务

涉及 UI 原型审查、设计系统一致性检查时，使用具备视觉能力的多模态模型（如 Claude Sonnet 5.x 带视觉）。

---

## 6. Sprint 各阶段的角色激活计划

按 `sprint-plan.md` 的 Sprint 排期：

| Sprint | 主要激活角色 | 说明 |
|--------|------------|------|
| Sprint 0 | R1（全栈开发）+ R4（安全扫描器） | 搭 Proma fork 底座。在此阶段即可运行安全扫描器验证依赖和 Electron 配置 |
| Sprint 1 | R1 + R2（测试工程师）+ R4 | 草图生成闭环。R2 开始编写 mode-selection 和 generation-workflow Feature |
| Sprint 2 | R1 + R2 + R3（代码审查员）+ R4 | MVP 与质量门禁。R3 从 Sprint 2 起激活，审查裁判引擎和自愈逻辑 |
| Sprint 3 | R1 + R2 + R3 + R4 | 全部角色激活。R3 重点审查权限队列实现、IPC 边界、埋点脱敏 |

---

## 7. 角色配置与 Proma Core 的对齐

### 7.1 Agent SDK 编排约束

所有 Agent 角色通过 `AgentOrchestrator` 统一调度（见 `proma-core-demo/main/orchestrator.ts`）：

- SDK env 以 `process.env` 为底构建，不丢失 PATH/HOME/SHELL
- 同一 session 不允许多请求并行（`activeSessions` Set 守卫）
- for-await 消费流完成后主动触发 `iterator.return()` → `cleanup()`
- HTTP 429/5xx/529 自动重试，最多 25 次，累计不超过 5 分钟

### 7.2 权限请求约束

所有角色的工具调用权限走 `canUseTool()` + `pendingRequests Map`（见 `proma-core-demo/main/permission-service.ts`）：

- `Write`/`Edit` 操作 → `warning` 级 → 人类确认
- `Bash` 含 `rm -rf`/`sudo` → `dangerous` 级 → 强制确认
- `Read`/`Glob`/`Grep` 等只读操作 → 自动放行

### 7.3 Local-First 存储约束

所有角色的持久化产出均写入 `~/.proma/` 下的 JSON/JSONL/工作区目录（见 `proma-core-demo/storage/config-paths.ts`），不使用 SQLite 等运行时数据库。

---

## 8. 硬约束规则（本项目开发专用）

以下硬约束由裁判 Agent 的自动化脚本执行，适用于**平台自身的代码仓库**：

| 检查项 | 规则 | 违反时 |
|--------|------|--------|
| IPC 通道定义 | `AGENT_IPC_CHANNELS` 等常量必须在 `shared/types.ts` 中定义，`main/ipc.ts` 和 `preload/bridge.ts` 必须引用该常量 | 编译报错（TypeScript 类型系统兜底） |
| Renderer 隔离 | `renderer/` 目录下不得出现 `import fs from 'fs'` 或 `import { ipcRenderer } from 'electron'` | R3 审查拦截 |
| API Key 隔离 | `renderer/` 目录下不得出现 `ANTHROPIC_AUTH_TOKEN`、`apiKey` 等密钥相关变量 | R4 扫描拦截 |
| safeStorage 使用 | API Key 加密必须使用 `safeStorage.encryptString()`（macOS Keychain / Windows DPAPI），不得使用自定义加密 | R3 审查拦截 |
| 存储路径 | 所有持久化路径必须以 `~/.proma/` 为根，不得硬编码绝对路径 | R3 审查拦截 |
| SQLite 禁止 | 运行时不得创建 SQLite 文件或服务端数据库连接 | R4 扫描拦截 |

---

> 本文档随开发过程中 Agent 角色配置的实际调整动态更新。角色增删和模型变更需更新本文档并标注版本。
