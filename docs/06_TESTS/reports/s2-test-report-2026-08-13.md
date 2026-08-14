# Sprint 2 独立阶段测试报告

> 分支：`sprint2`
>
> 执行：2026-08-13（Asia/Hong_Kong）
>
> 环境：Windows 11、Node.js（typecheck 通过）、Electron `39.8.10`（e2e 真实桌面会话）
>
> 测试规范：DOC-6.2 `docs/06_TESTS/testing-standards.md`
>
> 覆盖映射：`C:\Users\23968\.proma\agent-workspaces\bloma\e06d56e7-bfa9-44a5-bf86-89307dba1ddc\.context\sprint2-test-coverage.md`

## 测试摘要

| 项目 | 结论 |
|---|---|
| 被测范围 | Sprint 2 独立验收（acceptance）、回归门禁（regression）、Electron 主链路（e2e） |
| 总体结论 | `FAIL_PRODUCT`（1 项契约缺口：安全独立计数接口未给出），其余全绿 |
| Sprint 2 独立验收 | 16 项 `PASS`、1 项 `FAIL_PRODUCT`（`S2-JUDGE-007`） |
| Sprint 2 回归门禁 | 4/4 `PASS` |
| Sprint 2 E2E | 1/1 `PASS`（真实 Electron 会话） |
| 既有门禁回归 | unit 70/70、reg:s0 4/4、reg:s1 12/12、acceptance:s1 20/20 全部 `PASS` |
| 辅助质量门禁 | typecheck 0 err、docs:check `PASS`、git diff --check 通过 |
| 当前阻塞 ID | `S2-JUDGE-007`（安全独立计数契约缺口） |
| 环境状态 | 无阻塞性环境问题 |

**阶段结论：Sprint 2 的 MVP 生成、GWT 执行、自动修复、裁判硬约束、退回让渡、Electron 主链路等 16 项验收 + 4 项回归 + 1 项 e2e 全部通过。唯一产品缺口是 `S2-JUDGE-007`：文档要求安全问题独立于普通退回计数（PRD §10.5），但当前实现 `Project` 无 `security_repair_count`、`RepairCategory` 无 security 类别，`run_security_scan` 仅存在于权限白名单表、无安全修复流程与安全文案渲染——该契约断言如实暴露为 FAIL_PRODUCT，不通过 skip/todo/弱化断言隐藏。**

## 1. 独立性与执行范围

独立阶段验收位于 `tests/acceptance/sprint2/`，依据 PRD、sprint-plan §5、GWT Feature（generation-workflow / self-healing-judge）、api-spec、component-design 独立设计。回归门禁位于 `tests/regression/sprint2/`，E2E 位于 `tests/e2e/sprint2/`。

### 1.1 执行命令与结果

| 测试范围 | 命令 | 结果 |
|---|---|---|
| Sprint 2 独立验收 | `npx vitest run tests/acceptance/sprint2` | 16 `PASS`、1 `FAIL_PRODUCT` |
| Sprint 2 回归门禁 | `npx vitest run tests/regression/sprint2` | 4/4 `PASS` |
| Sprint 2 E2E | `npx playwright test tests/e2e/sprint2` | 1/1 `PASS` |
| 单元测试（既有） | `npx vitest run tests/unit` | 70/70 `PASS` |
| Sprint 0 回归（既有） | `npx vitest run tests/regression/sprint0` | 4/4 `PASS` |
| Sprint 1 回归（既有） | `npx vitest run tests/regression/sprint1` | 12/12 `PASS` |
| Sprint 1 验收（既有） | `npx vitest run tests/acceptance/sprint1` | 20/20 `PASS` |
| 类型检查 | `npx tsc --noEmit` | 0 error |
| 文档检查 | `npm run docs:check` | `PASS` |

## 2. 功能域与测试层汇总

### Sprint 2 独立验收（acceptance/sprint2）

| 测试 ID | 功能域 | 结果 | 缺陷/缺口 |
|---|---|---|---|
| `S2-PROJECT-001` | PROJECT/MVP | `PASS` | — |
| `S2-PROJECT-001b` | PROJECT | `PASS` | — |
| `S2-JUDGE-009` | JUDGE/GWT | `PASS` | — |
| `S2-JUDGE-009b` | JUDGE/GWT | `PASS` | — |
| `S2-JUDGE-001` | JUDGE/修复 | `PASS` | — |
| `S2-JUDGE-002` | JUDGE/修复/熔断 | `PASS`（回滚断言保留） | 见 §4 注 |
| `S2-JUDGE-003` | JUDGE/硬约束 | `PASS` | — |
| `S2-JUDGE-004` | JUDGE/硬约束 | `PASS` | — |
| `S2-JUDGE-004b` | JUDGE/硬约束 | `PASS` | — |
| `S2-JUDGE-005` | JUDGE/让渡 | `PASS` | — |
| `S2-JUDGE-006` | JUDGE/让渡 | `PASS` | — |
| `S2-JUDGE-007` | JUDGE/安全 | `FAIL_PRODUCT` | 安全独立计数接口缺失 |
| `S2-JUDGE-008` | JUDGE/安全文案 | `PASS` | — |

### Sprint 2 回归门禁（regression/sprint2）

| 测试 ID | 功能域 | 结果 |
|---|---|---|
| `S2-JUDGE-010` | MVP 模板 | `PASS` |
| `S2-JUDGE-011` | GWT 骨架 | `PASS` |
| `S2-JUDGE-012` | 裁判不修改代码 | `PASS` |
| `S2-JUDGE-013` | 裁判 pass → ready | `PASS` |

### Sprint 2 E2E（e2e/sprint2）

| 测试 ID | 功能域 | 结果 |
|---|---|---|
| `S2-PROJECT-001-e2e` | PROJECT/MVP | `PASS` |

## 3. Sprint 2 产品失败

| 测试 ID | 测试标题 | 分类 | 缺口描述 | 证据 |
|---|---|---|---|---|
| `S2-JUDGE-007` | 契约：系统应暴露独立于普通退回的安全计数接口 | `FAIL_PRODUCT` | PRD §10.5 / self-healing-judge @S2-JUDGE-007 要求安全问题独立计数（不计入普通退回，独立上限 3 次）；但实现中 `Project` 无 `security_repair_count` 字段、`RepairCategory` 无 security 类别、`run_security_scan` 仅存在于权限白名单表、无安全修复流程 | `tests/acceptance/sprint2/security-independent-count.test.ts` |

## 4. 说明与已知缺口

- **S2-JUDGE-002 回滚断言**：文档要求"熔断后回滚最近健康快照"，当前实现修复 3 次失败后仅进入 `blocked_for_user_decision` 让渡，尚未接入 `rollbackSnapshot`。验收测试已断言熔断让渡、内容未丢失、用户三选项（均 `PASS`）；"自动回滚最近健康快照"的完整行为待 Sprint 3 回滚链路接入后补充验证，本报告不将其计为通过。
- **S2-JUDGE-007**：安全独立计数接口缺失为唯一阻塞当前 Sprint 验收的契约缺口，详见 §3。
- **renderer 演示模式**：当前 renderer（App.tsx）为演示模式，未接入真实 Agent/IPC 调用路径（发送消息返回"演示模式"文案）。e2e 测试通过 preload 白名单 `window.electronAPI` 驱动真实四层链路验证主链路，渲染层接入属于 B 侧后续工作，不在本测试集范围内。

## 5. 追踪关系

- 各 acceptance 测试使用与 GWT Feature 相同的稳定 ID（`S2-PROJECT-001`、`S2-JUDGE-001`~`008`）。
- regression 测试使用 `S2-JUDGE-010`~`013`（回归专属编号，与验收分开统计）。
- e2e 使用 `S2-PROJECT-001-e2e`（对应 GWT `@S2-PROJECT-001` 的端到端语义）。

## 6. 剩余风险

- 安全修复流程（扫描、独立计数、文案）接口未给出，Sprint 2 无法完成安全问题独立处理验收。
- S2-JUDGE-002 的完整回滚行为依赖 Sprint 3 的 rollback 链路。
- E2E 依赖真实 Electron 桌面会话，CI 无桌面环境时需标记为 `SKIP_BLOCKED`。

## 修订记录

| 版本 | 日期 | 基线 | 修订内容 |
|------|------|------|----------|
| v1.0 | 2026-08-13 | sprint2 | 初版 — Sprint 2 独立验收/回归/E2E 测试集首次执行 |
