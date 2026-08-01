# Sprint 0/1 独立阶段测试报告

> 分支：`sprint1-A`
>
> 基线 commit：`e457bc2`（测试执行时工作区存在未提交改动）
>
> 执行时间：2026-07-25 16:18-16:37（Asia/Hong_Kong）
>
> 环境：Windows、Node.js `v24.12.0`、npm `11.6.4`、Electron `39.8.10`
>
> 测试规范：DOC-6.2 `docs/06_TESTS/testing-standards.md`

## 测试摘要

| 项目 | 结论 |
|---|---|
| 被测范围 | Sprint 0、Sprint 1 独立验收、既有回归门禁与辅助质量门禁 |
| 总体结论 | `FAIL_PRODUCT` |
| Sprint 0 | 独立验收 19/19、回归门禁 4/4、Electron smoke 1/1，全部 `PASS`；各套件分开统计 |
| Sprint 1 独立验收 | 11 项 `PASS`、6 项 `FAIL_PRODUCT`、0 项 `FAIL_TEST`、0 项 `FAIL_ENV` |
| Sprint 1 回归门禁 | 8 项 `PASS`、3 项 `FAIL_PRODUCT`；其中 2 项与独立验收指向同一产品缺陷 |
| Sprint 1 产品缺陷 | 7 个独立缺陷，共关联 9 个失败测试 ID |
| Sprint 1 阻塞 ID | `S1-STORE-001`、`S1-STORE-002`、`S1-PROJECT-004`、`S1-PROJECT-005`、`S1-PROJECT-009`、`S1-SKETCH-004`、`S1-SKETCH-006`、`S1-UI-005`、`S1-UI-006` |
| 辅助质量门禁 | 单元 24/24、集成 4/4、类型检查、文档检查、构建和差异检查均通过 |
| 环境状态 | 无阻塞性环境问题；`git diff --check` 仅报告 LF/CRLF 转换提示 |
| 仍需人工范围 | 可见桌面布局、多窗口尺寸、真实模型渠道、5 次真实草图 FIRT 中位数 |

**阶段结论：Sprint 0 的自动化阶段门禁通过；Sprint 1 因 7 个独立产品缺陷不能完成阶段验收。** 影响最大的问题是应用启动无法恢复活动项目和会话，用户重启后仍会回到模式选择页。

## 1. 独立性与执行范围

独立阶段验收位于 `tests/acceptance/`，依据 PRD、Sprint 计划、用户故事、API 规范和 GWT Feature 设计。较早建立的测试保留在 `tests/regression/`，用于证明已修复行为和已发现缺陷没有回退，不与独立验收统计混算。

### 1.1 套件与命名

| 目录 | 用途 | 命名规则 |
|---|---|---|
| `tests/unit/` | 单模块实现行为 | `<service-or-module>.test.ts` |
| `tests/integration/` | 跨模块契约与存储边界 | `<capability>-<boundary>.test.ts` |
| `tests/regression/sprintN/` | 既有行为和缺陷回归 | `<feature>-regression.test.ts(x)` 或明确边界名 |
| `tests/acceptance/sprintN/` | 当前阶段独立验收 | `<domain>-<observable-behavior>.test.ts(x)` |
| `tests/acceptance/support/` | 验收夹具与隔离环境 | 不使用 `.test` 后缀 |

本轮路径迁移：

- 原 `tests/acceptance/sprintN/` 的较早回归门禁迁移到 `tests/regression/sprintN/`。
- 原 `tests/role-c/sprintN/` 的独立验收迁移到 `tests/acceptance/sprintN/`。
- 原 `tests/role-c/support/` 迁移到 `tests/acceptance/support/`。
- Electron smoke 脚本统一命名为 `scripts/electron-startup-smoke.ps1`。

- Sprint 0：IPC 四层契约、本地优先存储、Agent 会话互斥与取消、权限隔离、密钥边界、Renderer 隔离、Electron 安全配置、项目目录初始化。
- Sprint 1：模式选择与锁定、项目创建失败、长期模式文档入口、启动恢复、快消升级、澄清选项、可交互草图、事件顺序、快照、研究埋点、沙箱路径边界、等待反馈。
- 所有文件写入测试使用临时 `PROMA_HOME`，并在 teardown 清理资源。
- 原有单元与集成测试仅按规范作为辅助质量门禁执行，不计入独立 Sprint 验收统计。
- 本次为测试专用任务，没有修改产品实现，也没有通过 `skip`、`todo`、删除测试或放宽断言隐藏产品失败。

## 2. 命令与结果

| 测试范围 | 命令 | 结果 |
|---|---|---|
| Sprint 0 回归门禁 | `npm run test:regression:sprint0` | 4/4 `PASS`，2/2 文件通过 |
| Sprint 1 回归门禁 | `npm run test:regression:sprint1` | 8 `PASS`、3 `FAIL_PRODUCT` |
| Sprint 0 独立验收与正式构建 | `npm run test:acceptance:sprint0` | 19/19 `PASS`，6/6 文件通过 |
| Sprint 0 Electron 启动 | `npm run test:electron-smoke` | `S0-UI-007` `PASS` |
| Sprint 1 独立验收 | `npm run test:acceptance:sprint1` | 11 `PASS`、6 `FAIL_PRODUCT`，5 个文件中 1 个全通过 |
| 原有单元测试辅助门禁 | `npm run test:unit` | 24/24 `PASS` |
| 原有集成测试辅助门禁 | `npm run test:integration` | 4/4 `PASS` |
| 类型检查 | `npm run typecheck` | `PASS` |
| 文档检查 | `npm run docs:check` | `PASS` |
| 差异格式检查 | `git diff --check` | `PASS`，仅 LF/CRLF 提示 |

Electron smoke 成功加载：

```text
file:///D:/QQ/TEEm/Bloma/dist/index.html
```

## 3. 功能域与测试层汇总

### Sprint 0

| 功能域 | 测试层 | 结果 |
|---|---|---|
| IPC | 跨模块契约/集成 | 3/3 `PASS` |
| PROJECT | 文件系统集成 | 1/1 `PASS` |
| STORE | 本地持久化集成 | 3/3 `PASS` |
| AGENT | 服务集成 | 3/3 `PASS` |
| PERM | 权限与并发集成 | 2/2 `PASS` |
| SECRET | 安全边界 | 3/3 `PASS` |
| UI | Renderer/Electron 边界 | 4/4 `PASS` |
| UI | 独立桌面 smoke | 1/1 `PASS`，与 19 项套件分开统计 |

### Sprint 1

| 功能域 | 测试层 | 结果 |
|---|---|---|
| PROJECT | Renderer 组件与服务集成 | 4 `PASS` / 1 `FAIL_PRODUCT` |
| STORE | Renderer 启动恢复验收 | 0 `PASS` / 1 `FAIL_PRODUCT` |
| SKETCH | 工作流集成 | 1 `PASS` / 2 `FAIL_PRODUCT` |
| UI | Renderer 组件验收 | 2 `PASS` / 2 `FAIL_PRODUCT` |
| AGENT | 工作流事件集成 | 1/1 `PASS` |
| SNAPSHOT | 文件系统集成 | 1/1 `PASS` |
| ANALYTICS | 隐私与埋点集成 | 1/1 `PASS` |
| SANDBOX | 安全边界集成 | 1/1 `PASS` |

### 回归门禁

| Sprint | 功能域 | 结果 |
|---|---|---|
| Sprint 0 | IPC、SECRET、UI | 4/4 `PASS` |
| Sprint 1 | PROJECT | 3 `PASS` / 2 `FAIL_PRODUCT` |
| Sprint 1 | STORE | 0 `PASS` / 1 `FAIL_PRODUCT` |
| Sprint 1 | SKETCH | 2/2 `PASS` |
| Sprint 1 | UI | 3/3 `PASS` |

回归与独立验收存在有意重叠，用于从不同层级验证同一缺陷；报告按测试 ID 分别记录，但按缺陷 ID 去重统计产品问题。

## 4. Sprint 1 产品失败

| 测试 ID | 测试标题 | 分类 | 缺陷 ID | 结论 | 证据 | 负责人/目标 |
|---|---|---|---|---|---|---|
| `S1-STORE-002` | 启动时存在活动项目应恢复项目与会话而不是显示两道门 | `FAIL_PRODUCT` | `BUG-S1-004` | App 启动不调用项目列表或恢复 API，活动项目和会话无法恢复 | `tests/acceptance/sprint1/project-persistence-upgrade.test.tsx` | A+B / Sprint 1 |
| `S1-PROJECT-009` | 快消项目升级前应先创建 upgrade 快照再切换模式 | `FAIL_PRODUCT` | `BUG-S1-005` | `upgradeProject` 直接切换模式，没有先创建 `upgrade` 快照 | `tests/acceptance/sprint1/project-persistence-upgrade.test.tsx` | A / Sprint 1 |
| `S1-SKETCH-004` | 模糊需求应给出不超过三个非技术选项并包含“你帮我决定” | `FAIL_PRODUCT` | `BUG-S1-006` | 澄清卡片把问题类别当成答案选项，灰色问题说明被拼入用户回复，且缺少“你帮我决定” | `tests/acceptance/sprint1/sketch-clarification.test.ts` | A+B / Sprint 1 |
| `S1-SKETCH-006` | 草图应是含内联 CSS 与 JS 的单文件可交互 HTML | `FAIL_PRODUCT` | `BUG-S1-007` | 生成 HTML 有内联 CSS，但没有脚本和有效交互 | `tests/acceptance/sprint1/sketch-delivery.test.ts` | A / Sprint 1 |
| `S1-UI-005` | 等待反馈应在超过 5 秒后出现并包含安全感说明 | `FAIL_PRODUCT` | `BUG-S1-008` | 等待提示立即出现，超过 5 秒后的文案也缺少安全感说明 | `tests/acceptance/sprint1/waiting-feedback.test.tsx` | B / Sprint 1 |
| `S1-UI-006` | 超过 120 秒时应提供继续等待和查看已有部分两个操作 | `FAIL_PRODUCT` | `BUG-S1-009` | `WaitingFeedback` 有操作能力，但 `App.tsx` 未连接两个回调，真实流程不可用 | `tests/acceptance/sprint1/waiting-feedback.test.tsx` | B / Sprint 1 |
| `S1-PROJECT-005` | 已完成的快消型项目应显示升级为长期模式的入口 | `FAIL_PRODUCT` | `BUG-S1-010` | 已完成快消项目没有升级入口和确认流程 | `tests/regression/sprint1/mode-workspace-regression.test.tsx` | B / Sprint 1 |

回归别名 `S1-STORE-001 -> BUG-S1-004`、`S1-PROJECT-004 -> BUG-S1-005`，与独立验收分别验证相同产品缺陷。所有失败均保留严格断言，可通过 `npm run test:acceptance:sprint1` 和 `npm run test:regression:sprint1` 复现。当前结果中没有 `FAIL_TEST` 或 `FAIL_ENV`。

## 5. 追踪关系

- GWT 已使用同一稳定 ID 标记相关场景：`S0-IPC-005`、`S0-SECRET-005`、`S0-AGENT-004`、`S0-AGENT-005`、`S0-PERM-001`、`S0-UI-004`、`S0-STORE-004`、`S0-STORE-005`。
- Sprint 1 GWT 对应：`S1-PROJECT-006` 至 `S1-PROJECT-010`、`S1-SKETCH-004`、`S1-SKETCH-006`、`S1-UI-005`、`S1-UI-006`。
- 9 个失败测试 ID 均已建立 `测试 ID -> 缺陷 ID` 映射，按缺陷 ID 去重后为 7 个产品缺陷。

## 6. 人工与真实环境待验收

以下范围不计入本轮自动化命令统计，也没有被标记为自动通过：

| 测试 ID | 待验收内容 | 完成条件 |
|---|---|---|
| `S0-UI-002` | 可见 Electron 窗口、标题、菜单、缩放和重开 | 在真实桌面操作并留存结果 |
| `S1-UI-004` | 1280x820、1920x1080 和最小窗口布局 | 无重叠、裁切或不可点击控件 |
| `S1-SKETCH-003` | 连续 5 次真实草图生成 FIRT | 中位数 `< 60 秒`，预览可点击 |
| `S1-AGENT-001` | 真实模型渠道 | 使用用户测试 Key 验证流式、取消、重试与脱敏 |

## 7. 剩余风险

- Jotai 在测试输出中提示 `atomFamily` 已弃用；当前不阻塞，但升级 Jotai v3 前需要迁移到 `jotai-family`。
- Electron smoke 只验证进程启动和 Renderer URL，不等同于完整视觉 E2E。
- Sprint 1 的 7 个产品缺陷关闭前，不得宣称 Sprint 1 阶段验收通过。
