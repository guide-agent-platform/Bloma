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
