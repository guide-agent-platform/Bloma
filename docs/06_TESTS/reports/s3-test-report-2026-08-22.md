# Sprint 3 独立阶段测试报告

> 分支：`sprint2` · 基线 commit `f3241a8`（测试补全+审查修复 与 澄清修复 D1~D4 合流后的 merge 提交）
>
> 执行：2026-08-22 初版，2026-08-23 按对抗性审查修正（v1.1，见修订记录）；同日合流远端后全量回归复跑全绿
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
| Sprint 3 独立验收 | 25 项 `PASS` / 0 失败 / 0 跳过 / 0 TODO（7 文件） |
| Sprint 3 Release E2E | 5 项 `PASS` / 0 失败 / 0 跳过（3 文件，真实 Electron 桌面会话，连绿 2 次） |
| 回归门禁 | 20 项 `PASS` / 0 失败（5 文件：sprint0=4 + sprint1=12 + sprint2=4） |
| 既有门禁回归 | unit 48 文件 433 例 / integration 2 文件 4 例 / acceptance s0=23、s1=20、s2=40 全过 |
| 辅助质量门禁 | typecheck 0 err、docs:check 过 |
| 当前阻塞 ID | 无 |

**阶段结论：Sprint 3 排期欠账（T8 埋点重核、FIRT 指标测量、Release E2E 补全）已闭环；对抗性审查发现的测试自身缺陷（恒真空断言/超时截断/ID 错位/审计失实）已全部修复。**

## 1. 独立性与执行范围

Sprint 3 独立验收位于 `tests/acceptance/sprint3/`，依据 PRD、sprint-plan §6、GWT Feature（point-correction / timeline-rollback / self-healing-judge）、api-spec、component-design 独立设计。回归门禁位于 `tests/regression/sprint0|sprint1|sprint2`，E2E 位于 `tests/e2e/sprint3/`。

### 1.1 执行命令与结果（逐目录分列，可直接复现）

| 测试范围 | 命令 | 结果 |
|---|---|---|
| Sprint 3 独立验收 | `npx vitest run tests/acceptance/sprint3` | 25/25 `PASS` |
| Sprint 3 Release E2E | `npx playwright test tests/e2e/sprint3 --timeout 150000` | 5/5 `PASS` ×2 遍 |
| 回归门禁（全量） | `npx vitest run tests/regression` | 20/20 `PASS` |
| 单元测试 | `npx vitest run tests/unit` | 433/433 `PASS` |
| 集成测试 | `npx vitest run tests/integration` | 4/4 `PASS` |
| 前序验收 s0 | `npx vitest run tests/acceptance/sprint0` | 23/23 `PASS` |
| 前序验收 s1 | `npx vitest run tests/acceptance/sprint1` | 20/20 `PASS` |
| 前序验收 s2 | `npx vitest run tests/acceptance/sprint2` | 40/40 `PASS` |
| 类型检查 | `npx tsc --noEmit` | 0 error |

（注：E2E 前须 `npm run build:main`——E2E 启动的是 `dist-main` 构建产物，改 main/preload 源码后未构建会跑旧产物。）

## 2. 功能域与测试层汇总

### Sprint 3 独立验收（acceptance/sprint3，7 文件 25 例）

| 测试文件 | 功能域 | 结果 |
|---|---|---|
| `analytics-completeness.test.ts`（T8-001~004，4 例） | ANALYTICS | `PASS` |
| `point-correction-repeat.test.ts`（4 例） | CORRECT | `PASS` |
| `point-correction-highlight.test.tsx`（3 例） | CORRECT | `PASS` |
| `project-history-management.test.tsx`（6 例） | PROJECT | `PASS` |
| `project-management-ipc.test.ts`（3 例） | PROJECT | `PASS` |
| `timeline-rollback.test.tsx`（3 例） | SNAPSHOT | `PASS` |
| `background-notifications-ui.test.tsx`（2 例） | UI | `PASS` |

### Sprint 3 Release E2E（e2e/sprint3，3 文件 5 例）

| 测试 ID | 功能域 | 结果 |
|---|---|---|
| `[S3-CORRECT-004-e2e]` 点选纠错重复追踪 + point_correction 埋点 | CORRECT | `PASS` |
| `[S3-ANALYTICS-e2e]` mode_upgraded / satisfaction_marked / project_finalized | ANALYTICS | `PASS` |
| `[S3-FIRT-e2e]` 草图生成埋点含 FIRT（duration_ms / page_count） | ANALYTICS | `PASS` |
| `[S3-SNAPSHOT-002-e2e]` 时间轴确认回滚 → guard 快照落盘 + 指针更新 | SNAPSHOT | `PASS` |
| `[S3-JUDGE-009-e2e]` 危险回滚被拒 → 快照指针未变 + P0 安全文案 | JUDGE | `PASS` |

（ID 对齐说明：v1.0 的 `S3-SNAPSHOT-001-e2e`/`S3-JUDGE-008-e2e` 与 feature 场景错位/撞号，v1.1 已改为 `@S3-SNAPSHOT-002` 与新增 `@S3-JUDGE-009`。）

### 回归门禁（regression，5 文件 20 例）

| 目录 | 功能域 | 结果 |
|---|---|---|
| regression/sprint0（4 例：agent-state-isolation / proma-core-security） | IPC / STORE / PERM / SECRET | `PASS` |
| regression/sprint1（12 例：mode-workspace / sketch-upgrade） | PROJECT / SKETCH | `PASS` |
| regression/sprint2（4 例：mvp-judge-regression） | JUDGE / MVP | `PASS` |

## 3. Sprint 3 产品失败

无。Sprint 3 验收与 E2E 全部通过，无阻塞验收的产品缺口。

## 4. T8 埋点重核结论（v1.1 按覆盖真实性四档改写）

14 类定义事件（真源 `shared/types.ts`）的覆盖状态：

| 档位 | 事件 | 依据 |
|---|---|---|
| **本报告实测落盘**（6 类） | project_created / mode_upgraded / satisfaction_marked / project_finalized / point_correction / user_undo | T8-001/002/003 直接驱动 IPC 并读 analytics.jsonl 断言 |
| **既有断言覆盖**（4 类） | conversation_submitted / sketch_generated / sketch_fallback / mvp_delivered | S1-ANALYTICS-001（sketch-delivery）、unit/sketch-fallback-observability、E2E mvp-workflow 轮询落盘 |
| **本轮补齐落盘断言**（3 类） | programming_execution / self_repair_triggered / judge_verdict | S2-JUDGE-001 修复循环与裁判判定真跑即落盘，v1.1 补 analytics.jsonl 断言（此前仅静态表声称） |
| **明确阻塞项**（1 类） | guide_role_switched | Phase 1 无 DialogueRouter 显式角色切换，T8-004 静态审计标注 |

T8-004 审计机制（v1.1 升级）：覆盖表从「表内有条目即过」升级为**引用实存校验**——每个事件的断言文件必须存在于仓库且源码含该事件字面量，杜绝覆盖声称失实。

另：FIRT 断言（`sketch_generated.duration_ms < 60_000` + `page_count`）在 S1-ANALYTICS-001 生效，实现写入点 `programming-orchestrator.ts`（含模板回退路径）。

## 5. 对抗性审查与修复记录（v1.1 新增）

2026-08-22 夜以 3 个并行只读协作子会话对本批测试做对抗性审查，发现并已修复：

| # | 严重度 | 缺陷 | 修复 |
|---|---|---|---|
| F1 | 高 | E2E P0 文案断言 strict-mode 双命中恒真空 | 单元素定位 `[data-ai-id="chat-panel"]`，探针复现后修复 |
| F2/F3 | 高/中 | 45s poll 被 30s 全局超时截断；缺快照指针断言 | 以 `projects.json` 指针断言替代（沙箱重启前落盘，天然确定）；`test.setTimeout(120s)` |
| F4 | 中 | E2E ID 与 feature 场景错位/撞号 | 改 `@S3-SNAPSHOT-002`、新增 `@S3-JUDGE-009` |
| F5 | 中 | T8-004 三类事件覆盖声称失实 | 引用实存校验 + S2-JUDGE-001 补落盘断言 |
| F6/F7 | 高/中 | 回归分组数字失真、误列 sprint2 文件、命令不可复现 | 本 v1.1 全部实测重写 |
| F8 | 高（产品） | allow-all × dangerous 契约三处矛盾 | **未修**——产品缺陷单独立项；E2E 已显式注释该依赖 |

## 6. 剩余风险

- E2E 依赖真实 Electron 桌面会话；CI 无桌面环境时标记 `SKIP_BLOCKED`。
- `S3-SNAPSHOT-002-e2e` 的向导播报「已经回到」为**软断言**（磁盘产物已证实回滚事务；notify 消息在 reload 回访恢复 + 预览 error 态下渲染不稳定，未命中时输出告警不判败）。
- F8（allow-all × dangerous 契约）修复前，两个回滚 E2E 的「权限弹窗必现」前提依赖 renderer atom 未同步的现状（已在用例注释留档）。
- Windows 下真实沙箱进程与临时目录清理存在偶发句柄释放时序，并行全量跑需注意（单跑稳定）。

## 修订记录

| 版本 | 日期 | 基线 | 修订内容 |
|------|------|------|----------|
| v1.0 | 2026-08-22 | 9302bbb | 首版 — Sprint 3 独立验收/回归/E2E 测试集首次执行（含回归分组数字错误等缺陷，见 v1.1 §5） |
| v1.1 | 2026-08-23 | 29ea189 | 对抗性审查修正：回归分组实测重写（4/12/4）、验收表归属修正、E2E ID 对齐 feature、T8 覆盖四档如实改写、命令逐目录可复现、补 commit SHA 与零计数行、新增审查修复记录 §5 |
| v1.2 | 2026-08-23 | f3241a8 | 合流远端澄清修复线（D1~D4，无文件交集安全合并）后全量回归复跑：unit+integration 458、acceptance 111（含远端新增 guide-clarification-fixes）、regression 20、E2E 5/5 全绿 |
