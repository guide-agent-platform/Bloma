# 固定任务对照与当前取舍

2026-10-28 补齐同一 home 下两组的项目级配置、独立设计路线摘要及实际 B 请求统计；新操作顺序见 [项目级 A＋B 对照](independent-model-comparison-20261028.md)。旧全局配置保留兼容，不能再把切换全局开关当作隔离对照操作。

工程准备对应 [Harness 改进计划](harness-improvement-plan-20261027.md) 批次 4。**真实单模型/A+B 对照尚未执行**：用户未给新付费预算，本轮没有供应商请求，没有模型质量/速度/成本收益结论。

## 固定协议

版本化任务为 `tests/fixtures/harness-evaluation/tasks.v1.json`：本地姓名清单、带完整历史的桌面计算器、本地课程笔记。任务只描述功能、数据、异常及使用边界，不把框架、骨架或测试工具塞进用户需求。

协议封存全部任务、目标、业务预期、预算和 offline/paid 模式。单模型和 A+B 使用同一份协议、同一确认目标和界面设计，分别使用新隔离项目，不能在失败后覆盖同一项目的研究记录。绑定时核对确认需求的描述/预期、约束、范围外事项与形态；旧范围、改写协议、路线不符或重复绑定拒绝。运行时再次记录实际验收路线；配对还核对 ledger 中 A 的模型与渠道 host，缺失、改变或配对歧义均不视为公平对照。

封存不调用模型，不给模型新增预算权限。paid 研究还须用户明确的新授权，绑定项目、operation、protocol digest 和相同金额上限；普通金额保护与第二模型的完整请求预留保护仍独立生效。不能用 prepare/bind 绕过渠道/账本前置检查。

## 采集口径

- 自运行入口开始计时，包含 B 设计阶段；首次实际独立试用就绪记录版本。这个指标是已实际启动试用的时间，不能冒称代码第一次具备可运行能力的精确时刻。
- 正式交付时间只接受发布/交付实际提交后的 delivery_final。中间 verified 检查点、复用 PASS、环境待验证都不能替代交付。
- 记录每次真实验收结果和运行终态；失败、中止、等待环境、重复修复均保留，不只筛选最后成功者。相同消息经 steer/排队/恢复处理不会重复计为用户介入。
- 修复耗时按实际主循环的 repairing→下一状态区间记录，分 product_assertion 和 harness/test_adapter/environment；未知类别单独保留，不猜成产品修复或设施排障。区间含该轮工程工作，不等于纯编码耗时。
- 所有物理请求从完整 usage ledger 的 transport_started 身份去重获得；原文件与 SHA-256 必须保留。金额只接受可核对的用户余额/费用证明；未结算金额与供应商未知费用不能写成零。整个项目的前期准备和 B 请求也纳入总账，不只看最后一轮。
- 漏检/误报必须来自独立宿主审计或人工复核证据，缺少时是未知，不是零。以最终审计快照为准，重叠复核不叠加计数。用户介入的自动计数当前覆盖带版本的试用反馈，其余介入须显式补充研究注记，不能假称已自动捕获所有用户操作。
- 研究收集器不参与产品 PASS 裁决；写入失败、断序、换宿主、范围改变、缺账本/费用/审计会使研究样本不可比较。原始运行仍保留。

## 可重复命令（零模型调用）

```powershell
node scripts/harness-evaluation.mjs prepare tests/fixtures/harness-evaluation/tasks.v1.json run-artifacts/harness-evaluation-offline-20261027/protocol.json offline 0
node scripts/harness-evaluation.mjs report run-artifacts/harness-evaluation-offline-20261027/report.json run-artifacts/harness-evaluation-offline-20261027/single run-artifacts/harness-evaluation-offline-20261027/independent
```

离线报告输入由 `tests/unit/software/harness-evaluation.test.ts` 导出，包含刻意构造的取消样本、产品失败和设施失败；时间、请求记录与审计是**离线工程样例**，不是实际模型观测，不能用于论文结果、可靠性或收益推断。prepare 封存的三项正式任务与这个小型记录器样例也不是同一组完成实测。

未来真实绑定使用 `bind PROTOCOL_JSON PROJECT_ID TASK_ID single|independent RUN_ID [AUTHORIZATION_JSON]`。必须在该次制作前配置并绑定隔离项目；CLI 不创建真实用户项目、不修改供应商统计，也不自动启动模型。补充账本/独立审计用 `annotate PROJECT_ID accounting_snapshot|defect_audit|user_intervention ANNOTATION_JSON`；所有证据保存在项目工程外 `PROMA_HOME/harness-evaluation/PROJECT_ID/`。

accounting 注记格式为 `{ "evidence": { "ledger_path": "绝对路径", "ledger_sha256": "原文件哈希", "cost_path": "绝对路径", "cost_sha256": "原文件哈希" } }`。cost 证据需 `source: direct_user_confirmation`、`run_id`、`project_id`、`protocol_digest`、`covered_requests`、`spent_rmb`、`external_changes: false`；不从宿主责任上界推造供应商实际账单。defect_audit 注记为 `{ "evidence": { "path": "绝对路径", "sha256": "原文件哈希" } }`；审计证据需绑定同样的 run/project/protocol，source 为 independent_host_audit 或 human_review，并给出非负整数 missed / false_positives 及相应原始检查说明。离线样例只允许在 offline 模式使用 offline_fixture 来源。

## 当前取舍

保留单模型默认闭环与可选建议，独立持续试用已可用。第二模型功能默认关闭；先用足额的新预算、相同任务/范围/设计和完整失败记录做小样本，再看漏检、误报、设施排障、用户介入和总费用是否改善。最后修好的一例、测试数量增加或多一位模型“认为通过”都不足以证明收益。
