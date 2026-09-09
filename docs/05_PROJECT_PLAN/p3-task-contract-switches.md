# P3 任务级三文档契约 · 开关矩阵与实验变量

> 文档 ID：DOC-5.x | 日期：2026-09-04 | 状态：已实施（PR-A~D），线上待验清单见桌面实施稿 §8
> 依据：《Bloma-P3任务级契约实施稿-20260904.md》（设计定稿，D1–D7 已拍板）
> 代码：`main/coding/loop-planner.ts`（plan 腿）/ `main/document-engine.ts`（loop-log）/ `main/model/prd-backplane.ts`（分级锚定）

---

## 1. 三开关矩阵（P3 新增，正交于既有 `BLOMA_INJECT_*` 八点）

| 开关 | 控制面 | 缺省 | '0' | '1' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_PLAN_LEG` | plan 腿（loop 前单轮技术合同） | **quick=off / longterm=on**（D7） | 全关 | 全开 | `planLegEnabled`（loop-planner.ts） |
| `BLOMA_LOOP_LOG` | loop-log 过程日志实时落盘 | **on**（quick/longterm 均开） | 零写盘（诊断噪声逃生门） | = 缺省 | `loopLogEnabled`（document-engine.ts） |
| `BLOMA_FOCUS_ANCHOR` | 迭代分级锚定（背板/骨架地图裁细节不减锚） | **longterm=on / quick=off**（D7 连锁） | 全关（focus 传入也不分级） | 全开 | `focusAnchorEnabled`（model/prd-backplane.ts） |

通用口径（与 `BLOMA_REPAIR_BUDGET` / `BLOMA_SCAFFOLD` 家族一致）：

- 值 `0/off/false`（不区分大小写）= 关；`1/on/true` = 开；未设 = 按模式缺省；
- **全部关闭 = 字节级现状**（回归锁：`tests/unit/coding/programming-orchestrator-plan.test.ts`「全关路径」用例）；
- 三个开关彼此正交，可独立关闭（单变量实验要求）；plan 腿关闭/失败 fail-open 回退现状注入，不阻断 MVP 生成。

## 2. §7 三形态实验 · 新变量登记（PR-D 接线）

既有三形态实验（`prd-forms-experiment.md`）的控制变量是**用户侧输入形态**；P3 落地后任务粒度新增两因子，实验矩阵扩为：

| 因子 | 取值 | 开关 | 说明 |
|---|---|---|---|
| `plan` | on / off | `BLOMA_PLAN_LEG` | off = 现状（无技术合同注入）；on = loop 前 plan 腿产出参考合同 |
| `focus` | on / off | `BLOMA_FOCUS_ANCHOR` | off = 现状（迭代注入全量背板）；on = 迭代分级锚定（命中项全文+其余一行摘要） |

- 缺省组合即对照组：quick = plan off × focus off（= 字节级现状）；longterm = plan on × focus on（完整 P3 形态）；
- 观察指标建议：plan 命中率（plan.filesToTouch 与实际改动文件重合度，loop-log 逐轮 path 记录可对账）、盲查轮数（grep/read_file 首跑占比）、迭代注入 token 量（分级 vs 全量）、改坏无关功能的回归发生率；
- loop-log 与实验正交（对照组也建议保持 on：它是取证通道不是实验变量）。

## 3. 消费产物（documents 体系，零新 IPC）

| 产物 | 路径 | 类型 | 语义 |
|---|---|---|---|
| 技术合同 | `documents/{project_id}/plan.md` | `plan` | 每次 loop 前重写（checkpoint 语义）；用户/快照回看消费 |
| 过程日志 | `documents/{project_id}/loop-log.md` | `loop_log` | append-only：会话分节（MVP 生成/迭代重生成）+ 逐轮 tool(path)+tokens + 终态节；**stale 豁免**，历史永不改写 |

## 4. 线上待验入口

见桌面《Bloma-P3任务级契约实施稿-20260904.md》§8（longterm 实弹 plan 质量 / quick 延迟无感 / loop-log 崩溃取证 / 迭代分级实跑 / glm 渠道兼容）。

---

## 5. Phase 2 新增开关（CAP 能力契约块，2026-09-09）

| 开关 | 控制面 | 缺省 | '0'/未设 | '1' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_CAP_CONTRACT` | 能力契约块 CAP（AI 能力硬条款：产出/派生/三处注入） | **off** | 字节级现状（prd.json 无 ai_capabilities、锚定/裁判/确认卡零注入） | prd-engine-llm prompt 追加产出指令 + LLM 漏报时 deriveAiCapabilities 确定性派生 + renderCapSection 随背板锚定/裁判 prompt/PRD 确认卡三处同源注入 | `capContractEnabled`（model/prd-backplane.ts） |
| `BLOMA_RULES_REGISTRY` | 操作契约 ID 注册表（R-FILE-01/R-DATA-01/R-OUTPUT-01 四段式） | **off** | 字节级现状（内联原文保留） | loop prompt 内联条款让位，注册表段单点定义（每条规则只出现一次完整定义，防双源） | `rulesRegistryEnabled`（main/rules-registry.ts） |
| `BLOMA_ROUND_ANCHOR` | round_anchor 三字段（修复轮/迭代轮本轮错：must_preserve/out_of_scope/completion_evidence） | **off** | 字节级现状（修复/迭代轮 system 不含本轮错段） | 修复轮（两入口）/迭代聚焦路径注入确定性派生的本轮错（P1 稿原定不设开关；因代码先行落地、A/B 后置改设开关保单因子纯净，2026-09-09 偏差登记） | `roundAnchorEnabled`（model/prd-backplane.ts） |
| `BLOMA_JUDGE_ANTIDEGRADE` | 裁判反退化（静态检测 ai-mock-frontend/cheat-control 进硬约束 + 语义裁判反退化规则三条） | **off** | 字节级现状（runJudge 不追加约束、裁判 prompt 不变） | 有 CAP 而产物无 /api/llm→AI 冒充拒；模拟失败类教学控件拒；语义裁判「证据不足不得判 implemented」（P1 稿原定不设开关，偏差同 B3） | `antidegradeEnabled`（review/judge-antidegrade.ts） |
| `BLOMA_EXPRESSION_LAYER` | 表达适配层（B5 MVP：思考型模型表达段 append-only 注入 loop prompt 尾部） | **off（null）** | 字节级现状（无表达段） | `thinking`=思考型四纪律（明确即执行/不输出内部推理/阻塞报告/终轮必出摘要）；`standard`=预留（当前等同 off）；契约层构件字节永不受本层影响（回归锁） | `expressionLayerEnabled`（main/prompt-expression.ts） |

- 依据：《Bloma-P1提示词契约与能力块实施稿-20260909.md》§3 M1 / §4。
- 压缩语义：CAP 随背板锚定进每轮 system 常驻段，竹节/keep-recent 压缩只动历史轮次——「压缩不得删 CAP」由结构保证。
- bench 验收（B1 完成标志）：随心记负样本 CAP 检出 missing；AI 正样本（随心记AI/语顺精灵球）CAP 完整注入。

## 6. Phase D 批次 1 开关（咨询 D 问题1：Loop 工具面与验证协议，2026-09-09）

| 开关 | 控制面 | 缺省 | '0'/未设 | '1' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_API_TOOL` | loop 内 API 契约验证工具 run_api_contract_tests + 收口判定 + prompt 工作方式/终止条件全验证面口径 | **off** | 字节级现状（工具不注册、收口判定不含 API 位、prompt 原文） | 注册 run_api_contract_tests（复用终验同款 checkApiContract+backplane interface_spec）；AgentLoopToolState.api_all_passed 按背板预置（有 interface_spec=false、无=豁免 true、读背板失败 fail-closed false）；wrapUp 加 `!api_all_passed` 拦收口 | `loopApiToolEnabled`（main/coding/agent-loop.ts） |
| `BLOMA_TOOL_EVIDENCE` | 验证工具返回的证据边界行 + 失败 [新增]/[持续] 标注 | **off** | 字节级现状（run_gwt_tests 收口暗示原文保留、无标注） | validationStateLine 宿主维护验证状态行；run_gwt_tests 全过删旧「可继续…或输出完成总结」换动态行；失败条目对比 state.last_gwt_failures 标注；run_preview/run_security_scan 附证据边界 | `toolEvidenceEnabled`（main/coding/agent-loop.ts） |
| `BLOMA_WRITE_GUARD` | write_file 盲覆盖守卫（覆盖未读过的既有文件拦截） | **off** | 字节级现状（write_file 直接写） | write 目标是既有文件且 state.file_revisions 无该文件读取记录→拒绝并要求先 read_file（新建文件不受影响） | `writeGuardEnabled`（main/coding/agent-loop.ts） |

- 依据：《Bloma-咨询D-Loop工具面与验证协议-20260909.md》D1/D2/D3/D4a。
- 附带零开关改动（常开，纯信息附加）：read_file 返回文件版本戳（mtime+size 十六进制）；edit_file 增可选 expected_revision（不传零变化；传了且不匹配→STALE_READ 拒执行）；R-FILE-01 注册表文案补版本戳用法。
- bench 验收（待额度）：`l1-batch --label d1 --env BLOMA_API_TOOL=1` 对比 B0，看「loop 全绿终验失败比例」是否下降。

## 7. Phase 6 W2 开关（loop_checkpoint v0，2026-09-09）

| 开关 | 控制面 | 缺省 | '0'/未设 | '1' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_LOOP_CHECKPOINT` | loop_checkpoint v0：检查点维护+压缩后恢复头+修复证据包+账本落盘 | **off** | 字节级现状（零注入零写盘） | ①压缩后 reset 消息追加检查点恢复头（当前目标/仍有效转向/未闭环失败/验证状态/候选指纹）；②主/修复轮 onCheckpoint 投影持久化 documents/loop-checkpoint.json（steer/验证工具/压缩/终态事件驱动）；③修复卡追加【修复证据包】（候选指纹+此前修复尝试 resolved/persistent/new 对比）；④修复轮收尾追加尝试入账本 | `loopCheckpointEnabled`（main/coding/agent-loop.ts） |

- 依据：《Bloma-咨询D3-Loop长任务检查点与压缩》E2/E3 + 《Bloma-咨询D4-修复轮授权边界与失败升级》F1；互锁合并 F1+E2 同一 checkpoint。
- 无开关常更（纯内部/埋点，非行为）：state.gwt_runs/api_contract_runs/last_gwt_failures 计数与快照；AgentLoopResult.validation；test_completed 的 source/comparison 扩展（D3+F4）。
- `BLOMA_TOOL_EVIDENCE` 含义扩展（W2-F4）：on 时 run_gwt_tests 除证据边界行/标注外，另输出「较上次：修复 X｜持续 Y｜新增 Z」修复比较行——仍单因子控制「验证证据面」。
- bench 验收（待额度）：`l1-batch --label w2 --env BLOMA_LOOP_CHECKPOINT=1` 对比 B0，看修复轮零改善（B0：5/5 initial=after_repair）是否被持久化对比打破。

## 8. Phase 6 W3 开关（收口预检，2026-09-09）

| 开关 | 控制面 | 缺省 | '0'/未设 | '1' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_PREFLIGHT` | run_preflight 收口预检工具 + 收口判定升级 + prompt 全验证面 | **off** | 字节级现状（工具不注册、wrapUp 不含预检位、prompt 原文） | ①注册 run_preflight（一次跑全部验证面：GWT 全量→API 契约→产物 UI 审计→安全，按依赖分阶段；构建门禁不在 v0 预检面——需 skeleton 上下文，终验保留）；②wrapUp 加 preflight_passed 拦收口（失败留 loop 内修，D5）；③工作方式/终止条件改全验证面口径；④validationStateLine 增预检位 | `preflightEnabled`（main/coding/agent-loop.ts） |

- 依据：《Bloma-咨询D-验证分层与收口预检》D1/D2/D5；同源独立原则——工具复用终验同款实现（runGwtScenarios/checkApiContract/runArtifactUiGate/runSecurityScan），终验仍对冻结候选独立取证。
- UI 探针 unavailable 不判败只留痕（与终验口径一致）；预检维护 state.gwt_runs/last_gwt_failures/api_contract_runs（终验 source 分类同源判据）。
- bench 验收（待额度）：`l1-batch --label w3 --env BLOMA_PREFLIGHT=1` 对比 B0，看「终验首次发现确定性违约（coverage_gap 类）」占比是否下降。

## 9. Phase 6 W4 开关（修复轮授权边界，2026-09-09）

| 开关 | 控制面 | 缺省 | '0'/未设 | '1' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_REPAIR_SCOPE` | 修复轮修改授权边界 + repair_control 窄入口 | **off** | 字节级现状（无边界、无窄入口工具，write/edit 全域可写） | ①write_file/edit_file 越界 → WRITE_SCOPE_DENIED + next_actions（授权集=任务卡可派生的文件型 location；场景锚点不当白名单，派生不出 fail-open 不设边界）；②注册 repair_control（request_scope_expansion 判别联合四必填，宿主确定性裁决：普通实现文件自动批准入授权集/受保护路径拒/通配符与起量拒；report_blocker 受阻记录进账本）；③受保护路径缺省 prd.json/test-report.json/loop-checkpoint.json/decisions.md；④升级判定（F5）：连续 ≥2 轮零修复 → 修复卡注入【诊断升级】（换假设/区分性检查/delegate 只读诊断/report_blocker） | `repairScopeEnabled`（main/coding/repair-loop.ts） |

- 依据：《Bloma-咨询D4-修复轮授权边界与失败升级》F2/F3/F5；裁决：全项目读取正确/不带 plan 正确/场景锚点不当白名单。
- 与 BLOMA_WRITE_GUARD 正交：GUARD 拦盲覆盖（未读），SCOPE 拦越界（授权外）；两者可叠加。
- bench 验收（待额度）：`l1-batch --label w4 --env BLOMA_REPAIR_SCOPE=1` 对比 B0，看「根因在卡外→卡内替代实现」类失败是否下降。

## 10. Phase 6 W5 开关（表达与上下文层，2026-09-09）

| 开关 | 控制面 | 缺省 | '0'/未设 | '1' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_NARRATION_EVENTS` | G1 旁白事件驱动五类事件版（G2 同构开头限制的去留即本开关 A/B 对照） | **off** | 字节级现状（每轮旁白+同构开头限制原文） | 表达纪律段替换为：仅新阶段/重要发现/阻塞需决策/长操作进展/交付失败交接五类事件才旁白，普通工具链不逐轮播报；同构开头限制随文案移除；真实性纪律保留 | `narrationEventsEnabled`（main/coding/agent-loop.ts） |

- G3（检查点活跃投影每轮注入）不设新开关：复用 `BLOMA_LOOP_CHECKPOINT`（§7）——on 时 system 尾部追加【检查点投影】（候选指纹/仍有效转向/未闭环失败/验证状态，每轮重建）；观察项：每轮 system 变化会破坏 provider 前缀缓存，在线 A/B 看端到端 token/耗时。
- G6 定案（读码，零改码）：骨架地图是事实性路径锚（文件清单+职责+渲染状态，P3 focus 时非目标文件降存在性行），不断言文件内容；代码事实由 R-FILE-01+版本戳工具化保证——无「旧骨架压过代码事实」结构性风险，G4 拆层时维持「地图=路径锚」现状。
- G5（learnings 按 scope 相关性注入）未落地：learnings 无 scope/适用条件字段可过滤，需 schema 先行（与 Phase 4 C 系列 scope 字段联动）——登记待办。
- G4（system 三层化/PRD 索引化）、G7（2×2 实验）按计划待 C/D 组数据与在线额度。
