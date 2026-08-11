# Sprint 0/1 独立阶段测试报告

> 分支：`sprint1-A`
>
> 基线 commit：`e457bc2`（测试执行时工作区存在未提交改动）
>
> 执行时间：2026-07-25 16:18-16:37（Asia/Hong_Kong）
>
> E2E 补充基线：`87c83e7`（新增测试尚未提交）
>
> E2E 补充执行：2026-07-25 17:54-17:55（Asia/Hong_Kong）
>
> 环境：Windows、Node.js `v24.12.0`、npm `11.6.4`、Electron `39.8.10`
>
> 测试规范：DOC-6.2 `docs/06_TESTS/testing-standards.md`

## 测试摘要

| 项目 | 结论 |
|---|---|
| 被测范围 | Sprint 0、Sprint 1 独立验收、既有回归门禁、Playwright Electron E2E 与辅助质量门禁 |
| 总体结论 | `FAIL_PRODUCT` |
| Sprint 0 | 独立验收 19/19、回归门禁 4/4、Electron smoke 1/1，全部 `PASS`；各套件分开统计 |
| Sprint 1 独立验收 | 11 项 `PASS`、6 项 `FAIL_PRODUCT`、0 项 `FAIL_TEST`、0 项 `FAIL_ENV` |
| Sprint 1 回归门禁 | 8 项 `PASS`、3 项 `FAIL_PRODUCT`；其中 2 项与独立验收指向同一产品缺陷 |
| Sprint 1 Electron E2E | 3 项 `PASS`、5 项 `FAIL_PRODUCT`、0 项 `FAIL_TEST`、0 项 `FAIL_ENV` |
| Sprint 1 产品缺陷 | 7 个独立缺陷，共关联 14 个失败测试 ID |
| Sprint 1 阻塞 ID | `S1-STORE-001`、`S1-STORE-002`、`S1-STORE-003`、`S1-PROJECT-004`、`S1-PROJECT-005`、`S1-PROJECT-009`、`S1-SKETCH-004`、`S1-SKETCH-006`、`S1-SKETCH-007`、`S1-SKETCH-008`、`S1-SKETCH-009`、`S1-UI-005`、`S1-UI-006`、`S1-UI-009` |
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
| `tests/e2e/sprintN/` | 真实 Electron 用户流程 | `<capability>.e2e.ts` |

本轮路径迁移：

- 原 `tests/acceptance/sprintN/` 的较早回归门禁迁移到 `tests/regression/sprintN/`。
- 原 `tests/role-c/sprintN/` 的独立验收迁移到 `tests/acceptance/sprintN/`。
- 原 `tests/role-c/support/` 迁移到 `tests/acceptance/support/`。
- Electron smoke 脚本统一命名为 `scripts/electron-startup-smoke.ps1`。
- Sprint 1 GWT 补齐验收场景，并新增 8 条带独立稳定 ID 的 Playwright Electron E2E。

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
| Sprint 1 Electron E2E | `npm run test:e2e:sprint1` | 3 `PASS`、5 `FAIL_PRODUCT`，2 个文件均完成执行 |
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

### Sprint 1 Electron E2E

| 功能域 | 结果 |
|---|---|
| PROJECT | 2/2 `PASS` |
| STORE | 0 `PASS` / 1 `FAIL_PRODUCT` |
| SKETCH | 0 `PASS` / 3 `FAIL_PRODUCT` |
| UI | 0 `PASS` / 1 `FAIL_PRODUCT` |
| ANALYTICS | 1/1 `PASS` |

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
| `S1-STORE-003` | Electron 重启后应恢复活动项目而不是重新显示两道门 | `FAIL_PRODUCT` | `BUG-S1-004` | 真实 Electron 重启后找不到工作区，重新显示两道门 | `tests/e2e/sprint1/mode-selection.e2e.ts` | A+B / Sprint 1 |
| `S1-SKETCH-007` | Electron 中模糊需求应包含“你帮我决定” | `FAIL_PRODUCT` | `BUG-S1-006` | 真实窗口只显示三个问题类别，没有“你帮我决定” | `tests/e2e/sprint1/sketch-workflow.e2e.ts` | A+B / Sprint 1 |
| `S1-SKETCH-008` | Electron 中明确需求应生成含脚本的可交互草图 | `FAIL_PRODUCT` | `BUG-S1-007` | 真实预览可加载 HTML 和按钮，但文档中不存在 `<script>` | `tests/e2e/sprint1/sketch-workflow.e2e.ts` | A / Sprint 1 |
| `S1-SKETCH-009` | 点击澄清选项时灰色说明不应被拼入用户回复 | `FAIL_PRODUCT` | `BUG-S1-006` | 点击“主要目标”后实际持久化为“主要目标：这个软件最重要的是帮你完成什么？” | `tests/e2e/sprint1/sketch-workflow.e2e.ts` | A+B / Sprint 1 |
| `S1-UI-009` | Electron 中等待反馈应在超过五秒后出现 | `FAIL_PRODUCT` | `BUG-S1-008` | 延迟 Agent 响应后等待卡片立即出现，没有等待五秒 | `tests/e2e/sprint1/sketch-workflow.e2e.ts` | B / Sprint 1 |

回归与 E2E 别名：`S1-STORE-001`、`S1-STORE-003 -> BUG-S1-004`；`S1-PROJECT-004 -> BUG-S1-005`；`S1-SKETCH-007`、`S1-SKETCH-009 -> BUG-S1-006`；`S1-SKETCH-008 -> BUG-S1-007`；`S1-UI-009 -> BUG-S1-008`。所有失败均保留严格断言，可通过 `npm run test:acceptance:sprint1`、`npm run test:regression:sprint1` 和 `npm run test:e2e:sprint1` 复现。Playwright 截图、错误上下文和 trace 位于本地忽略目录 `test-results/playwright/`。最终有效结果中没有 `FAIL_TEST` 或 `FAIL_ENV`。

## 5. 追踪关系

- GWT 已使用同一稳定 ID 标记相关场景：`S0-IPC-005`、`S0-SECRET-005`、`S0-AGENT-004`、`S0-AGENT-005`、`S0-PERM-001`、`S0-UI-004`、`S0-STORE-004`、`S0-STORE-005`。
- Sprint 1 GWT 已补齐项目模式、启动恢复、P0 文案、澄清、草图、事件顺序、快照、沙箱、埋点、等待反馈和 Electron E2E 场景。
- 8 条带 `@e2e` 标签的 GWT 场景与 `tests/e2e/sprint1/` 中 8 个独立稳定 ID 一一对应。
- 14 个失败测试 ID 均已建立 `测试 ID -> 缺陷 ID` 映射，按缺陷 ID 去重后仍为 7 个产品缺陷。

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
- Sprint 1 Electron E2E 已覆盖两道门、启动恢复、澄清、草图预览、等待反馈和埋点，但多窗口尺寸与真实模型渠道仍需人工验收。
- Sprint 1 的 7 个产品缺陷关闭前，不得宣称 Sprint 1 阶段验收通过。

## 8. `9a7ad4d` 修复后复验

> 执行时间：2026-07-25 21:43-22:51（Asia/Hong_Kong）
>
> 当前基线：`9a7ad4d`，工作区包含未提交测试与文档改动
>
> 说明：第 1-7 节保留修复前的历史结果，本节记录当前有效结果，不覆盖原始缺陷证据。

### 8.1 复验摘要

| 项目 | 当前结论 |
|---|---|
| Sprint 1 回归 | 11/11 `PASS` |
| Sprint 1 独立验收 | 17/17 `PASS` |
| Sprint 1 Electron E2E | 最终 8/8 `PASS` |
| 质量门禁 | `typecheck`、`docs:check`、`git diff --check` 均 `PASS`；差异检查仅有 LF/CRLF 提示 |
| 测试执行缺陷 | 首次 E2E 复验出现 1 项 `FAIL_TEST`：`S1-SKETCH-009` 使用已过期的 `card-option-goal` 和“主要目标”；修正为验证任一选项的标题/说明分离后通过 |
| 当前自动化结论 | 当前可执行断言全部通过，没有未豁免的 `FAIL_PRODUCT`、`FAIL_TEST` 或 `FAIL_ENV` |
| 审计保留意见 | 仍有 Sprint 归属、项目导航、启动入口、等待文案时点等需求冲突；自动化全通过不等于所有真实产品要求已确认 |

### 8.2 E2E 夹具与失败分类

1. 原 fixture 与手动 Electron 共用用户目录，`firstWindow()` 因 `DevToolsActivePort` 拒绝访问而超时，分类为 `FAIL_TEST/FAIL_ENV`。
2. fixture 改为在临时 `PROMA_HOME` 下隔离 Electron `userData`，并保证 setup 失败时也执行进程和目录清理。
3. 修正后首轮 E2E 为 7 `PASS` / 1 `FAIL_TEST`。失败页面已显示新的生活化澄清选项，测试却等待旧 ID，因此不是产品失败。
4. `S1-SKETCH-009` 改为读取实际选项标题和灰色说明，点击后检查 session JSONL 只保存标题。最终完整 E2E 8/8 `PASS`。

测试设计错位的逐功能依据、代理断言和五项待确认需求见 `docs/06_TESTS/reports/s0-s1-test-design-audit-2026-07-25.md`。
