# Harness 改进执行交接

后继执行已推进，当前状态请读 [逐批实施记录](harness-improvement-progress-20261027.md)、[独立验收设计](independent-acceptance-design-20261027.md) 和 [固定任务对照工具](harness-evaluation-20261027.md)。本交接以下内容保留为原接手快照，不能据此将已完成工程重新列为待做；真实付费对照仍待新预算。

后续已完成复杂能力桥接与长期型差异，并继续实施旧流程退役；相关现状及边界见 [近期实施表](workflow-retirement-modes-capabilities-20261027.md)、[长期里程碑](software-longterm-milestones-20261027.md) 和 [退役实施记录](workflow-retirement-implementation-20261027.md)。所有实施均本地逐批提交，不 push、不新增付费样本、不迁移真实项目。

核对日期：2026-10-27，Asia/Shanghai。工程基线：`sprint2 / 840f8eb`。本交接的文档提交会在该基线上增加一个提交，进入新会话后以 `git log -3 --oneline` 核对实际 HEAD。

## 用户目标与执行范围

用户已经认可“先稳定当前单模型闭环，再小范围引入第二模型的独立验收设计”的方向，并要求恢复 Agent 给用户提供可选建议的机制。本会话已完成分批规划和需求确认建议恢复。用户最新要求：**准备交接会话，继续完成并执行计划**。

新会话应实际实施、验证和按批提交剩余计划；不只重复给建议，也不重新询问已明确的普通工程方向。真正需要新信息的付费预算/模型渠道等事项不由交接推定。

工作目录：`C:\Users\17359\OneDrive\Desktop\guide-agent-platform-sprint0`。

先读：

1. 当前会话的 AGENTS/环境说明与 `C:\Users\17359\.codex\memories\proma\CODEX-MEMORY.md`，按入口查看项目记忆。
2. 本交接。
3. [Harness 改进与可选建议恢复计划](harness-improvement-plan-20261027.md)。
4. [Proma-Easy 与 Bloma harness 对照](../../outputs/harness-comparison-20261026.md)。

记忆只是查证入口：Proma 主记忆含 2026-10-10 旧状态，Codex registry 仍可能记着 `9206cda`；它们不能覆盖本次实查的工程基线，也不能让接手者倒退或重启历史实验。

## 已完成，不要重做

- `b25e8b7`：改进计划，拆出批次 0–4。
- `840f8eb`：恢复 lean/software 任务单上的可选 AI 灵感建议。
- 每次需求整理同一模型调用可给出 0–3 条建议；不另开旧研究、PRD 或 AC 链。
- 默认不勾选；未采纳建议不进入需求、实现或验收。“直接做”不自动授权建议。
- 勾选后提交“采纳 N 条建议，更新任务单”：宿主只按已保存建议 ID 合并，保留旧 F 编号、约束和验收；更新清单后再次确认才开工。
- 建议保存在确认日志并绑定项目、会话、当前需求范围；暂停/回访可恢复；过期、未知、重复及异会话选择拒绝。建议内容生成哈希 ID，避免相同范围下换了建议却沿用位置 ID。
- 采纳和回显不调用模型。已采纳记录保存在本次确认数据的 `adopted_suggestions`；当前功能不是制作中任意主动建议入口。
- 已构建 dist/dist-main；未替用户启动、关闭或重启实际 Bloma。现有进程是否已重启，要在新会话重新核对。

### 当前实现入口

- `main/guide/lean-brief.ts`：任务整理提示词和可选建议解析。
- `main/guide/lean-suggestions.ts`：建议校验、内容 ID、仅采纳宿主已保存项目、追加需求及验收绑定。
- `main/guide/lean-guide.ts`、`lean-scope.ts`、`pending-decision.ts`：采纳/更新/确认、持久候选及恢复。
- `shared/types.ts`：`LeanScopeSuggestion`、`LeanScopeView.suggestions`、`metadata.selected_suggestion_ids`。
- `renderer/components/ScopeConfirmationPanel.tsx`：默认未选、勾选与更新任务单按钮；`App.tsx` 将选中 ID 经 preload IPC 回传。

## 验证事实与边界

- 最终针对性范围 7 文件 / 32 项。首轮在并行验证时，一项 Pi 用例超出原 30 秒阈值，其余通过；该文件单 worker 复跑 9 项全过，未放宽阈值。其余 6 文件 23 项通过。不是一次全仓全量绿，也不能把重叠复跑叠加计数。
- 类型检查、构建、文档检查通过。
- 原生 Electron 离线检查 7 组通过，页面异常 0；检查默认未选、键盘操作、实际 renderer/preload IPC 数据、真实范围函数合并、回访恢复和窄屏显示。
- 原生脚本使用固定任务单与 IPC 捕获器，不是新真实模型生成或完整交付链实测。后端权限、采纳和确认由单元集成覆盖。本轮无新增付费模型请求。
- 测试请求的窗口宽度与 Windows 实测 viewport 不完全相同；报告中有实测尺寸（如 1038/404），不要把请求 1024/390 写成精确实测尺寸。

本地证据（`run-artifacts` 被忽略，不随普通 Git 提交分发）：

- `run-artifacts/lean-suggestions-tests-20261027.log`：首轮 7 文件，包含那一项超时。
- `run-artifacts/lean-suggestions-production-serial-20261027.log`：Pi 文件串行 9 项通过。
- `run-artifacts/lean-suggestions-native-final-20261027.log`。
- `run-artifacts/lean-suggestions-20261027/report.json` 和 `suggestions-desktop.png`、`suggestions-1024.png`、`suggestions-390.png`。
- `run-artifacts/lean-suggestions-docs-20261027.log`。

测试源码与可重复的原生脚本已提交：

```powershell
node node_modules/vitest/vitest.mjs run tests/unit/guide/lean-suggestions.test.ts tests/unit/guide/lean-guide.test.ts tests/unit/guide/lean-ux.test.ts tests/unit/guide/pending-decision.test.ts tests/unit/scope-confirmation-ui.test.tsx tests/unit/theatre-workspace.test.tsx --maxWorkers=2 --minWorkers=1
node node_modules/vitest/vitest.mjs run tests/unit/desktop/lean-production.test.ts --maxWorkers=1 --minWorkers=1
npm run typecheck
npm run build
node scripts/verify-lean-suggestions.mjs
npm run docs:check
```

不要在全量测试与原生 Electron/冷启动 Pi 之间再堆高并发；不要为掩盖慢启动而直接增大断言或超时阈值。

## 从这里继续：批次 1

首要问题：验收截图可能改变发布候选，报 `RELEASE_BYTES_CHANGED`；工具只返回摘要时，模型会读宿主源码猜修法。要修平台接口，不让成品负责删除验收痕迹。

第一批入口：

| 接线 | 需要核对与实施 |
| --- | --- |
| `main/templates/tools/browser-test-runner.mjs`、`browser-script.mjs` | 原生测试/观察脚本上下文目前有 page、context、dataDir、phase，新增工程外证据目录契约与可诊断行为 |
| `main/software/command-runtime.ts` | 现有 `BLOMA_NATIVE_TEST_FILE/PHASE/TRACE`、CDP 与 APP_DATA_DIR 的绑定；新增目录跟随本次已拥有的执行身份 |
| `main/software/native-gui-observer.ts`、`debug-sessions.ts`、`gui-observer.ts` | 区分开发观察与正式验收的证据，统一截图落位；真实关闭重开时共享数据但不混写发布文件 |
| `main/software/release-store.ts` | 保留候选/依赖字节校验；返回有界的新增、删除、改变路径，不只输出一个总哈希错误 |
| `main/software/verification.ts`、`verification-tool.ts` | 故障对象、类别、期望/实际、相关路径和建议工具结构化反馈；取消/异常/写入失败不能复活旧 PASS |
| `main/software/native-gui-tests.ts`、`native-gui-registration.ts` | 业务输入与预期冻结；定位、等待、导航修复要有明确可验证的适配更新规则；不能让选择器参数夹带代码绕过冻结 |

建议先做能复现本次截图污染的小型真实样例，再实施并跑正反例：证据输出不改变候选；业务源码/二进制被修改仍拒绝；错误清单指出具体文件；坏规则、未知能力、取消和损坏凭据继续 fail-closed。不要大范围忽略 `shots` 或把完整性校验关掉。

## 后续批次执行顺序

1. **批次 1：证据隔离与诊断。** 做完必要回归、真实进程验证、记录边界并提交，再继续。
2. **批次 2：独立持续试用。** 试用、模型调试、自动验收各自进程身份与数据目录；验收不能关闭用户试用。关注 `process-manager.ts`、`debug-sessions.ts`、`verification-tool.ts`、`lean-production.ts` 与 renderer 的 `softwarePreviewsAtom` / `DeliveryPanel.tsx` / `ProgramScreenshot.tsx`。旧 PID 不接管；单实例锁、端口、profile、关闭和重启均要实测；用户反馈绑定所见版本。
3. **后续建议入口单独一批。** 将制作中/交付后非阻塞建议与用户采纳状态接好。可不采纳；选本轮采用才按影响走范围确认，不把 Agent 自己的建议当作用户已经改变需求。不要无故暂停正在制作的任务。
4. **批次 3：第二模型独立验收设计。** 放在需求和界面确认之后、实现之前；B 优先不读实现，给关键业务输入/预期，A 实现和适配测试，宿主冻结、执行和裁决。先用替身验证权限、费用路由、缺能力和超时等工程路径，再考虑真实模型。B 的文本判断不能签发 PASS。
5. **批次 4：对照评估。** 固定任务、范围、预算和验收目标，记录首次试用、最终交付、产品修复/设施排障、漏检/误报、总费用和用户介入；保留全部失败。真实付费样本前必须落实下一节条件。

每批根据实际代码调整实现细节，不为了复刻 Proma-Easy 的 L1/L2/AC 层级而扩大流程。原型演示与真实程序试用分开标注；结构编号关联不等于语义覆盖。

## 本次真实对话作为问题背景

实际 home 为 `C:\Users\17359\.proma`，花样计算器项目 `9cdee9ce-8b9b-4645-b69c-e955f1b9ea62`，会话 `4d39496d-fb03-466a-98d8-6019f1b1ad11`。本次只读实查仍是 completed / delivered，更新时间 `2026-10-26T15:10:51.434Z`。

其失败链包括：桌面需求被临时改成 browser 后遭宿主拦截；冻结测试调整被拒；重开后找不到历史项（旧侧栏只渲染最近 6 条，不能直接推断为数据丢失）；连续三次 `RELEASE_BYTES_CHANGED`。后者与 `shots/acceptance.png` 写进发布候选相关，模型最终给成品增加退出清理截图逻辑后通过。这个局部 workaround 不等于平台机制已经完善；不要去改用户已交付产品制造“修好了平台”的证据。

该项目的宿主验收和交付状态不是本会话重新独立验证其全部业务的结论。相关 `agent-sessions`、`software-verification`、`software-releases` 都在真实 home；只读查证，修复验证用新隔离 home。

本聊天此前的 `bloma` 定时监控已在交付完成后删除；无需恢复。旧“AI 学习桌面软件”仍是其他历史任务，不擅自恢复。

## 权限、费用与版本边界

- 用户授权继续普通工程实现与离线验证，逐批 commit；没有 push 授权。
- 本交接没有新增付费测试额度，不重置任何 operation、账本、历史 unknown 预留或供应商统计。不要把旧记忆中的剩余金额当作当前余额或新授权。
- 真实模型/第二模型调用前，核对当前渠道、配额/余额、费率、账本和请求前 RMB 保护；必须有能覆盖完整输入预留的明确授权。缺少新预算时先完成代码、替身和本地真实进程验证，把付费实验明确留待预算落实，不能绕过限制偷跑。
- `run-artifacts/software-fresh-20261026/funding-combined/monetary-policy.json[.state.json]` 是旧付费实验的重要查证入口，不代表本轮实际渠道/账本；真实 home 还有按项目的 harness-budgets / usage-ledger。保留，不合并抵销。
- 不修改用户真实数据、既有验收预期或进程。验证所拥有的隔离实例可清理；不要按进程名批量杀 Electron/Node。
- Electron `.asar` 用物理文件与 `original-fs`，保留已有回归；`.codegraph` 是宿主 Junction，不移动它。
- 不因交接自行维护记忆目录；如需记忆更新，遵守当前环境要求及用户明确指令。本次只写项目交接文件。

## 工作树与归档

交接前只有两项未提交：

- 用户原有 `docs/05_PROJECT_PLAN/production-workflow-v2-20261020.md` 两行追加：保留原样，不改写、不 stage、不并入本轮提交。
- 本会话写的 `outputs/harness-comparison-20261026.md`：本次随交接提交，避免新会话遗漏对照与固定源码链接。

本地运行证据在同一 checkout 可读，但不保证另一台机器/新 worktree 可见。新会话先核对状态；只有实际工作版本变动或证据不充分时再补跑必要测试。

## 可直接粘贴到新会话的启动指令

> 继续执行 Bloma harness 改进计划。工作目录 C:\Users\17359\OneDrive\Desktop\guide-agent-platform-sprint0。先读取 docs/05_PROJECT_PLAN/harness-improvement-handoff-20261027.md 与其中的计划和对照稿，核对 Git 实际状态。可选 AI 灵感建议已在 840f8eb 恢复并完成离线验证，不要重做。从批次 1“验收证据隔离与具体故障诊断”开始，按交接顺序完成剩余工程、必要测试和每批提交；普通已授权实施不要反复询问确认，不 push，不动用户原有两行文档改动、真实项目和数据。保持验收与费用保护；用替身和隔离进程推进，未经明确新预算不发真实付费模型请求。遇到需要用户补充的信息先做完独立可做的部分，再说明具体缺口与证据。
