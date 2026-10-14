# 底层工具调用与反馈对照审查

后续修复状态见 [工具事实与恢复协议重构](tool-feedback-repair-20261014.md)。下面保留修复前的审计及当时证据；不能将这些历史结论当作当前实现状态。付费实验仍暂停。

2026-10-14 用户要求暂停付费实验，重新检查底层工具调用与反馈，并多对照上游。当前只做离线审查；没有活动模型请求或费用预留，不自动恢复运行。可靠性闸门尚未通过。

## 核对版本与实测范围

- 本地 Proma 上游：`bf3e98ca61dd8365eceaef876c0f7473700878a6`，工作树干净。本报告对照该本地版本，不声称它是远端最新提交。
- 新 G22 冒烟实际运行代码：`c150895`，冻结 bundle SHA256 `860efb277a740995e982a8fafcc24dc47af388ad693eceef4fb9f58f0e4ad810`。后续等待模块拆分 `1e8dd15` 未混入该运行。
- 新 G22 在暂停消息前已结束：99 次逻辑/物理 HTTP 请求，用量记录完整、无 API 错误；原生终止 `EXPERIMENT_TASKS_NOT_COMPLETED`，独立 GUI 六项通过。它是诊断数据，不并入正式配对。
- 全量单测最终 265 文件/2422 例通过，集成 2 文件/8 例通过，类型检查通过。先前 800 行架构限制失败已通过模块拆分解决。权限拒绝文本补丁另有 2 文件/23 例和类型检查验证，尚未在本次冒烟中使用。
- DeepSeek/GLM 真实协议资格验证三项通过；额外 GLM thinking-off 拒绝保留，API 返回 400/1210。正式样本与原生冒烟使用 low；资格验证中的 DeepSeek 空历史测试使用 off，不能混作能力样本。

## 上游路径与本地适配差异

| 边界 | Proma bf3e98c | Bloma 当前路径 | 审查结论 |
|---|---|---|---|
| 协作返回内容 | `apps/electron/src/main/lib/agent-collaboration-tools.ts` 的 `piJsonResult` 把完整 payload 同时放入 `content.text` 与 `details` | `main/agent/delegation/delegation-tools.ts` 手工格式化正文，detail 不进入模型历史 | 字段可能在适配时丢失；pending_question 的正文漏传已复现并修复，不应无选择地转发含凭据或超长对象 |
| 模型实际收到什么 | SDK tool content 是模型可见结果 | `main/agent/loop/agent-loop.ts` 的 `executeTurnToolCalls` 仅把 feedback 前缀和 outcome.output 回填 tool_result；detail 主要供事件/UI | 必须沿实际 tool_result 检查，不能看 UI detail 就宣称模型看到了完整信息 |
| 输入校验 | `agent-tool-input-validator.ts` 对已知工具必需参数拒绝 undefined/null/空串 | `tool-input-validation.ts` 验类型、required、enum 和嵌套结构，但不验空字符串或 minLength | 空文件路径当前通过公共校验；可在真正执行/计数后才报错。应按具体字段加约束，不能照搬上游把合法空文件内容也禁掉 |
| 等待 | 上游 `waitForLiveRecords` 清理 timeout，返回完成/超时结构化状态与计数 | 本地加了子会话提问信号，最新 `delegation-wait.ts` 支持父取消并清理 timer/listener | 清理已对齐并保留本地更强的取消链路；提问提前返回需给模型明确 next action，不能谎报任务完成 |
| 终端/脚本执行 | `adapters/pi-builtin-tools.ts` 的 TerminalExecute/TerminalRead 返回执行事实、terminalId、输出等 JSON；不把通用进程退出码直接称为产品业务验收 | `child-exec-tool.ts` 对通用 Python 执行复用 `process-driver.ts` 契约退出码规则 | 当前把“执行失败”和“业务断言失败”混在一起，真实日志已证明误分类 |
| 本地执行额度 | 上游通用执行/协作接口与本平台的桌面脚本配额不是同一机制 | `project-attempts.ts` 持久化 session 脚本次数；child runner 默认 12 次，续接不清零 | 本地新增约束必须显式标注 scope/reset/remaining，不能靠泛化 resume 反馈驱动；不应借对照上游删除 RMB 上限或独立验收 |
| 权限拒绝 | 上游校验/权限返回描述性 deny message，引导修正具体调用 | 实验 write guard 拒绝越界路径；中央 feedback 默认把 isError 归为 failed/unknown | 没有写文件却描述为“执行失败”，丢掉 permission/not_run 事实；文本补丁已增加被拒路径/可写范围，但机器分类仍待修 |
| 结束语义 | 协作 status 与结构化摘要分别报告 | 本地生命周期 completed、loop_status、task_handoff 和产品评分多层并存 | 分层本身正确；不能把生命周期结束当业务通过，也不能把所有 incomplete 都当“还可以继续” |

## 已复现的优先问题

### P0：永久额度耗尽仍指示 resume

`main/agent/loop/tool-feedback.ts` 直接把 `outcome.budgetExhausted` 映射成 `category=budget, recovery=resume`。委派行只要 loop_status 是 budget_exhausted，也再次统一映射 resume。正文却说“本任务累计执行额度已用尽，续接不会清零”。这是宿主提供的冲突指令，不能归结为模型没有听提示词。

本次执行账本显示同一子会话脚本额度已用 12/12，日志里三条预算反馈都带 resume。离线纯函数反例对这两条路径分别复现；没有模型调用。

修复应先给预算事实增加明确作用域与重置条件，区分“本轮调用限额”“持久 session 执行额度”“整段实验请求上限”和“模型 RMB 上限”。不可恢复额度耗尽时保存未完成项并终止；能恢复的情况才允许相应恢复动作。不能单凭 budget_exhausted 字符串一刀切所有情况，也不能用重新创建子会话绕过固定资源条件。

### P0：脚本错误被称为产品断言失败

本次一段构造场景声明的 Python 短代码在列表解析里抛 `IndexError`，stdout 为空、没有任何 PASS/FAIL 断言。child runner 仍因退出码 1 得到 `verification_status=fail`；中央反馈于是给出 `verification=failed, category=product_assertion, recovery=repair_product`。

离线反例进一步用“无场景、退出码 1、ModuleNotFoundError”复现相同结果。脚本本身出错不能证明产品业务错了。需要区别未启动、启动/执行失败、验收脚本错误和读回真实 FAIL 场景；没有有效断言时保持业务验证 unverified。真正包含 FAIL 场景的结果仍应保留，不能因为独立 GUI 最终通过就撤掉当时失败。

### P1：权限拒绝事实与恢复动作丢失

对已登记范围外的 write_file，操作未执行，但 feedback 被默认归到 execution=failed、category=unknown、recovery=inspect。文本中的权限事实没有进入机器字段。应带 permission/not_run 和稳定拒因、可写范围；恢复应选择已有授权文件/目录，不鼓励为已锁定计划临时扩权。

另外，实验范围包装只拦直接 write_file/edit_file。run_project_script 的 Python 副作用没有同等文件范围 enforcement。本报告按代码确认这个覆盖边界，没有声称本次模型已通过脚本越界写文件。后续需单独选择文件副作用审计或更强隔离；不能宣称目前已有操作系统级写隔离。

### P1：资源上限不完整可见

模型轮数、工具次数、执行次数和人民币余额是不同资源。当前报告公开 D/E 轮数等 ExperimentLimits，但默认脚本执行 12 次及持久计数并未成为同等显式条件。续接时还会保留该计数，不能让模型或研究者以为“换一段就恢复了全部额度”。应在冻结条件、工具回执、委派摘要和终止原因中一致说明，记录实际阶段重试次数。

新 GLM 独立账本保留旧账；DeepSeek 连续性是复制原条目至新操作账本，旧入口并未由底层失效机制关闭。本轮旧账 SHA 未变、无并发旧 runner，未发现重复消费；但跨两个有效策略路径的全局资金约束仍依赖只用新入口。后续应有唯一活动 epoch/写入口或共享每模型状态，不能把这种操作约定当成已实现的全局预算锁。

### P1：空路径的前置拒绝

`read_file {path:""}` 通过公共结构校验，而上游对应 Read 参数校验会拒绝空 file_path。本地应对路径等非空语义字段在执行前拒绝，并区分 content="" 等合法空值。结构性校验正确拒绝后才可声明“未执行、不消耗工具预算”。

## 已修与仍未验证

已修：空 assistant 历史的传输过滤；待回答问题的模型正文；等待取消与计时器清理；首次派遣前必需交付文件权限覆盖；STOP/timeout 必需参数；预算/HTTP 错误不再误记为空流；GLM-5.3 unsupported thinking-off 在 HTTP 前拒绝。上述不能替代本报告仍待修的恢复方向、失败分类、资源作用域与文件副作用边界。

当前可靠性状态是“离线回归与协议资格验证通过，完整调度交付冒烟失败”。不继续付费重试，不启动复杂任务比较。先统一工具反馈事实，再做零模型的反例回归；重新开展真实验证需要用户明确恢复实验。

## 保存证据

- `run-artifacts/reliability-20261014/tool-feedback-counterexamples.json`：五个离线反例的真实宿主函数返回，零模型请求。
- `native-feedback-evidence.json`：本次实际子会话预算与脚本异常回执。
- `native-smoke/report.json`、`native-smoke/gui/gui.json`：完整原生结果与独立功能验收。
- `native-smoke/archive/`、`archive-manifest.json`：原始会话、请求账本、执行计数、生成源码及校验哈希；不包含渠道凭据或虚拟环境。
- `PAUSED.json`：零活动模型请求/预留、用户暂停、不自动恢复。GLM 新轮已报告峰值估算 9.016836 元，DeepSeek 本阶段新增峰值估算 0.000062 元；供应商实际账单另算。旧账未改。

难度任务设计保留在 `experiments/dispatch-difficulty-v1` 和 [难度分档稿](dispatch-difficulty-20261014.md)，仅是设计候选，L2/L3 驱动尚未实现/校准，不等于已经执行了三个档位实验。
