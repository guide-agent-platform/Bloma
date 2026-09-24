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

## 11. Phase 6 W6 开关（预算与成本层，2026-09-09）

| 开关 | 控制面 | 缺省 | '0'/未设 | '1' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_COMPACT_EST_FALLBACK` | E4 压缩触发 est 兜底（渠道 usage 盲时用全量历史估算作判据） | **on**（2026-09-16 缺省翻转，「上下文向 Proma 同步」批） | 显式 =0/'false' 回旧现状（usage 盲→触发器失明永不压缩，W1 以撒案实锤；逃生口） | 本轮无 usage 回报且 est ≥ 阈值 → 视同阈值满足（压缩/上限/末段规则照常）；确定性交接兑底附检查点段（复用 LOOP_CHECKPOINT）；全量+压缩模式下是唯一安全带（防无界膨胀到渠道 400） | `compactEstFallbackEnabled`（main/coding/agent-loop.ts） |
| `BLOMA_EVIDENCE_CACHE` | D6 静态证据按产物指纹缓存 | **off** | 字节级现状（预检与终验各自直扫） | 安全扫描结果按 (projectId, 产物指纹) 进程内缓存复用（指纹=全量产物 path+mtime+size 聚合，任何修改即失效）；行为类（GWT/API）一律不缓存终验独立重跑 | `evidenceCacheEnabled`（main/coding/evidence-cache.ts） |
| `BLOMA_LOOP_WINDOW_OFF` | 上下文模型：全量+压缩 vs 滑窗 | **on**（2026-09-16 缺省翻转，「上下文向 Proma 同步」批：全量历史+竹节压缩对齐上游） | 显式 =0/'false' 回滑窗现状（窗口化+digest；digest 空提取病灶——以撒案——随退位，E5 配对重放仍可作对照；**窗口行为相关测试今后须钉本开关**） | 主路径/交接输入/宽限轮三处同口径全量透传（原「勿生产开」前提失效：与 EST_FALLBACK 新缺省配套，触发有保底） | `loopWindowOffEnabled`（main/coding/agent-loop.ts） |

- F6 受阻报告不设新开关：复用 `BLOMA_LOOP_CHECKPOINT`（§7）——budget_exhausted/turn_limit 终态产出 blocked_report（候选指纹/未闭环失败/仍有效决策/验证面/建议下一步）+[loop-blocked-report] JSONL 审计行；完成/取消不产。
- D4 预算分桶定案（读码零改码）：预算门在路径/参数/语法/CDN/版本/授权校验全部通过后才烧——协议类失败（diff 不匹配/STALE_READ/未读/越界）一律不烧预算，「协议恢复≠业务失败」结构上已成立；「修复尝试=批次+验证」单位改造需在线数据校准（登记待办）。
- bench 验收（待额度）：`l1-batch --label w6 --env BLOMA_COMPACT_EST_FALLBACK=1` 看渠道盲项目压缩是否恢复触发；E5 三组同 seed 同 N 对照。

## 12. Phase 7 P7-1 开关（key_tasks 关键任务块，2026-09-10）

| 开关 | 控制面 | 缺省 | '0'/未设 | '1' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_KEY_TASKS` | H2 关键任务块（用户语言的交付标尺：「这一版做完什么才算交付」） | **off** | 字节级现状（prd.json 无 key_tasks 键、system prompt 无产出指令、确认卡零注入） | prd-engine system prompt 追加 key_tasks 产出指令（LLM 提炼 2~4 个用户任务视角关键任务）；背板挂载前 finalizeKeyTasks 定稿（feature_ids 白名单过滤→悬空弃条；P0 未覆盖逐条补派生任务 must_deliver=true；task_id 重编号 KT-01..；总量截 6）；PRD 确认卡展示关键任务区（必交/尽力徽标+关联功能） | `keyTasksEnabled`/`finalizeKeyTasks`/`backplaneKeyTasks`（main/model/prd-backplane.ts）+ `parseKeyTasks`/`KEY_TASKS_PROMPT_ADDENDUM`（main/guide/prd-engine-llm.ts） |

- 消费方（后续步骤接线）：P7-2 H1 delivery_status 按 must_deliver 任务判定 verified/partial/unavailable；P7-9 J5 scope_confirmed 事件记 key_tasks 标识；向导 prompt「主任务」表述合批引用 key_tasks 不另写（J3 批次）。
- 单测：tests/unit/key-tasks.test.ts（18 例：开关/解析/定稿/挂载）+ prd-confirm-dialog.test.tsx 渲染 1 例；bench A/B 待额度（`l1-batch --label p7-1 --env BLOMA_KEY_TASKS=1`）。

## 13. Phase 7 P7-2 开关（delivery_status 交付状态，2026-09-10）

| 开关 | 控制面 | 缺省 | '0'/未设 | '1' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_DELIVERY_STATUS` | H1 交付状态三态（verified/partial/unavailable）——「这一版实际验证到什么程度」的规则化结论，错误放行的产品层根治位 | **off** | 字节级现状（project 无 delivery_status 键、终验链路零计算） | 终验三收口点写入 project：①GWT 熔断回滚（用 initial 失败清单——回滚目标版本口径，修复轮改善不美化）②安全未过（unavailable）③GWT+安全全过（verified；后续 judge blocking 不进 ready 不消费）。规则：安全未过/预览不可访问→unavailable；failed=0 且 preflight≠false→verified（v0 从严：预检未过面=partial）；必交任务全关联失败→unavailable；其余（含 API 契约失活不可归属）→partial。key_tasks（P7-1）优先、P0 功能项回退；场景按 `F-xxx ` 前缀归属 | `deliveryStatusEnabled`/`computeDeliveryStatus`/`recordDeliveryStatus`（main/coding/delivery-status.ts）+ 收口接线（programming-orchestrator recordPostTestingDeliveryStatus） |

- LoopValidationSnapshot 扩可选字段 `preflight_passed`（W3→H1 消费链：agent-loop validationOf 跑过才带；存量快照零迁移）。
- 纪律：Agent/loop 工具面无写入口（updateProject 不经工具面暴露）；每次终验重算——旧版本通过不给新版本背书。
- 单测：tests/unit/delivery-status.test.ts（25 例：规则全分支 + B0 六样本重放验收——真实失败清单全部落 partial/unavailable 无一 verified）+ repair 集成 1 例（off 零写入/on 熔断让渡落 partial）；bench A/B 待额度。

## 14. Phase 7 P7-4 开关（澄清层：J1 auto 语义 + J2 两层保护，2026-09-10）

| 开关 | 控制面 | 缺省 | '0'/未设 | '1' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_CLARIFY_AUTO_RESPECT` | J1 auto 轮不计熔断——用户选「你帮我决定」（detail.source=card_auto/free_text_auto 或 option_id=auto）的轮次不计入 trailing 计数（倒序扫描 pendingAnswer 配对卡与回答） | **off** | 字节级现状（计数只看 [decision-card] 行，与用户选择无关——§0 定案缺陷保留） | auto 让渡轮从熔断计数剔除：委托是有效授权非不明确 | `clarifyAutoRespectEnabled`（main/guide/guide-agent-service.ts countTrailingClarificationRounds） |
| `BLOMA_CLARIFY_TWO_LAYER` | J2 两层保护：①同主题卡精确去重（序列内选项集完全相同的第 3 张不再注入→减负卡；宁漏勿误，换措辞不算重复）②第三张连续卡→对话内减负卡（[先看方案][继续补充细节]）替代强制弹窗；「先看方案」走熔断同款收敛链（已点选方向全量带上），「继续补充」计数保留——再熔断直接弹窗兜底 | **off** | 字节级现状（熔断直接转需求确认弹窗） | 两层保护生效；减负卡不落 [decision-card] 行（不膨胀计数）、decision 类型 clarification_reduced_card/relief_answer 不进 CLARIFICATION_ENDING_DECISION_TYPES（澄清序列不断） | `clarifyTwoLayerEnabled`/`countSameOptionCards`/`publishClarificationReliefCard`/`resolveClarificationReliefAnswer`（guide-agent-service.ts） |

- J3（问的门槛三类化）与向导 prompt 合批（Phase 1 外置覆盖线），本批不落代码。
- J4 假设摘要三分区纯呈现层无开关直接上：确认卡功能清单 origin 徽标（你说的/向导补充，payload 透传 item.origin）+ pending CAP 置顶「还需你确认的 1 件事」区块（无 pending_assumption 自动隐藏）。
- 单测：guide-clarification-round-limit.test.ts +7 例（J1 四态/J2-① 精确去重/J2-② off 回归锁与 on 减负卡）+ prd-confirm-dialog.test.tsx +1 例（origin 徽标+pending CAP）；A/B 待额度。

## 15. Phase 7 P7-9a 埋点事件（J5 北极星地基，2026-09-10；纯 append-only 零行为变更不设开关）

| 事件 | 接线点 | payload |
|---|---|---|
| `scope_confirmed` | prd-confirm 确认回传（resumePrdConfirmConfirmed） | via=requirement_ids 清单+count+user_confirmed_at+key_tasks 标识（task_id/label/must_deliver；开关 off 缺席时 requirements 兜底）+adopted_ideas_count |
| `delivery_presented` | ready 收敛发引导卡处（runJudgeReview ready 分支） | via/snapshot_id/delivery_status（缺席记 absent——开关 off 事实入账可归因）/**delivery_body_snapshot 声明文案快照**（append-only 留存，J6 承诺冲突率证据源；后续话术改动不回写） |

- 其余五事件（project_started 扩/clarification_responded/decision_selected/core_task_result/issue_reported）待后续批次；J6 三指标待数据积累。

## 16. Phase 7 P7-5（I1 进度卡 + I4 停止语义，2026-09-10；纯呈现层直接上不设开关）

- I1 里程碑（mapStageToRunSteps）：MVP 3 步改用户任务语汇「制作应用→检查关键功能→最后验收」；repairing 切 4 步模板（「修复发现的问题」仅发生时插入，位置稳定不循环倒退）；ready 完成态 header 改「本轮制作已结束」（阶段结束≠功能可用，验收结论以 delivery 卡为准）；「提出新想法」改「补充或修改要求」；新增「停止本轮制作」入口（onStopGeneration 透传，title 带后果说明）。
- I4 停止语义：停止按钮 aria-label 改「停止本轮制作」；停止后承接系统消息升级三栏（已确认=需求/草图/PRD 保留、已保存=已交付版本不受影响、尚未完成=本轮未验证内容不作交付）+三条后继路径引导（继续制作/调整需求/查看版本记录）。实施稿定性「呈现层重构」（T1 reconcile 承接已有），行为语义未变（停止本就保留成果），不设开关——渲染端无 env 透传链路，若需 A/B 先建透传（登记待办）。
- 跳过项登记：①预计还需区间（I1）——需 analytics 按任务复杂度/阶段分组的数据积累，无数据不造假倒计时；②泳道图降级——生成等待主界面本无泳道图（工具流已是折叠组），无需降级。

## 17. Phase 7 P7-6 开关（H5 决策卡条件化 + H6 先用语义，2026-09-10）

| 开关 | 控制面 | 缺省 | '0'/未设 | '1' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_DECISION_CONDITIONAL` | H5 让渡卡按失败原因条件化动作 + H6 accept 改「先使用已可用的部分」 | **off** | 字节级现状（固定三选项：继续尝试/接受现状/补充说明；accept 话术「已保留当前版本」） | ①test 失败→主按钮「先修好F-xxx再交付」（推荐：修复目标明确）+accept「先使用已可用的部分」（有干净必交任务时）/「先保留这一版」（全败时如实降级不建议当可用版本）；②security→主按钮「继续修复安全问题」；③judge_return→主按钮「告诉我怎么调整」（方向性优先听用户）。accept 话术升级：如实带已知未通过项清单（readTestReport），不改 delivery_status、问题清单不清除持续可见。回传 id 仍 continue/accept/explain 三值（resume 闭环零改动） | `decisionConditionalEnabled`/`buildBlockedQuestions`（main/coding/programming-orchestrator.ts）+ 三调用点 context 接线 |

- 偏差登记：H5/H6 共用一开关（实施稿仅 H6 列开关名单）——两者是同一张卡的一体改造，拆开会出「条件化卡+旧接受现状文案」怪态；A/B 一起看让渡卡转化。
- **四问卡已落（2026-09-11 尾批，与 I3 同批）**：开关 on + test 路径 + W4-F5 升级信号（buildRepairCheckpointContext：loop-checkpoint 账本最近 2 轮修复全部零 resolved 且未收敛）三条件同时满足时，追加第四出口 regenerate「按新方案生成一个版本」+ 卡 body 四问正文（为什么重做/这次换什么/保留什么/代价——没把握直说不确定不编成功率；重做不重置修复预算）。E1 §五纪律：无升级信号（预算用完但有推进）不出；security/judge 路径不出；off 时选项与 payload 均字节级现状。回传处理：resolveBlockedDecision 识别 regenerate（点选+自由文本「换个方案/按新方案/重新生成一版」，泛泛「重新」不误判）；resumeBlockedFlow regenerate 分支=清阻塞+决策留痕+runIterationTask(regenerate:true)——不归一化并入本次诉求（原需求清单直接重摇，保留需求与草图）、不重置 test_repair_count（受总预算约束）、跳过 skip 分支的定向修复路由（用户明确选换方案不再修）、ack 用四问承诺版。单测 +5 例（第四出口出现/无信号不出/security-judge 不出/off 字节锁/回传识别）。
- 单测：blocked-decision.test.ts +5 例（off 回归锁/条件化三分支/全败降级/H6 accept 话术与 delivery_status 不变）+ 尾批四问卡 5 例。

## 18. Phase 7 P7-8（版本层 I5/I6/I8，2026-09-10）

| 开关 | 控制面 | 缺省 | '0'/未设 | '1' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_RESTORE_AS_VERSION` | I6 恢复即新版本 | **off** | 字节级现状（回滚不拍新快照，指针指回源版本） | 回滚事务末尾拍 restored 快照（SnapshotKind 新值；derived_from 指向源版本，Snapshot/CreateInput 扩可选字段零迁移），指针前移到恢复点；恢复前状态仍由 guard 快照保留可找回；TimelinePanel 磁贴带「恢复」徽标 | `restoreAsVersionEnabled`（main/platform-services.ts rollbackSnapshot） |

- I5 术语与边界句（纯呈现直接上）：RollbackConfirmModal 增 data/ 边界真话——「恢复会把应用和它在 Bloma 内保存的数据一起回到那一版；导出部署后在别处产生的数据不受影响」（沙箱数据随回滚是真实能力，如实写不套通用句）。
- I8 导出状态（纯呈现直接上）：exportProjectHandoff 每次导出写 export-info.json（源版本/导出时间/delivery_status/「平台无法观测线上环境」说明）；MvpStatusBanner 导出反馈改「已导出到 …（线上状态未知）」。
- I7 变化摘要未完整落地（登记待办）：四维摘要（新增能力/行为变化/删除受限/验证变化——消费 comparison）依赖产物 diff 管道；v0 仅 restored 快照 summary 带「应用与数据一起回到该版」范围说明。
- 单测：snapshot-documents +2 例（off 回归锁/on 指针链+guard 保留+内容恢复）+ project-export +2 例（export-info.json 未评估/partial 两态）；I5 文案由 timeline 既有渲染测试回归。

## 19. Phase 7 P7-9b 埋点（J5 漏斗中层数据，2026-09-10；纯 append-only 不设开关）

| 事件 | 接线点 | payload |
|---|---|---|
| `project_created`（扩） | ipc PROJECT_CREATE | +initial_message_chars/has_punctuation（首句信息量分层，不记原文） |
| `clarification_responded` | guide-agent-service 四分支（点选=select/让渡=delegate/减负卡先看方案=skip/继续补充=input） | method+trailing_rounds（澄清疲劳漏斗中层；脱敏不记原文） |
| `decision_selected` | resumeBlockedFlow 入口（v0 一处） | stage+action+blocked_action（决策卡转化） |

- 后续批已接（2026-09-11）：decision_selected 其余卡四处——修改确认卡（iteration_confirm，resolveIterationDecisionFlow）/失败重试卡（iteration_retry，take 消费性之后埋）/就绪引导卡（ready_next_steps，next_backend 窄判定零误记）/需求确认弹窗（requirement_confirm，独立 IPC 通道单独埋）。仍待后续：core_task_result（依赖交付卡「先试一次完整流程」新交互面）、issue_reported（依赖报障意图识别——J7 台账发现当前用户行为模式下文本指正 0/82，v0 建议先挂行为信号）；J6 三指标待数据积累。

## 20. Phase 7 P7-7 开关（I3 转向生效确认链，2026-09-11）

| 开关 | 控制面 | 缺省 | '0'/未设 | '1' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_STEER_CONFIRM` | I3 steer 状态机与影响确认 | **off** | 字节级现状（P0-1 纯注入：enqueue 即入队、steer_injected payload 无新键、停止静默清空） | SteerEntry 增状态机 received → pending_impact → merged_this_run \| deferred_next_run \| rejected；影响三档确定性关键词分级（**宁低勿高**）：低=简短确认即注入（received 入队）；中（新功能/改流程）=影响卡三选 [本轮就改/本轮完成后再改/不改了]（pending_impact 不入队等回执）；高（核心目标/数据模型，窄表从严）=建议「停止本轮」承接（保留[仍要本轮注入]降档出口）。**merged_this_run 只由 agent-loop 批间注入完成事件推进**（markSteerMerged 唯一入口，received 之外不可推进——不由对话层单方面宣布）；deferred 形成可见待办（状态条常驻 + mvp_ready 交付时聊天流追加提醒）；停止时未注入条目如实标 rejected（rejectPendingSteer，不再静默消失）；loop 自然收尾残余转 deferred（内容照旧落 JSONL） | `steerConfirmEnabled`/`registerSteer`/`resolveSteer`/`markSteerMerged`/`rejectPendingSteer`/`settleSteerEntry`（main/steer-queue.ts）；注入点 payload 扩（main/coding/agent-loop.ts）；IPC AGENT_STEER_RESOLVE/AGENT_STEER_QUERY + steer_status 事件 + listener 接线（main/ipc.ts、main/orchestrator.ts publishSteerStatusEvent）；渲染端 steerStatusFamily + SteerStatusBar 聊天流内嵌状态条（renderer/agent-atoms.ts、components/ChatPanel.tsx） |

- 语义对照（体验验收①：生成中问「你刚提的修改这轮会做吗？」答案与系统真实状态一致）：merged_this_run/received=会；pending_impact=待你确认；deferred_next_run=下一轮；rejected=不会。getSteerStatuses 是权威答案源（单测锁——无任何路径可在未注入时得到 merged）。
- v0 边界与观察项：①状态条数据随会话内存不落盘（重启丢失——**deferred 已补持久化（2026-09-11 尾批）**：deferred_next_run 达成时 ipc 层 listener 单点拦截→persistSteerDeferredNotice 落会话 JSONL [steer-deferred] system 行，跨重启回放可见的文字待办；渲染端前缀剥离胶囊归类；同一条只 advance 一次无重复落盘）；②账本条目随会话常驻不跨轮清扫（同会话 steer 量级个位数，「本轮」以最近一次注入为准）；③分级词表确定性（无 LLM），宁低勿高——误判低=与现状行为一致无害，误判高会拦住用户；④steer_resolved 埋点未加（resolve 三选分布观察，后续可补）。
- 单测：steer-queue +15 例（分级四组/状态机全转移/三选回执含 loop 结束降级/markSteerMerged 唯一入口+终态不可覆盖/停止拒绝/收尾收口/listener 降级/体验验收①四场景）；agent-loop +3 例（on 注入点联动+payload 扩/off 字节级锁/收尾残余转 deferred）；renderer-steer-status 新文件 4 例（全生命周期翻转/乱序不回退/off 零 upsert/mvp_ready deferred 提醒）；ipc-contract expectedChannels +2。

## 21. P0 污染修复批开关（B1/B2/B3，2026-09-11 全链污染审计 35c1a633 案）

> 背景：《Bloma-编程Agent全链污染审计与修复-20260911.md》P0-B 批——信息回流与运行时对账。
> 同批 A1/A2（骨架口径对齐 + 路由契约显影进背板锚）属模板/提示词信息面直接上（同 J3/H3 先例，无开关）；
> A3（BLOMA_EXPERIENCE=1 狗粮）为本机配置（setx），不进仓库。

| 开关 | 控制面 | 缺省 | '0'/未设 | '1' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_ROUTE_ERROR_FEEDBACK` | B1 挂载错误回流 | **off** | 失败 reason 字节级现状（「契约端点失活（HTTP 404，路由未实现或挂载失败）」，不取健康端点） | api-contract 探针遇 404/5xx 先取 `GET /_bloma/routes` 健康端点，把真实 require 报错写进失败 reason（精确匹配 endpoint 资源段 ↔ 挂载失败文件名；不匹配附摘要；端点缺席/无错误维持现状措辞）。不改变判定语义（404 仍判失败），仅信息增强进修复任务 payload | `routeErrorFeedbackEnabled`/`routeFailureReason`/`fetchRouteMountErrors`（main/coding/api-contract.ts） |
| `BLOMA_REPAIR_NOOP_GUARD` | B2 修复轮零编辑守卫 | **off** | 字节级现状（零编辑修复轮照样计轮、照样全量重验——B0 五案 initial=after_repair 的假修复） | repairAndRetest 判 runRepairLoop 返回的 toolCalls 无 write_file/edit_file → 不计轮（test_repair_count 回退）、不重验（产物未变重验必逐条相同）、落 decision `repair_noop_skipped` + 旁白如实「不计入预算」、零编辑轮入 loop-checkpoint 账本（files_touched=[]，W4-F5 升级信号与 H5 四问卡自然承接）；熔断收口口径不变（陷阱 37） | `repairNoopGuardEnabled`/`hasWriteEditToolCall`（main/coding/repair-loop.ts）+ repairAndRetest 守卫块（main/coding/programming-orchestrator.ts）+ DecisionType 新值 `repair_noop_skipped` |
| `BLOMA_LOOP_PROGRESS_NUDGE` | B3 loop 进度对账三守卫 | **off** | 字节级现状（零注入，messages/JSONL 字节不变） | 主 loop 批间（steer 同点位）注入【进度对账（宿主注入）】user 消息：①连续 6 轮无 write/edit → 提醒落盘（注入后重置计数）；②轮次 ≥75% 且 plan 清单（编排器透传 planFiles）存在 → 未触达文件列名（含入口接线提示）；③进入后 1/3 轮次仍零验证工具调用（run_preview/run_gwt_tests/run_security_scan/run_api_contract_tests/run_preflight）→ 自测提醒。只挂主 loop（修复轮无 plan 上下文）；wrapUp 激活后不注入；计入滑窗/压缩管道不破坏「整批 tool_result 单条 user 消息」不变式 | `loopProgressNudgeEnabled`/`PROGRESS_READ_ONLY_TURNS`/`normalizeProgressPath` + AgentLoopInput.planFiles（main/coding/agent-loop.ts）+ runMvpViaAgentLoop 透传（main/coding/programming-orchestrator.ts） |

- 无开关直接上（信息面，A1/A2）：①骨架 src/app.js 头部注释从「禁 ESM/禁网络/localStorage」改为构建链 + server/routes 口径（与完整程序硬规则对齐）；②index.html 预置 `<script src="./dist/app.js" defer>` 承接位（预览服务器 dist/ 正常静态托管、CSP script-src 'self' 允许——已核实）；③renderBackplaneAnchor【后端 API 契约】段在 interface_spec 非空时追加 CJS 模块格式条款（module.exports={'METHOD /path':fn}、require 加载、禁 ESM）；④骨架幂等预置 server/routes/_example.js（只读 CJS 样例，全注释零路由副作用）+ manifest 登记。
- 基础设施常开（B1 服务器侧，无行为分支）：两处同构服务器模板（renderStaticServer 产物模板 + STATIC_SERVER_SCRIPT 沙箱）loadRoutes 挂载失败登记 routeErrors + 暴露 `GET /_bloma/routes` 健康端点（返回 {mounted, errors}）——新增只读端点不动既有路径判定。
- 单测：api-contract +3 例（off 字节锁/on 精确匹配/on 摘要与缺席降级）；programming-orchestrator-repair +3 例（零编辑×off 字节锁 / 零编辑×on 四断言 / 有编辑×on 不误伤——有编辑×off 由既有测试全量覆盖）；agent-loop +4 例（守卫 1/2/3 触发与不触发 / off 字节锁含 JSONL）；prd-interface-spec +1 例（A2 锚点渲染快照）；project-skeleton +3 例（承接位/口径对齐/_example.js CJS 样例）+ describe 语义更新。
- 重放验收（同款 seed「做一个纵版打飞机的游戏，很复古的那种」）：预期 loop 内出现 app.js/index.html 写入、路由 CJS 挂载成功、若空口完成则零编辑守卫触发不耗预算。

## 22. P1 门禁去水分批开关（C2/C3，2026-09-11 审计实施稿 P1 批；C1a 信息显影与 C5 配置见下）

| 开关 | 控制面 | 缺省 | '0'/未设 | '1' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_BUILD_GATE_WIRING` | C2 构建门禁接线校验 | **off** | 字节级现状（bundle 成功即 passed——440B 空壳 stub 假绿保留） | bundle 成功后解析 index.html：零 `<script src>` 或未引用构建产物路径 → `failed` 附真实原因（审计案 35c1a633 终态 index.html 零 script 的根治位；与 A1 承接位配合后正常产物必过）；index.html 缺失 → 跳过校验（上游 AGENT_LOOP_INCOMPLETE 已拦） | `buildGateWiringEnabled`/`checkEntryWiring`（main/coding/build-gate.ts）+ runBuildGate passed 分支前置 |
| `BLOMA_UI_GATE_LIVENESS` | C3 L0 死按钮判活 | **off** | 字节级现状（判「控件真实」不判「有行为」——7 个无 JS 死按钮照样 passed） | 真按钮类（button/[role=button]）采样死亡占比 ≥80% 且 realControls ≥3 → failed 附死按钮清单；防误杀：锚点/外链/伪装控件不进分母（外链 target=_blank 被拦、纯锚点无义务改 DOM），按钮样本 ≥3 才判 | `uiGateLivenessEnabled`（main/coding/artifact-ui-gate.ts）+ analyzeUiProbe C3 段 + deadClicks 采集扩 tag 字段（纯增量，旧数据无 tag 不进分母） |

- 无开关直接上（信息显影，C1a）：`requirementImpliesBackend`（prd-backplane，与 deriveInterfaceSpec 同源留存信号词表）→ PRD 确认卡 requirements 投影带 `implies_backend: true` → 渲染端 PrdConfirmDialog 蓝色徽标「↳ 将要求后端与数据持久化」——留存信号词命中项在确认时可见，不再静默升级前后端分离（审计⑧；不改变派生行为，纯呈现）。
- C5 配置级（不进仓库）：本机 `setx BLOMA_API_TOOL 1`——loop 内启用 `run_api_contract_tests` 自测工具（与 B3 守卫3 自测提醒配合，生成中即可暴露契约失活）。
- 单测：build-gate +3 例（checkEntryWiring 四态/off 字节锁/on 承接位过与零 script 拦截）；artifact-ui-gate +4 例（off 字节锁/审计案 7 死按钮拦/锚点不进分母/活性与样本不足不判）；prd-interface-spec +2 例（requirementImpliesBackend 词表与聚合一致性）；guide-prd-confirm +1 断言（payload implies_backend 投影）；prd-confirm-dialog +1 例（徽标渲染与未命中不带）。
- 待拍板挂账不变：C1b（game 豁免留存派生 vs「完整程序」终点口径）、C4（canvas GWT 断言走游戏侧探针，依赖 gwt-runner 扩展）。

## 23. P1 拍板批开关（C1b/C4，2026-09-11 用户拍板「与建议一致，都需要改」）

| 开关 | 控制面 | 缺省 | '0'/未设 | '1' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_GAME_DERIVE_EXEMPT` | C1b game 豁免留存派生 | **off** | 字节级现状（game 类留存信号照派 /api/records，街机游戏升级前后端分离） | game 类 deriveInterfaceSpec 兜底不派生（localStorage 满足「最高分」类轻留存）；LLM 明确报告的 interface_spec 不受影响；requirementImpliesBackend（C1a 徽标）同步不亮；R-DATA-01 双源（rules-registry rulesForTemplateType 变体 + loop prompt 内联变体）改为「按量级分流：重业务数据后端 / 单值轻留存 localStorage」 | `gameDeriveExemptEnabled`/`deriveInterfaceSpec`/`requirementImpliesBackend`（main/model/prd-backplane.ts）；两派生调用点传 templateType（document-engine 模板路径 / prd-engine-llm LLM 路径）；`rulesForTemplateType`（main/rules-registry.ts）；内联变体（buildAgentLoopSystemPrompt） |
| `BLOMA_GWT_GAME_PROBE` | C4 canvas 断言游戏侧探针 | **off** | 字节级现状（位移断言照走 DOM 位移判定——canvas 游戏结构性假失败） | ①game 生成 prompt 注入【游戏探针通道】契约（产物须挂 window.__g：__g.mode 阶段字符串 + __g.state() 玩家坐标快照）；②gwt-runner 位移类断言（key 触发 × move-* 效果）产物暴露 __g 时走游戏侧判定：前置进 playing（menu 态自动点开始/继续类按钮，未进入如实报）、按键派发后比对玩家坐标方向；无坐标如实指出契约缺口（不用快照变化兜底防游戏自动 tick 假绿）；无 __g 通道 → 现状 DOM 判定（字节级） | `gwtGameProbeEnabled`/`isMoveEffect`/`gamePlayerCoordOf`/`checkGameMoveEffect`/`runGameProbeScenario`（main/gwt-runner.ts）；prompt 契约段（buildAgentLoopSystemPrompt game 分支） |

- 单测：prd-interface-spec +3 例（off 字节锁/on game 豁免/on 非 game 照派+旧调用兼容）；rules-registry +2 例（off 原表字节锁/on+game 仅 R-DATA-01 变体其余规则引用相等）；gwt-game-probe 新文件 9 例（开关/isMoveEffect/坐标提取四态/方向判定/契约缺口文案/prompt 注入三态）。
- 本机配置（setx，重启 Bloma 生效）：BLOMA_GAME_DERIVE_EXEMPT=1 + BLOMA_GWT_GAME_PROBE=1（用户拍板即开）。
- 至此审计稿全部修复项（A1/A2/A3/B1/B2/B3/C1a/C1b/C2/C3/C4/C5）落地完毕。

## 24. Phase 8 工作模式对齐批开关（W1/W2，2026-09-11 狗粮 94f449c6 复盘拍板「照搬正常 agent 工作模式」）

| 开关 | 控制面 | 缺省 | '0' | '1'/未设 | 落点 |
|---|---|---|---|---|---|
| `BLOMA_ITER_BRIEF` | W1/W2 局部修改轮聚焦任务书（iteration brief） | **on** | 字节级现状（localOnly 迭代轮照旧全量 MVP 任务书/骨架模块库重渲染/plan 全量规划/maxTurns 模式档——狗粮 94f449c6 的 37 轮 turn_limit 形态） | ①task 换聚焦任务书（用户诉求原话 + grep-first/先复现/最小变更/聚焦完成判据五要素）；②system 追加【修改模式】段（对齐修复轮 REPAIR_MODE_SECTION：任务书即全部工作，不要重新生成整个项目）；③本轮锚 localOnly 强制（照 resolveFocusAnchor 先例）；④maxTurns 收窄 local 档；⑤跳过骨架/模块库重渲染（文件全貌由项目地图承担，落 decision skeleton_render_skipped_local）；⑥plan 腿换定位合同（只改既有文件，模型给出不存在文件硬剔除，全不存在 → null fail-open）；⑦loop-log 标注「迭代重生成（局部修改）」+ decision iteration_brief 任务书快照 | `iterationBriefEnabled`/`buildIterationTask`/`ITERATION_MODE_SECTION`/`resolveAgentLoopMaxTurnsLocal`（main/coding/iteration-brief.ts）+ `resolveLoopMaxTurnsForInput`/`iterationBriefActive`/runMvpViaAgentLoop 六接线点（main/coding/programming-orchestrator.ts）+ loop-planner localOnly 分支（main/coding/loop-planner.ts）+ DecisionType 新值 `iteration_brief`/`skeleton_render_skipped_local`（main/decision-log.ts） |
| `BLOMA_LOOP_MAX_TURNS_LOCAL` | local 档轮次预算覆盖 | **12**（未设） | — | 正整数覆盖（非法值回退 12，对齐 resolveAgentLoopMaxTurns 口径） | `resolveAgentLoopMaxTurnsLocal`（main/coding/iteration-brief.ts） |

- 缺省 on 的理由：纯任务书表达层（无验证语义变化、无存储 schema 变化），且 off 形态已被狗粮实证为失败形态；逃生口 `BLOMA_ITER_BRIEF=0` 保留（与修复轮/门禁类开关缺省 off 的纪律不同，属拍板项——如需回退字节级现状设 0 即可）。
- 单测：iteration-brief 新文件 15 例（开关三态/local 档三态/任务书五要素/修改模式段/路由含 off 字节锁与 rebuild 优先级/plan 腿定位口径与既有文件硬过滤三态）。
- 不进本批挂账：`inspect_preview` 视觉复现工具；迭代轮 writeScope 写授权（修复轮 W4-F2 同款）；degenerate 出口与 turn_limit 状态区分；game F-001 拆分；经验库 ref-source 查询词清洗（百度百科垃圾 pattern 卡）。

## 25. D2 DSML 传输事故恢复开关（2026-09-11 狗粮 dd6ba98d「纵版打飞机」三连死根因）

| 开关 | 控制面 | 缺省 | '0' | '1'/未设 | 落点 |
|---|---|---|---|---|---|
| `BLOMA_DSML_RECOVERY` | DSML 传输事故分级恢复 | **on** | 现状（退化一律泛化「传输事故反馈」重试一次，仍脏 → turn_limit——当晚 3/3 loop 死于此） | **只读调用直执行**：正文里的 `<｜｜DSML｜｜ invoke>` 块解析回 tool_use（意图/参数当晚实测完整：path/offset/pattern 无损），按正常轮执行（旁白保留、JSONL 原文留审计、模型侧 messages 用合成 tool_use+tool_result）；**写类不盲执行**：write_file 的 content 经 DSML 序列化疑似丢换行（line146 实锤：注释吞掉本该换行的属性），改**定向反馈**（具体列出调用意图要求标准 tool use 重发，比泛化反馈更可能逃出退化盆地）。护栏：参数值 >1024 字符/单轮 >8 invoke/工具不在册 → 降级反馈；恢复计数 transport_recoveries 入 AgentLoopResult + agent_loop_completed 埋点 + 决策日志 | `parseDsmlInvokes`/`classifyDsmlRecovery`/`buildTargetedDegenerateFeedback`/`DSML_RECOVERABLE_TOOLS`（main/coding/dsml-recovery.ts）+ agent-loop 退化分支恢复接线（assistantBlocks 重建/定向反馈/计数） |

- 缺省 on 拍板理由：只读恢复零副作用、写类明确不盲执行、护栏齐备；属渠道兼容垫片而非行为实验（当晚 3/3 loop 死于 DSML，recovery 是存活前提）。
- 单测：dsml-recovery 新文件 10 例（当晚实测三种文法解析/分级四态/定向反馈/off 现状字节级/集成三例——退化 read 轮救回含 messages 上下文断言、退化 write 轮零执行+定向反馈、开关 off 泛化反馈）。
- 与 P2a 协作：恢复失败仍死 → termination_detail(degenerate_output) 照实入账（裁判话术「末轮输出退化（传输事故，非轮数耗尽）」）。

## 26. R2 市调模式开关（2026-09-12 用户拍板「cut 掉网络搜索环节，只由 agent 提创造性建议」）

| 开关 | 控制面 | 缺省 | 'agent'/未设 | 'scrape'/'search'/'1'/'on' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_RESEARCH_MODE` | 市调/灵感来源模式 | **agent** | 纯模型灵感建议：需求确认与 PRD 确认两处均**不发任何网络请求**，向导 LLM 基于自身产品知识出 3~5 条创造性灵感（AGENT_IDEA_SYSTEM_PROMPT：同类经典玩法/交互/差异化设计，可引真实经典产品名、禁止编造；label≤20/note≤40/source='AI 建议'）；失败/解析失败 → 想法区隐藏弹窗照常。卡面头标如实显示「灵感参考（AI 灵感建议）」，决策日志 research_mode 入账 | 现状市调链路（查询词构造→DDG/Bing 搜索→R1 词典过滤→LLM 提炼；逃生口——配好付费搜索 API/代理后切回） | `researchModeResolver`/`generateAgentIdeas`（main/guide/guide-agent-service.ts）+ 需求确认/PRD 确认两接线点 + publishPrdConfirmCard ideasMode 透传（main/guide/prd-confirm.ts）+ 渲染端 research.mode/ideasMode 解析与头标（agent-atoms.ts + RequirementConfirmDialog/PrdConfirmDialog） |

- 缺省 agent 拍板理由：R1 实测三大 scraping 引擎在大陆网络全线不可靠（DDG 封锁 / cn.bing 反爬罐头 / 百度限频），市调链路在最常见环境下产出为零或垃圾；模型自身产品知识在灵感参考场景下质量不低于垃圾搜索。
- R1 词典过滤对 scrape 模式保持生效（切回时防线仍在）；agent 模式想法继续过经验库 P2b 垃圾过滤兜底。
- 单测：guide-research-mode 新文件 5 例（模式矩阵四态/JSON 清洗+source/垃圾三态/空需求与抛错/超量截断）。

## 27. W5 任务清单工作流开关（Phase 8.5，2026-09-12 用户反馈「编程 agent 工作流未与平台同步」——狗粮 dd6ba98d 生成轮 16 轮写后全量重读 + 6 文件完整重写第二遍）

| 开关 | 控制面 | 缺省 | '0' | '1'/未设 | 落点 |
|---|---|---|---|---|---|
| `BLOMA_TASK_WORKFLOW` | 任务清单驱动的生成 loop | **on** | 字节级现状（静态 plan 合同 + 全量任务书「逐功能项实现」——当晚大爆炸式写完→重读→重写形态） | ①**W5-1 实施清单**：renderTaskChecklist 把 plan filesToTouch 分组为有序编号任务（入口/模块/装配/后端路由 + 验证口径映射 + 工作纪律）注入 system；②**W5-4 任务书升级**：「按实施清单逐项推进：定位→实现→立即验证→勾选；禁止先全读再全写；已完成项不重读不重写，微调用 edit_file」；③**W5-2 进度投影**（批间注入，≥2 轮间隔）：「清单 N/M + 已完成勿重写 + 读过的不要重读」；④**W5-3 守卫4 重复写**：同文件第二次全量 write_file → 提醒改 edit_file（edit 不触发）；⑤**W5-5 早验证**：≥3 文件零验证且过 1/3 轮次 → 一次性自测提醒（B3 守卫3 的前移分支） | `taskWorkflowEnabled`（main/agent-loop.ts）+ W5 批间注入块与状态区（main/coding/agent-loop.ts）+ `renderTaskChecklist`（main/coding/loop-planner.ts）+ buildSystemWithPlan checklist 拼接与 buildAgentLoopTask 分支（main/coding/programming-orchestrator.ts） |

- 缺省 on 拍板理由：纯任务书/宿主注入层，无验证语义变化；off 形态当晚被实证为失败形态。
- 只挂主 loop 生成路径（修复轮任务窄、迭代轮聚焦任务书已含工作法，均不叠加）。
- 单测：task-workflow 新文件 7 例（checklist 分组/纪律/验证映射、守卫4 触发与 edit 不触发、投影注入与间隔抑制、早验证一次性、off 字节级）；programming-orchestrator-plan 钉 W5 关保持原字节锁。

## 28. Phase 9 W1 终验静态对账开关（2026-09-12 B 站播放器案 214397c3——假绿交付三死因：blob 媒体被 CSP 拦 / 前端发明 /api/bili 后端零存在 / 外链直连 CSP+防盗链）

| 开关 | 控制面 | 缺省 | off/未设 | '1'/'true' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_API_RECONCILE` | 终验静态对账族：API 三方对账 + 媒体源纪律 | **off** | 字节级现状（interface_spec 空即契约豁免，前端发明 API 无人拦——B 站案形态） | ①**反向对账**：产物 src/index.html 扫描 `'/api/<前缀>'` 引用 ⇄ server/routes/ 文件清单——引用前缀无路由文件 → 失败（B 站案主死因）；②**正向对账**：interface_spec 端点前缀 ⇄ 路由（W1.2 占位端点 /api/external 例外：有路由目录即履行，零路由必红）；③**媒体源纪律**：硬编码外链媒体源（`<video src="https://…`、`.src = 'https://…`）→ 失败（外链必走同源代理）。失败并入 runGwtWithApiContract（与 L0 门禁/api-contract 同款合并位），decision api_reconcile 入账；项目缺失 fail-open 跳过 | `apiReconcileEnabled`/`reconcileApiUsage`/`checkMediaSourceDiscipline`（main/coding/api-reconcile.ts）+ runGwtWithApiContract 接线（programming-orchestrator.ts） |

- 无开关直上项（W1 批）：**产物 CSP 补 `media-src 'self' blob:`**——单一真相源 main/coding/product-csp.ts，沙箱脚本与 static-server 模板两处插值引用（`'Content-Security-Policy': ${JSON.stringify(PRODUCT_CSP)}`），product-csp 测试锁两处一致（B1 基础设施先例）；**deriveInterfaceSpec 外部服务信号词**（直连/在线播放/语音输入/bilibili 等）派生 /api/external 占位端点 + requirementImpliesBackend 徽标同步（C1a 显影路）；**loop【媒体纪律】段**（禁扩展名直判/canPlayType 实测承诺/blob 本地播放/外链同源代理/DASH 分片不可直给）；**gwt-runner** launch 加 `--use-fake-device-for-media-stream` + 媒体启动健康探针（自动加载的 video/audio error 即判败，计数与 failure_summary 对齐）。
- 单测：product-csp 新文件 3 例（字段/模板插值/沙箱引用）；prd-interface-spec +5 例（B 站式派生/纯本地不误伤/语音叠加/纯展示零派生/徽标同步）；api-reconcile 新文件 7 例（B 站案形态必红/齐备绿/占位豁免语义/内置与只读目录豁免/off 字节级/外链直连红/blob 不误伤）。
- 验收实证：B 站产物 214397c3 现场对账红（反向 /api/bili 命中）——同款产物在开关 on 后不可能再假绿（Phase 9 验收第 5 条）。本机 setx 待用户拍板（狗粮前 `setx BLOMA_API_RECONCILE 1` + 重启 Bloma）。

## §29 Phase 10 W1/W2——上游工具同步批（2026-09-16，同步 Proma 工具调用库）

| 开关 | 控制面 | 缺省 | off/未设 | '1'/'true' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_BROWSER_TOOLS` | 预览浏览器工具族（主 loop 八件套） | **off** | 工具零注册、提示词零注入（字节级现状） | 注册 preview_navigate/observe/click/fill/press/extract/screenshot/wait_for（持久 Playwright 会话按 sessionId 缓存，loop finally + 5min 闲置看门狗双保险关闭）；**同源硬边界**：只允许 preview_url origin（外域拒绝并提示走 server/routes 同源代理）；selector-first（CSS 语义与 GWT/修复轮一致，非上游 a11y ref）；截图落盘 documents/preview-shots/ 不回传图像块（loop 工具结果无 image 通道）；observe/extract 附最近控制台错误；loop 系统提示词【预览视觉检查】段（UI 修复改前 observe→改后 click 验证；浏览器证据与 GWT 互补不互替） | `browserToolsEnabled`/`buildPreviewBrowserTools`/`assertSameOrigin`/`closePreviewBrowserSession`（main/coding/preview-browser.ts）+ buildAgentTools parent 注册 + agent-loop finally 清理 + buildAgentLoopSystemPrompt 契约段 |
| `BLOMA_COMPACT_TOOL` | 显式压缩工具 compact_context（主 loop） | **off** | 工具零注册、提示词零注入（字节级现状） | 模型完成大阶段后主动调用：置位 state.compact_requested → 本轮工具对落盘后与自动压缩**同路径**执行（交接 LLM/keep-recent/检查点恢复头/观测全复用）；独立计数上限 MAX_EXPLICIT_COMPACTIONS=4（不占自动压缩 LOOP_MAX_COMPACTIONS=2 预算）；loop_compaction 事件与 onCompaction 带 trigger='explicit'；自动触发器失明（glm input_tokens=0，W1-E6 结论）时是模型侧唯一主动收缩出口；提示词【上下文压缩】段（完成大阶段再调、交接有损勿滥用） | `compactToolEnabled`/`MAX_EXPLICIT_COMPACTIONS`（main/coding/agent-loop.ts）+ compact_context 工具（main/coding/agent-tools.ts）+ 触发管线（agent-loop.ts 压缩段）+ buildAgentLoopSystemPrompt 契约段 |

- 无开关直上项（W3）：**find（glob 文件名搜索）**——只读并行件（与 read_file/list_files/grep 同档无条件注册，全角色），`globToRegExp` 支持 `*` 单段与 `**` 跨目录、Windows 大小写不敏感；计数锁基线 17→18（agent-tools.test.ts 两处），D1 describe beforeEach 钉 BLOMA_BROWSER_TOOLS/BLOMA_COMPACT_TOOL off。
- 不同步项（决策留档防重复评估）：Terminal\*/bash（沙箱写权限边界，给 shell 摧毁零依赖/白名单/CSP 三道防线）；Task\*/Todo\*（进度由 W5 renderTaskChecklist 确定性投影，双源打架）；Upload/ExecuteJavaScript/DomAction/Hover/Drag/SelectOption（v1 场景外，Observe/Click/Fill/Extract 覆盖 90% 检查）；多标签族（产物单页单源）；set_delegation_thinking_level（Bloma 委派无 thinking 概念）；MCP 三族（宿主平台能力非产物 Agent 工具）。
- 单测：preview-browser 新文件 12 例（同源守卫纯函数 4/注册与开关 6/真浏览器集成 1 组 skip-guard）；compact-tool 新文件 5 例（off 字节锁/注册面/显式触发与窗口重置/上限 4/自动预算分离）。
- 狗粮：`setx BLOMA_BROWSER_TOOLS 1` + `setx BLOMA_COMPACT_TOOL 1` + 重启 Bloma（本批两开关均未 setx）。

## §30 Phase 10——向导 loop 化（2026-09-16，「直接同步 loop，只改工具」拍板项）

| 开关 | 控制面 | 缺省 | off/未设 | '1'/'true' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_GUIDE_LOOP` | 向导澄清腿的模型调用层 | **off** | 单次流式 JSON + parseGuideJson（字节级现状） | 澄清腿换 `runAgentLoop` + 向导工具面（main/guide/guide-tools.ts）：**guide_decide** 决策提交口（每 run 一次，参数与旧 JSON 同构，原生 tool_use 入参根治 PARSE_FAILED/截断旧病）+ **read_prd_backplane / read_test_report / list_project_files** 三只读事实工具（向导首次能看见产物）；模型可自由对话（旁白经 message_delta 上屏+落 JSONL），纯聊天轮只收口不弹卡不改阶段；连续 ≥3 轮 free_chat → 下轮 task 注入宿主提醒；失败/取消回退规则路由（同旧兜底）；delegationDepth=1 退出 steer/B3/W5/learnings 主 loop 专属注入；事件面只转发 message_delta（渲染端零改动）。**下游零改动**：首轮护栏/熔断/减负卡/确认门/runPrdPipeline 全部照旧（决策对象同构直进路由块）；决策日志新类型 guide_loop（decision/free_chat 观测） | `guideLoopEnabled`/`buildGuideTools`（main/guide/guide-tools.ts）+ `runGuideLoopTurn`/两态调用层（main/guide/guide-agent-service.ts）+ DecisionType 新值 guide_loop |

- 单测：guide-loop 新文件 7 例（off 字节锁/决策→卡照旧/自由对话收口/三连提醒+清零/失败回退/工具校验+单次预算/测试报告事实工具）。
- 已知 v1 取舍（登记）：决策路径下 loop 旁白与路由块 reply 可能双气泡（提示词已约束不重复，狗粮观察）；free_chat 计数为内存态（跨重启丢失，防线只防当场不收敛）。
- 狗粮：`setx BLOMA_GUIDE_LOOP 1` + 重启 Bloma；预期体验：向导可闲聊/被追问/自己查 PRD 与测试报告再问，收敛卡时机由模型判断。

## §31 Phase 10 W1-1——产物 git 化（2026-09-16，咨询 G 收口·真实项目交付体系）

| 开关 | 控制面 | 缺省 | off/未设 | '1'/'true' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_PROJECT_GIT` | 产物工作区 git 版本管理（host 单点执行，loop 工具面无 git 操作） | **off** | 不 init 不 commit（字节级现状） | `ensureProjectRepo` 幂等 init（.gitignore=data//data-backups//node_modules//dist//*.log/.DS_Store + autocrlf=false + .gitattributes LF + 无全局身份时仓库局部身份兜底）+ `commitProjectState` 生命周期提交（结构化 message `[bloma:kind] summary`）；接线点：终验开始（testing_begin）/交付（mvp_delivered·iteration_delivered）/修复轮前后（repair_begin·repair_loop_end，入口 A/B 双接线）/熔断回滚前后（rollback_pre·rollback_post，recovery-service）——fail-open：git 缺失/失败返回 reason 记 decision project_git 后跳过，绝不阻塞主链路 | `main/coding/project-git.ts` + 编排器接线（commitProjectLifecycle ≤15 行/点）+ `main/recovery-service.ts` circuitBreakRollback |

- **基础设施常开（与本开关无关）**：快照/恢复双侧排除 `.git`/`data-backups`（`SNAPSHOT_PRESERVED_TOPLEVEL`，platform-services）——归档 cpSync filter 排除 + 恢复前挪出/恢复后挪回（同盘 rename）+ finally 兜底；回滚不回退版本史与备份；目录不存在时行为字节级不变。
- 单测：project-git 新文件 9 例（开关三态/off 不建 .git/root_missing fail-open/幂等 init+gitignore 手写行保留+autocrlf/commit+hash+nothing_to_commit+summary 压平/无全局身份局部兜底可提交/data 与 data-backups 被 ignore/归档排除+恢复保留+data 仍精确回滚+挪出零残留——后组不依赖 git 二进制）。
- 狗粮：`setx BLOMA_PROJECT_GIT 1` + 重启 Bloma；观察点：项目目录出现 .git、决策日志/decisions.md 出现 [bloma:*] 提交、回滚后 git log 连续。

## §32 Phase 10 W1-2——回滚代码/数据分离（2026-09-16，咨询 G 收口·真实项目交付体系）

| 开关 | 控制面 | 缺省 | off/未设 | '1'/'true' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_ROLLBACK_CODE_ONLY` | restoreSnapshotFiles 的 data/ 语义 | **off** | data/ 随快照精确回滚（字节级现状，snapshot-data-rollback 既有锁钉死） | 回滚只回代码与文档——data/ 先整份备份到 `data-backups/<快照短id>-<时间戳>/` 再保护性保留（与 .git 同款挪出/挪回，preservedNames 增补 data）；适用 restoreSnapshotFiles 全部调用方（rollbackSnapshot 熔断/IPC 回滚 + T1 崩溃对账）；备份目录本身被快照/恢复双侧排除（§31） | `rollbackCodeOnlyEnabled` + restoreSnapshotFiles（main/platform-services.ts） |

- 单测：rollback-code-only 新文件 5 例（开关三态/off 字节级现状 data 精确回滚/on data 保留+备份内容=回滚前+代码仍回滚/二次回滚备份独立不覆盖/无 data 目录豁免）。
- 已知边界（登记）：I5 回滚弹窗文案两口径展示依赖渲染端 env 透传（I4 先例同款待办）；on 模式下「恢复即新版本」的版本说明需带 data 保留语义（I6 文案后续随拍）。
- 狗粮：`setx BLOMA_ROLLBACK_CODE_ONLY 1` + 重启 Bloma；观察点：熔断回滚后用户数据仍在 + data-backups/ 出现备份。

## §33 Phase 10 W1-3——项目侦察包 ContextPack（2026-09-16，咨询 G 收口·真实项目交付体系）

| 开关 | 控制面 | 缺省 | off/未设 | '1'/'true' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_CONTEXT_PACK` | 迭代/修复轮 task 头的确定性侦察包注入 | **off** | `appendContextPack` 返回原 task 字节级（不触 fs） | task 尾部追加【项目侦察包】段：代码文件清单（≤60，跳 node_modules/dist/data/.git）+ 后端契约⇄`server/routes/` 文件对账（both/backplane/routes_dir 三态+对账 hints）+ `data/` JSON 形状采样（array/object+首条键，坏 JSON 标 unreadable）+ 可复用模块目录（src/official-modules/ 子目录）+ 上次终验基线（test-report 通过数+未过场景）+ 诉求关键词→文件名影响面提示；零 LLM 纯组装 <1s；空态如实为空不编造（openQuestions v0 恒空占位）；渲染段 2200 字符预算确定性截断；段尾明示「速览非任务，定位仍以 grep/地图锚点为准」防喂包反退化 | `main/coding/context-pack.ts`（ContextPack 类型进 shared/types）+ 迭代接线（programming-orchestrator localOnly task）+ 修复接线（repair-loop renderRepairTaskCard 尾）+ DecisionType 新值 context_pack（组装留痕含统计） |

- 单测：context-pack 新文件 11 例（开关三态/off 字节级/空项目全空态/对账 both 无 hint/对账双向 hints/data 采样+坏 JSON/影响面命中/基线含未过场景/60 文件截断+段预算/可复用模块清单/决策留痕 detail）。
- fail-open：组装/渲染/决策任一失败返回原任务（测试锁 off 路径；catch 全包）。
- 狗粮：`setx BLOMA_CONTEXT_PACK 1` + 重启 Bloma；观察点：迭代轮任务书尾部出现侦察包、读癖轮次是否下降（对照 94f449c6 的 49 次 read_file）。

## §34 Phase 10 W1-4——变更契约 ChangeContract（2026-09-16，咨询 G 收口·真实项目交付体系）

| 开关 | 控制面 | 缺省 | off/未设 | '1'/'true' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_CHANGE_CONTRACT` | 迭代/修复轮 system 的变更契约段 + 迭代锚派生源 | **off** | 零派生零注入（字节级现状，anchor 走既有 buildIterationRoundAnchor/buildRepairRoundAnchor） | ①`deriveChangeContract` 确定性派生：goal=诉求原话；mustPreserve=契约端点保持行+既有数据行（≤4 数据文件）；outOfScope=固定守卫+背板范围外前 3；**三向验收**——positive=聚焦项行为断言（≤2/项）、negative=不变量词表扫描（非负/非空/唯一/上限/时间边界/禁止类，命中生成「违规输入必须拒绝不得静默通过」行，无命中如实为空，≤8）、compat=API 存活+旧数据读取断言；baseline=testReport 通过数+gitCommit（W1-1 开启时）；②迭代轮 anchor 改由契约投影（`roundAnchorFromChangeContract`，注入链零改动）；修复轮 anchor 保持既有+追加契约段；③fail-open 派生失败回退既有锚路径 | `main/coding/change-contract.ts`（ChangeContract 类型进 shared/types）+ 迭代接线（programming-orchestrator buildSystemWithPlan）+ 修复接线（repair-loop system） |

- 单测：change-contract 新文件 12 例（开关三态/off 空串/空背板空态如实/不变量三类命中与无命中/mustPreserve 端点+数据/无 spec 无数据 compat 空/outOfScope 组装/baseline 两态+gitCommit/正向验收聚焦断言/渲染空段省略与基线两态/锚投影映射+回退/on 前导段）。
- 登记：修改确认卡契约摘要展示留 v1；LLM 加厚负向断言留 v1（词表先行防编造）。
- 狗粮：`setx BLOMA_CHANGE_CONTRACT 1` + 重启 Bloma；观察点：迭代轮 system 出现【变更契约】段、负向断言是否进 GWT 生成原料（随记灵案「断言措辞驱使实现扭曲」的对症线）。

## §35 Phase 10 W1-5——数据迁移守卫（2026-09-16，咨询 G 收口·真实项目交付体系）

| 开关 | 控制面 | 缺省 | off/未设 | '1'/'true' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_DATA_MIGRATE` | 数据结构变更的迁移纪律与终验演练 | **off** | 纪律段零注入、终验零接入（字节级现状） | ①loop system 追加【数据迁移纪律】段（首写 data/ 建版本文件 `ctx.writeData('schema-version','1')`→data/schema-version.json；改结构必带 `server/routes/_migrate.js` CJS `{from,to,run(ctx)}`；禁弃旧数据重建）；②终验 `runGwtWithApiContract` 增数据迁移门（preview_url 卫语前，纯磁盘）：discipline 四态（no_data/unversioned/ok/drill）+ drill 态执行**迁移演练**——data/ 临时副本上 createRequire 加载 _migrate.js 执行 run(ctx)（ctx 与产物同款 readData/writeData 语义），校验版本到位/数组行数不减/首条标识字段（id/*Id）不漂移/无异常；失败以 GwtFailureSummary 并入修复回流；unversioned 进 unverified 裁判可见；源 data/ 零触碰；decision kind=data_migrate_check | `main/coding/data-migration.ts` + 终验接线（programming-orchestrator）+ 纪律段接线（buildLoopSystemWithOverride）+ 骨架只读样例 `server/routes/_migrate.example.js`（manifest 登记 readonly） |

- 约定修正记录：版本文件定为 `data/schema-version.json`（JSON 字符串、走 ctx 原生 writeData）而非 `.schema-version`——产物 ctx 的 dataPath 对无扩展名自动补 .json，点文件写不进去（测试实证）；骨架 manifest 白名单（.html/.js/.css）也不允许无扩展名文件，版本文件由模型按纪律自建。
- 单测：data-migration 新文件 9 例（开关三态+纪律段/四态扫描/pass 全过+源数据零触碰/丢行/版本未写+标识漂移/覆盖不到+已在目标/抛错+契约不完整/skip 两态）；模板/构建门/注入回归 53 例全绿。
- 狗粮：`setx BLOMA_DATA_MIGRATE 1` + 重启；观察点：B 类 seed（chg-b-note-tag-field）变更后终验是否红「无迁移」或演练不过。

## §36 Phase 10 W1-6——导出清单与升级导出（2026-09-16，咨询 G 收口·真实项目交付体系）

| 开关 | 控制面 | 缺省 | off/未设 | '1'/'true' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_EXPORT_V2` | 导出包 manifest 与 v2 字段 | **off** | exportProjectHandoff 行为字节级现状 | ①导出包写 `export-manifest.json`（sha256-16 相对路径清单，排除集与导出复制同构 node_modules/.git/dist/dist-main；**data/ 入册**——升级要认数据）+ export-info v2 字段（project_id/source_snapshot_id/**git_commit**（W1-1 未启用时 null 如实）/manifest 概要）；②`detectDrift(landedRoot)` 落地产物对账（手改/缺失/新增三分类，只检测不合并）；③`upgradeExport` 升级导出（函数级，IPC/UI 接线登记 v1）：新代码树+携带落地产物 data/（先备份 data-backups/pre-upgrade/）+**真实执行 _migrate 迁移**（复用 W1-5 executeMigration，含版本/行数/标识校验）+upgrade-report.json（漂移+迁移结果+责任边界话术）+重建 manifest | `main/coding/export-manifest.ts` + 导出接线（project-export.ts exportProjectHandoff） |

- **重要环境陷阱（实测入档）**：Windows Node 22.22.0 `fs.cpSync(recursive:true)` 源目录名含非 ASCII（中文项目名）→ **段错误杀进程**（copyFileSync 安全）——本模块一律逐文件复制（PR-3 copyProjectTree 同款规避先例）；快照/恢复路径的 cpSync 源均为 ASCII（uuid 目录）不受影响。
- 单测：export-manifest 新文件 6 例（开关三态/manifest 构建写读回环排除集/漂移三分类+无 manifest clean/git 无仓库 undefined/升级全链（新代码+数据携带+备份+迁移+报告+落地源零触碰）/无迁移 none 态）。
- 狗粮：`setx BLOMA_EXPORT_V2 1` + 重启；观察点：导出包出现 export-manifest.json 且 export-info 带 git_commit。

## §37 Phase 10 W2——经验库采集事件化+存量隔离（2026-09-16，承接 F 系列 Wave 2 拍板 D1/D2）

| 开关 | 控制面 | 缺省 | 语义变化 | 落点 |
|---|---|---|---|---|
| `BLOMA_EXPERIENCE`（既有，语义收窄） | 新事件采集（不改卡消费——消费面已结构性冻结） | **off** | on 时四写点+C3 改落 **v2 事件行**（`record_type:event`：observations 只记事实不产卡不归因，root_cause 停写）；off=零副作用 | `main/experience/event-log.ts`（新，事件/治理行唯一读写面）+ error-card.ts 改写（recordFailureCards 签名不变六写点零改动） |

- **结构性冻结（无开关，拍板 2.3/D2）**：`isConsumable` 只放行 v2 `rule` 卡——v1 anti_pattern/pattern 全部退出注入/裁判消费面（【常见错法】在无 verified 规则卡时恒空，不降门槛不伪造）；账本加载器跳过 v2 行不告警 + 治理行折叠（quarantine/reclassify/retire/supersede 离开全部读取面，折叠区可审计）。
- **v2 规则卡类型**：CardKind 增 'rule'（RuleCardBody：rule_kind/applies_when/failure_mode/recommended_actions/verification/exceptions/causal_status/evidence_refs/rev）；指纹/净化/治理/自证防护/judge 渲染/注入成本全链适配。
- **存量迁移**：`scripts/migrate-experience-v2.mjs`（幂等 migration_id=v2-isolation-20260916）：pattern 卡→card_reclassified（灵感区，`listReclassifiedInspirations()` 读取口，向导接线 v1）+ 其余 v1 卡→card_quarantined（root_cause=symptom 复制未经证实如实入 reason）；--dry-run 支持。
- 单测：experience 族 14 文件 111 例全绿（error-card/write-points 改事件断言；service/governance/judge-checklist 注入夹具换 rule；root-cause 集成改「不产卡」断言；迁移脚本 E2E spawn 真 node）。
- 狗粮观察：`BLOMA_EXPERIENCE=1` 时账本出现 record_type:event 行；老卡不再进任何注入面。

## §38 Phase 10 W2-2/W3——单点消费闭环（2026-09-16，承接 F 系列 Wave 3）

| 开关 | 控制面 | 缺省 | off/未设 | '1'/'true' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_EXP_RULE_INJECT` | 行动规则注入（loop 启动前，与 plan/W5 清单同位） | **off** | mergeAssetMap 第三参=null（注入段字节级缺失） | `buildRuleInjectionMap`：种子登记（EXP-API-001 人工成文→human_review verified，幂等）→ 受控词表硬过滤匹配（stage×template_types×capabilities，≤3 张同 revision 去重）→ 「条件—动作—证据」渲染（适用头/风险/现在执行 n 步/完成证据+假阳性提示/不适用行）并入 plan 腿资产地图；**action_observed**：交付点回看 loop 工具调用序列（run_api_contract_tests 被调→exposure 六档之 action_observed 行，一次性） | `main/experience/rule-injection.ts`（新）+ mergeAssetMap 三参接线（programming-orchestrator）+ finalizeMvpDelivery 动作观测 |

- **EXP-API-001 种子**（咨询 F Q1.4 样板，causal_status=hypothesis，证据=B 站 214397c3+shmup 476847e5）：「涉及服务端外部能力时必须核对前端调用/契约/挂载路由/真实探测，不得只交付前端外壳」——行动步骤引用 run_api_contract_tests 与 api-reconcile 语义；verified 后裁判【常见错法】面自然可见（D2 语义内，非降门槛）。
- **曝光六档**：exposure 事件 payload 增 levels 三档计数（eligible/retrieved/injected）；action_observed 本批落地；check_passed/delivery_observed 挂终验/交付事件（登记待接）。
- **data_migration_failed 接线**：终验迁移演练失败 → 事件行（高优先级诊断队列）。
- **W5 负例已锁**：纯本地任务（无能力面/personal_tool）必须排除 EXP-API-001（测试钉）。
- 单测：rule-injection 新文件 8 例 + experience 族 15 文件 119 例全绿；loop-planner/iteration/repair 回归 71 例全绿。
- 狗粮：`setx BLOMA_EXP_RULE_INJECT 1`（配合 BLOMA_EXPERIENCE=1）+ 重启；观察点：B 站式需求 loop system 出现【行动规则】段且模型调 run_api_contract_tests。

## §39 Phase 10 W4——一键反馈卡+行为信号三分离（2026-09-16，承接 F 系列 Wave 4）

| 开关 | 控制面 | 缺省 | off/未设 | '1'/'true' | 落点 |
|---|---|---|---|---|---|
| `BLOMA_FEEDBACK_CARD` | 「保持现状」后的反馈卡（反馈优先于引导） | **off** | keep 直接发 ready_next_steps 引导卡（字节级现状） | keep 后先发**一键反馈卡**（kind=delivery_feedback，五选项：无法运行/关键功能无效/效果不满意/改变需求/暂不反馈；走通用 user_decision_required+card_option 通道，**零新 IPC 零新渲染组件**）；fb_* 回传路由：负面三项→**issue_hypothesis** 事件行+**issue_reported** 埋点（Phase 7 待办转正，源=反馈卡行为信号非意图识别）+如实话术引导描述问题；改变需求→**behavior_signal**（requirement_change_requested）+输入框引导；暂不反馈→顺势发引导卡 | `publishDeliveryFeedbackCard`（programming-orchestrator）+ keep 分支与 fb_* 路由（orchestrator）+ `isIterationDecisionId` 扩 fb_ 前缀（iteration/pending） |

- **行为信号三分离落地**（F 4.2）：behavior_signal（rebuild_confirm 整版重做信号 + fb_change_needs）/ issue_hypothesis（反馈卡负面项）/ confirmed_failure（**客观证据**：api-reconcile 对账失败接线 runGwtWithApiContract；与 data_migration_failed 并列）——三类事件 kind 均已带写点。
- 登记待办：停止信号（AGENT_CANCELLED 源=user）与「快速返回修改」行为信号待接（J7 三通道余一）；confirmed_failure 终验 GWT 失败面可再扩（现对账+迁移两处客观源）。
- 单测：orchestrator-ready-iteration 13 例（含 W4 新 4 例：开关 on 卡替代/负面项事件+埋点+话术/暂不反馈引导/改变需求行为信号）；experience 族回归 132 例全绿。
- 狗粮：`setx BLOMA_FEEDBACK_CARD 1` + 重启；观察点：点「保持现状」先出反馈卡；选「关键功能无效」后 bloma-experience.jsonl 出 issue_hypothesis 行、analytics 出 issue_reported。

## §40 Phase 10 落地旅程 UI（2026-09-16 深夜补批）——纯呈现直接上（I1/J4 先例）+两条新 IPC

| 通道/组件 | 内容 | 开关 |
|---|---|---|
| `app:switch-state`（IPC 四层+契约） | 实验开关注读面板：main/experiment-switches.ts 白名单注册表（≥10 项 BLOMA_*）→ Record<id,on/off>；渲染端 use-experiment-switches hook（模块级缓存一次拉取，失败 null=fail-open 按现状口径渲染）。**I4「渲染端无 env 透传」待办的窄收口**（不透传全量 env 只给白名单） | 无（只读） |
| `project:upgrade-export`（IPC 四层+契约） | 升级导出 UI 化：系统目录选择器选旧导出包 → W1-6 upgradeExport（新代码+携旧数据+pre-upgrade 备份+真实迁移+upgrade-report+新 manifest）；结果行如实呈现迁移三态与漂移痕迹（失败口径=「旧数据已原样携带并备份，明细见包内 upgrade-report.json」） | 无（能力已由 W1-6 承载） |
| MvpStatusBanner | 导出后出现「升级导出」按钮（data-ai-id=upgrade-export-btn，样式克隆导出按钮）+结果行（upgrade-export-note）；ROLLBACK_CODE_ONLY 开启时横幅信息位「｜回滚保护数据」 | 无 |
| TimelinePanel I5 两口径 | 回滚弹窗 data/ 句按 BLOMA_ROLLBACK_CODE_ONLY 实况切换：on=「恢复只回退应用代码；数据先自动备份（data-backups/）并保留不回退」/off 或未知=现状句 | 随实况 |
| ready 交付卡成熟度行 | buildReadyDeliveryBody 首行「成熟度：完整程序（N 路由·M 数据文件·K 契约）/MVP+（服务端已有，data/ 尚无真实数据）/MVP（静态前端形态…）」——09-06 挂账三态徽标的文本态落地（磁盘+背板确定性判定） | 无（纯呈现） |

- 单测：mvp-status-export 扩 3 例（升级按钮时序/失败如实口径含漂移/取消与 IPC 失败）+ experiment-switches 2 例（注册表完整性+实况三态）；sprint0 契约+export-manifest 回归 18 例全绿。
- 登记待办：设置页「实验开关」可视管理面（写入侧，bloma-switches.json 启动加载方案已论证）；TimelinePanel 两口径组件级测试（hook fail-open 已由注册表测试覆盖语义）。

## §41 W1-W6 真实脚手架与预览呈现改造（2026-09-18，依据《Bloma-真实脚手架与预览呈现改造实施稿-20260918》）

| 通道/件 | 内容 | 开关 |
|---|---|---|
| `BLOMA_REAL_SCAFFOLD` | **总开关（缺省 off=字节级现状）**：on 时 web 形态类型（web_fullstack/personal_tool/game）新项目按 interface_spec 两态判定换 real-static / real-fullstack 骨架包（Express 真实工程：可见 server.js+package.json+llm-proxy 读 env+db.js 原子写）；「沙箱」概念消失——预览分流按 `.bloma-real-variant` 标记（骨架渲染时落盘，随快照恢复）：fullstack→spawn node server.js（cwd 钉根+PORT/BLOMA_APP_LLM_* env）、static→零约定只读 file server、无标记→旧注入路径字节级不变 | **off**（狗粮：setx BLOMA_REAL_SCAFFOLD 1+重启；vendor 已预装 ~/.proma/bloma-vendor/express@4.21.2） |
| 变体标记 `.bloma-real-variant` | 预览分流/交付链注入门/工具面写边界三处统一权威判定（根治文件存在性启发双缺陷：旧路径 loop 期无 static-server.js 误判/real-static 误注入）；agent 写入被拒（SYSTEM_FILES） | 基础设施常开（无开关——标记不存在即旧路径，零影响） |
| 工具面变体分流（agent-tools） | 真实工程件皆产物可写（package.json/server.js/任意后缀），仅拒 node_modules/.git/data-backups/标记；web_fetch 预览 origin 放行（state.preview_url 同源+重定向同源）；契约失败输出附预览地址+日志尾+变体感知指引 | 随标记（无标记=旧规则字节级） |
| RightDockTabs（W4 渲染端） | 右缘把手→dock 覆盖层三标签（预览 iframe 双入口/服务日志 2s 轮询 preview:logs/文件只读 project:file-read）；fixed 不动现有布局 | 纯呈现直接上 |
| 终验治理（W5 无开关直接上） | API 契约 POST 无参端点空体探测（404=未挂载）；GWT 留存语义强制行为场景（禁「可见且可交互」兜底）；安全扫描 serverOnly 域（child_process critical/直连外网 high）；熔断→ready 补发 mvp_review 卡（failureNote 非空主选项 fix_now）；readTestReport 回退 test_completed 事件 | 无（质量门，旧路径同享 POST 探测/留存场景/事件兜底） |

- 快照排除集增 node_modules（vendor 钉版供货确定性可重建，归档不膨胀；回滚后 ensureVendorNodeModules 幂等补拷）；sandboxLogs 32KB 环形截尾；run_preview 成功态回流日志尾。
- 单测：real-skeleton 6 + preview-runtime 5 + right-dock-tabs 5 + agent-tools 变体 1 + api-contract POST 2 + security-scan serverOnly 1 + gwt-service 事件兜底 1 + circuit-rollback fix_now 断言 + orchestrator-plan 换包接线 1；全量 2107 例 12 败=61b7b58 基线存量逐条吻合（agent-loop 9/agent-collab 2/permission flake 1），零回归。
- **W6 验收实测（2026-09-18 18:04）**：①real-fullstack 全链冒烟（骨架→vendor 复制→spawn node server.js）全过——GET / 200 text/html、静态资源 200、POST /api/llm 无 env 如实 503 带 hint、未注册路由 404 带 path JSON、日志 listening 可回流；②纯静态态 file server 真实起进程探活（preview-runtime 测试）；③两态判定链实测（「记录收入与支出」命中留存词→派生契约→real-fullstack，orchestrator-plan 接线测试）；④开关 off 全量单测=基线画像零回归。**待狗粮**：setx 开关+重启，新需求同诉求复刻（期望：Express 路由约定下无全路径键死法、右侧面板可见、熔断卡出现）。
- 挂账：GWT 行为场景的 runner 探针对新句式（重开后数据仍在）的解析覆盖待实测校准；旧路径 static-server 语义待新线稳定后整体退役评估。

## §42 照抄 Proma 稳健性对齐（2026-09-19，依据《Bloma-Proma稳健性对齐实施稿-20260919》；上游参照 proma-upstream @ bf3e98c）

| 通道/件 | 内容 | 开关 |
|---|---|---|
| `BLOMA_PROVIDER_ADAPTER` | loop 查询传输层换上游 providers 口径（main/providers/：sse-reader 首字节超时 30s+首事件前指数退避重试 5 次/30s 预算+多工具调用并行装配+thinking/签名块容错+双认证头+provider 差异化 URL 解析）；SDKQuery 外壳与调用方零改动；=0/false/off 回旧 anthropicMessagesQuery 字节级 | **on**（缺省；逃生口 =0） |
| R0 六杀手（70ed2ff） | real-fullstack 终验/run_gwt_tests 前陈旧检测重建 dist（dist-rebuild.ts）；list_files/find 对 node_modules 如实说明；服务入口指纹进 runSandbox 幂等守卫第四项；约束抓取宿主注入拦截+sanitizeConstraints 消费端清洗；归一化 out_of_scope 反转守卫（isScopeInversion）；回滚 data 无条件备份+话术如实（RollbackResult.data_backup_dir） | 随变体标记/无开关（旧路径字节不变） |
| R1-loop（2ffc8e6） | dsml-display-filter 流式 holdback 呈现净化（只拦 publish，JSONL 原文/模型侧历史不变）；LoopTerminationDetail.dropped_tool_intents 写类意图不丢；NARRATION_EVENTS 分支中文条款 | 无（质量门常开；DSML 恢复 D2 既有 BLOMA_DSML_RECOVERY 不变） |


## §43 协作机制改造（2026-09-24，依据《Bloma-协作机制改造清单-20260924》；批次 1+2）

| 通道/件 | 内容 | 开关 |
|---|---|---|
| C1 委派渠道参数（b37f008） | delegate_agent 新增 channelId/modelId（缺省继承父渠道零变化）；delegation-channel.ts 解析子会话专属 env（query 复用换 env 即换渠道）；跨渠道未传 modelId 自动选首个 supports_tools≠false 已启用模型；渠道钉死不降级；四类失败带教育文案；record.channelOverride 子 loop/continue 共用；summary 携带渠道摘要 | 无（参数缺省即现状） |
| C2 渠道家族断言（b37f008） | channel-family.ts：provider 归一厂商族（zhipu 三形态→zhipu 等）；中转聚合类保守独立；assertReviewFamilyDiversity 同族抛错（C3 地基） | 无（纯函数，C3 消费） |
| C4 委派观察哨（本批） | delegation-watch.ts：全局哨兵周期扫描 running 委派；软超时 8min 经 steer 队列批间注入催办（父无活跃 loop 降级 warn；只催一次）；硬超时 12min stopDelegation 强停+注入式观察者回调（编排器将来接 decision-log）；ask 挂起（pendingQuestion）时钟重置不计费；终态状态惰性清理；扫描数据源 setDelegationScanSource 模块尾单向注入（零静态环） | `BLOMA_DELEGATION_WATCH` **off**（狗粮后翻转；'1'/'true'/'on' 生效） |

- 已知限制：重启恢复的委派 continue 回退继承父渠道（channelOverride env 含密钥仅内存）；观察哨阈值集中可调（测试 seam setDelegationWatchThresholdsForTests）。
- 单测：C1+C2 16 例 + C4 5 例（ask 重置/软一次+降级/硬强停+观察者/惰性清理/真实定时器集成）；全量 212 文件 2160 例零失败。
