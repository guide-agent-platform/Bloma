# Sprint 2 独立阶段测试报告

> 分支：`sprint2`
>
> 执行：2026-08-13（Asia/Hong_Kong）初版；2026-08-15 复跑并闭环产品缺口；2026-08-15 二次闭环（GWT 真实执行器 + 修复/PRD 改 LLM）
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
| 总体结论 | `PASS`（初版唯一 FAIL_PRODUCT 已在 2026-08-15 闭环，全部绿） |
| Sprint 2 独立验收 | 27 项 `PASS`（初版 `S2-JUDGE-007` 由 `FAIL_PRODUCT` 转 `PASS`；含 4 项 LLM PRD/修复补充用例） |
| Sprint 2 回归门禁 | 4/4 `PASS` |
| Sprint 2 E2E | 1/1 `PASS`（真实 Electron 会话） |
| 既有门禁回归 | unit / reg:s0 / reg:s1 / acceptance:s1 全绿 |
| 辅助质量门禁 | typecheck 0 err、git diff --check 通过 |
| 当前阻塞 ID | 无 |

**阶段结论：Sprint 2 的 MVP 生成、GWT 执行、自动修复与熔断回滚、裁判硬约束、退回让渡、Electron 主链路等验收/回归/E2E 全部通过。初版报告的三个缺口已于 2026-08-15 闭环：(1) `S2-JUDGE-007` 安全独立计数接口落地（`Project.security_repair_count` + `RepairCategory.security_error` + `SECURITY_REPAIR_LIMIT=3`，不计入普通退回）；(2) `S2-JUDGE-002` 熔断回滚接入 `rollbackSnapshot`（3 次修复失败后自动回滚健康快照并告知内容未丢失）；(3) renderer 退出演示模式，接入真实 `window.electronAPI.agent.sendMessage` 四层链路。**

## 1. 独立性与执行范围

独立阶段验收位于 `tests/acceptance/sprint2/`，依据 PRD、sprint-plan §5、GWT Feature（generation-workflow / self-healing-judge）、api-spec、component-design 独立设计。回归门禁位于 `tests/regression/sprint2/`，E2E 位于 `tests/e2e/sprint2/`。

### 1.1 执行命令与结果

| 测试范围 | 命令 | 结果 |
|---|---|---|
| Sprint 2 独立验收 | `npx vitest run tests/acceptance/sprint2` | 27/27 `PASS` |
| Sprint 2 回归门禁 | `npx vitest run tests/regression/sprint2` | 4/4 `PASS` |
| Sprint 2 E2E | `npx playwright test tests/e2e/sprint2` | 1/1 `PASS` |
| 类型检查 | `npx tsc --noEmit` | 0 error |

## 2. 功能域与测试层汇总

### Sprint 2 独立验收（acceptance/sprint2）

| 测试 ID | 功能域 | 结果 | 缺陷/缺口 |
|---|---|---|---|
| `S2-PROJECT-001` | PROJECT/MVP | `PASS` | — |
| `S2-PROJECT-001b` | PROJECT | `PASS` | — |
| `S2-JUDGE-009` | JUDGE/GWT | `PASS` | — |
| `S2-JUDGE-009b` | JUDGE/GWT | `PASS` | — |
| `S2-JUDGE-001` | JUDGE/修复 | `PASS` | — |
| `S2-JUDGE-002` | JUDGE/修复/熔断 | `PASS` | 熔断回滚已接入（见 §4） |
| `S2-JUDGE-003` | JUDGE/硬约束 | `PASS` | — |
| `S2-JUDGE-004` | JUDGE/硬约束 | `PASS` | — |
| `S2-JUDGE-004b` | JUDGE/硬约束 | `PASS` | — |
| `S2-JUDGE-005` | JUDGE/让渡 | `PASS` | — |
| `S2-JUDGE-006` | JUDGE/让渡 | `PASS` | — |
| `S2-JUDGE-007` | JUDGE/安全 | `PASS` | 安全独立计数接口已落地（见 §4） |
| `S2-JUDGE-008` | JUDGE/安全文案 | `PASS` | — |

**补充验收（acceptance/sprint2/llm-prd-repair.test.ts）**：上述 13 项为初版编号，2026-08-15 二次闭环新增 4 项 LLM 契约用例（无独立测试 ID，纳入 `llm-prd-repair.test.ts`）：

| 用例 | 功能域 | 结果 | 说明 |
|---|---|---|---|
| `[PRD-LLM] 从对话提取 PRD 背板` | PRD §7.1 | `PASS` | 从澄清对话提炼定位/验收/范围外，F-001 主题锚点不被改写 |
| `[PRD-LLM] 无对话历史返回 null` | PRD §7.1 | `PASS` | 无会话 JSONL → 返回 null，交由模板兜底 |
| `[PRD-LLM] 非 PRD JSON 优雅降级` | PRD §7.1 | `PASS` | 模型返回 MVP 形态 JSON → 回退默认验收，不抛错 |
| `[REPAIR-LLM] 修复上下文注入 prompt` | self-healing @S2-JUDGE-001 | `PASS` | 错误原因（category + error）进入生成 prompt |

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

无。初版唯一的 `S2-JUDGE-007`（安全独立计数接口）已于 2026-08-15 闭环转 `PASS`，当前无阻塞验收的产品缺口。

## 4. 说明与已闭环缺口

- **S2-JUDGE-002 熔断回滚（已闭环）**：初版实现修复 3 次失败后仅进入 `blocked_for_user_decision` 让渡，未接入 `rollbackSnapshot`。2026-08-15 已在 runtime/test 两条修复链的熔断分支接入 `rollbackToHealthySnapshot`：回滚到最近健康快照、下发 `rollback_done`、落「内容没有丢失」文案，再弹继续/接受/补充三选项。`tests/acceptance/sprint2/auto-repair.test.ts` 已断言 `rollback_done` 事件、`rollback_guard` 保护快照产出与快照指针保持。
- **S2-JUDGE-007 安全独立计数（已闭环）**：`Project.security_repair_count` 字段、`RepairCategory.security_error` 类别、`SECURITY_REPAIR_LIMIT=3` 独立上限与安全文案均已落地（repair-engine），安全修复不计入普通 `judge_return_count`。`run_security_scan` 扫描工具的具体实现仍留待 Sprint 3，但不阻塞本契约断言（本测试仅验证「安全独立计数接口」存在）。
- **renderer 演示模式（已退出）**：App.tsx 已接入真实 `window.electronAPI.agent.sendMessage` 四层链路，不再返回「演示模式」文案。
- **GWT 真实执行器（已闭环）**：初版 GWT 骨架仅做静态启发式匹配（fetch 预览 + 交互入口标记），未真正驱动浏览器执行交互场景。2026-08-15 新增 `main/gwt-runner.ts`（`runBrowserGwt`）：优先用 Playwright 无头 chromium 导航 `preview_url`、读取 `document.body.innerText` 与可交互元素（button/input/select/textarea/a/form）、采集 `pageerror`；浏览器不可用（chromium 未安装）或任何异常时返回 null，由 `runGwtScenarios` 回退静态启发式，保证 GWT 契约始终有结果、不阻塞主流程。
- **修复/PRD 改 LLM（已闭环）**：初版自动修复为确定性模板重建、PRD 初稿为固定模板，未「分析错误原因」/「从对话提取」。2026-08-15 (1) 修复链接入 `repairMvpViaLlm`：把失败原因作为 `repairContext` 注入 `generateMvpLlm`，LLM 针对性重新生成 MVP，失败/无渠道回退模板重建（`constraint_error` 仍走文档层）；(2) PRD 背板接入 `generatePrdLlm`：从会话 JSONL 提炼 `positioning/acceptance/out_of_scope/assumptions`，冻结需求清单（F-001 主题锚点）不被改写，无对话或生成异常回退模板。两条路径均为 LLM 优先、模板兜底。

## 5. 追踪关系

- 各 acceptance 测试使用与 GWT Feature 相同的稳定 ID（`S2-PROJECT-001`、`S2-JUDGE-001`~`008`）。
- regression 测试使用 `S2-JUDGE-010`~`013`（回归专属编号，与验收分开统计）。
- e2e 使用 `S2-PROJECT-001-e2e`（对应 GWT `@S2-PROJECT-001` 的端到端语义）。

## 6. 剩余风险

- `run_security_scan` 扫描工具实现仍留待 Sprint 3（仅权限白名单占位），安全扫描执行链路未验收。
- GWT 真实执行器依赖 Playwright chromium；当前环境未安装 ms-playwright 浏览器缓存，`chromium.launch()` 快速抛错后回退静态启发式（契约仍有结果，但浏览器端真实交互/`pageerror` 采集路径在本机未实际覆盖）。补齐 `npx playwright install chromium` 后可触发真实浏览器路径。
- E2E 依赖真实 Electron 桌面会话，CI 无桌面环境时需标记为 `SKIP_BLOCKED`。
- Windows 下真实沙箱进程与临时目录清理存在偶发 EPERM（进程句柄未及时释放），测试集单跑/串行均通过，并行全量跑需注意句柄释放时序。

## 修订记录

| 版本 | 日期 | 基线 | 修订内容 |
|------|------|------|----------|
| v1.0 | 2026-08-13 | sprint2 | 初版 — Sprint 2 独立验收/回归/E2E 测试集首次执行 |
| v1.1 | 2026-08-15 | sprint2 | 闭环产品缺口：`S2-JUDGE-007` 转 `PASS`（安全独立计数落地）；`S2-JUDGE-002` 熔断回滚接入 `rollbackSnapshot`；renderer 退出演示模式；验收 23/23 全绿 |
| v1.2 | 2026-08-15 | sprint2 | 二次闭环：GWT 真实执行器（浏览器优先、静态启发式兜底）；修复/PRD 改 LLM（分析错误原因 + 从对话提取，模板兜底）；新增 4 项 LLM PRD/修复补充用例，验收 27/27 全绿 |
