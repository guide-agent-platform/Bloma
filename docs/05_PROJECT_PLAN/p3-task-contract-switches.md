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
