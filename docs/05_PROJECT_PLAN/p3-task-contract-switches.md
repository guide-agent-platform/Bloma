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
| `BLOMA_COMPACT_EST_FALLBACK` | E4 压缩触发 est 兜底（渠道 usage 盲时用全量历史估算作判据） | **off** | 字节级现状（usage 盲→触发器失明永不压缩，W1 以撒案实锤） | 本轮无 usage 回报且 est ≥ 阈值 → 视同阈值满足（压缩/上限/末段规则照常）；确定性交接兑底附检查点段（复用 LOOP_CHECKPOINT） | `compactEstFallbackEnabled`（main/coding/agent-loop.ts） |
| `BLOMA_EVIDENCE_CACHE` | D6 静态证据按产物指纹缓存 | **off** | 字节级现状（预检与终验各自直扫） | 安全扫描结果按 (projectId, 产物指纹) 进程内缓存复用（指纹=全量产物 path+mtime+size 聚合，任何修改即失效）；行为类（GWT/API）一律不缓存终验独立重跑 | `evidenceCacheEnabled`（main/coding/evidence-cache.ts） |
| `BLOMA_LOOP_WINDOW_OFF` | E5 C 组实验：滑窗/摘要旁路 | **off** | 字节级现状（窗口化+digest） | 全量历史透传（仅配对重放诊断对照，长任务必爆上下文勿生产开）；E5 组态：A=现状 / B=`--env BLOMA_LOOP_CHECKPOINT=1` / C=本开关；长任务 seed=以撒 | `loopWindowOffEnabled`（main/coding/agent-loop.ts） |

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
