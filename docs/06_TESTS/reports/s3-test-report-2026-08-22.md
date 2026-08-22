# Sprint 3 独立阶段测试报告

> 分支：`sprint2`
>
> 执行：2026-08-22（Asia/Hong_Kong）
>
> 环境：Windows 11、Node.js、Electron `39.8.10`（E2E 真实桌面会话）
>
> 测试规范：DOC-6.2 `docs/06_TESTS/testing-standards.md`
>
> 覆盖映射：`docs/06_TESTS/test-plan.md` §6（6 个 GWT Feature）、`docs/05_PROJECT_PLAN/sprint-plan.md` §6

## 测试摘要

| 项目 | 结论 |
|---|---|
| 被测范围 | Sprint 3 独立验收（acceptance）、回归门禁、Electron 主链路（E2E）、单元/集成 |
| 总体结论 | `PASS` |
| Sprint 3 独立验收 | 25 项 `PASS`（7 文件） |
| Sprint 3 Release E2E | 5 项 `PASS`（3 文件，真实 Electron 桌面会话） |
| 回归门禁 | 20 项 `PASS`（5 文件，sprint0+sprint1） |
| 既有门禁回归 | unit 48 文件 433 例、integration 2 文件 4 例、acceptance s0 23 / s1 20 / s2 40 全绿 |
| 辅助质量门禁 | typecheck 0 err |
| 当前阻塞 ID | 无 |

**阶段结论：Sprint 3 的排期内欠账（T8 埋点逐类重核、FIRT 指标测量、Release E2E 补全）已闭环，Sprint 3 全部验收/回归/E2E 通过。**

## 1. 独立性与执行范围

Sprint 3 独立验收位于 `tests/acceptance/sprint3/`，依据 PRD、sprint-plan §6、GWT Feature（point-correction / timeline-rollback / self-healing-judge）、api-spec、component-design 独立设计。回归门禁位于 `tests/regression/sprint0|sprint1`，E2E 位于 `tests/e2e/sprint3/`。

### 1.1 执行命令与结果

| 测试范围 | 命令 | 结果 |
|---|---|---|
| Sprint 3 独立验收 | `npx vitest run tests/acceptance/sprint3` | 25/25 `PASS` |
| Sprint 3 Release E2E | `npx playwright test tests/e2e/sprint3 --timeout 150000` | 5/5 `PASS` |
| 回归门禁 | `npx vitest run tests/regression` | 20/20 `PASS` |
| 单元测试 | `npx vitest run tests/unit` | 433/433 `PASS` |
| 集成测试 | `npx vitest run tests/integration` | 4/4 `PASS` |
| acceptance 前序 | `npx vitest run tests/acceptance/sprint0|sprint1|sprint2` | 23/20/40 `PASS` |
| 类型检查 | `npx tsc --noEmit` | 0 error |

## 2. 功能域与测试层汇总

### Sprint 3 独立验收（acceptance/sprint3，25 例）

| 测试 ID / 文件 | 功能域 | 结果 |
|---|---|---|
| `analytics-completeness.test.ts`（T8-001~004，4 例） | ANALYTICS | `PASS` |
| `background-notifications-ui.test.tsx`（2 例） | UI | `PASS` |
| `point-correction-highlight.test.tsx`（3 例） | CORRECT | `PASS` |
| `point-correction-repeat.test.ts`（2 例） | CORRECT | `PASS` |
| `project-history-management.test.tsx`（6 例） | PROJECT | `PASS` |
| `project-management-ipc.test.ts`（3 例） | PROJECT | `PASS` |
| `timeline-rollback.test.tsx`（3 例） | SNAPSHOT | `PASS` |
| `security-independent-count.test.ts`（2 例） | JUDGE/安全 | `PASS` |

### Sprint 3 Release E2E（e2e/sprint3，5 例）

| 测试 ID | 功能域 | 结果 |
|---|---|---|
| `[S3-CORRECT-004-e2e]` 点选纠错重复追踪 + point_correction 埋点 | CORRECT | `PASS` |
| `[S3-ANALYTICS-e2e]` mode_upgraded / satisfaction_marked / project_finalized | ANALYTICS | `PASS` |
| `[S3-FIRT-e2e]` 草图生成埋点含 FIRT（duration_ms / page_count） | ANALYTICS | `PASS` |
| `[S3-SNAPSHOT-001-e2e]` 时间轴回滚 → guard 快照落盘 + UI 播报 | SNAPSHOT | `PASS` |
| `[S3-JUDGE-008-e2e]` 危险回滚被拒 → 内容未改动 + P0 安全文案 | JUDGE | `PASS` |

### 回归门禁（regression，20 例）

| 文件 | 功能域 | 结果 |
|---|---|---|
| regression/sprint0（17 例） | IPC / STORE / PERM / AGENT / SECRET | `PASS` |
| regression/sprint1（3 例） | SKETCH / PROJECT | `PASS` |

## 3. Sprint 3 产品失败

无。Sprint 3 验收与 E2E 全部通过，无阻塞验收的产品缺口。

## 4. 说明与已闭环缺口

- **T8 埋点逐类重核（本次补全）**：`analytics-completeness.test.ts` 逐项核对 `shared/types.ts` 定义的 14 类分析事件是否真实触发并落盘 `analytics.jsonl`，并建立 FIRT 指标断言（duration_ms < 60s）。含 4 例：
  - T8-001：mode_upgraded / satisfaction_marked / project_finalized 落盘；
  - T8-002：point_correction（repeat_count / fallback_mode）；
  - T8-003：user_undo（create/rollback 权限请求按 S0-PERM-003 惯例解析，沙箱 runtime 注入测试替身，避免 ask 模式挂起/真实 spawn）；
  - T8-004：14 类事件静态完整性审计（真源 `shared/types.ts`），并标注 `guide_role_switched` 的明确阻塞项（Phase 1 无 DialogueRouter 显式角色切换）。
- **FIRT 指标测量（本次补全）**：`sketch-delivery.test.ts` 断言 `sketch_generated.payload.duration_ms` 为 number、≥0、<60_000（Sprint 1 验收标准），并含 `page_count`。实现由 `programming-orchestrator.ts` 写 duration_ms（含模板回退路径），测试在无渠道回退模板下通过。
- **Release E2E（本次补全）**：新增 `timeline-rollback.e2e.ts`（点击非当前快照 → 确认 → 权限允许 → 真实 IPC 回滚 → 断言 rollback_guard 快照落盘 + UI「已经回到」）与 `self-healing-judge.e2e.ts`（危险回滚被拒 → 内容未改动 + P0 安全文案）。两例均走真实 Electron + preload 白名单 IPC。埋点正确性由 acceptance 覆盖，E2E 不再重复断言埋点时序。

## 5. 追踪关系

- acceptance 测试与 GWT Feature 使用相同稳定 ID（T8-xxx、S3-SNAPSHOT、S3-JUDGE 等）。
- E2E 使用 `S3-*-e2e` 后缀，与对应 Feature 语义对应。
- `analytics-completeness.test.ts` 的静态审计表与 `shared/types.ts` 事件枚举一一对应。

## 6. 剩余风险

- E2E 依赖真实 Electron 桌面会话；CI 无桌面环境时需标记 `SKIP_BLOCKED`。
- `timeline-rollback.e2e.ts` 因测试项目 root_path 为空、沙箱重启可能等满超时，UI 播报等待放宽至 45s（guard 快照在事务第一步即落盘，早于 UI 播报）。
- `guide_role_switched` 事件在 Phase 1 无触发点（无 DialogueRouter 显式角色切换），由 T8-004 静态审计标注为明确阻塞项，不计为产品缺口。
- Windows 下真实沙箱进程与临时目录清理存在偶发句柄释放时序，并行全量跑需注意。

## 修订记录

| 版本 | 日期 | 基线 | 修订内容 |
|------|------|------|----------|
| v1.0 | 2026-08-22 | sprint2 | 首版 — Sprint 3 独立验收/回归/E2E 测试集首次执行，含 T8 埋点重核、FIRT 测量、Release E2E 补全 |
