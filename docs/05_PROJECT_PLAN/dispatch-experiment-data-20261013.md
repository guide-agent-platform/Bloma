# 不同模型实验的数据采集与验收

本批补齐固定验收、运行终止记录、按模型用量和六组配对汇总。验证使用假 SDK、真实临时文件及本地验收进程；没有调用收费模型，没有真实效果数据。

当前用户确定 M1 为 DeepSeek Flash、M2 为 GLM 5.3，固定验证模型 V 为 DeepSeek Flash。每个模型本轮总预算 50 元，V 的调用计入 DeepSeek Flash 预算。GLM 额度待用户处理。这里记录的是实验意向，实际通道/模型 ID、供应商费率和费用守卫需在真实运行前核对；当前 Token 统计不是金额，也没有新增人民币硬限额机制。

## 固定验收

每个原始任务先定义外部验收目录，其中 suite.json 与脚本在 matrix/restore 时复制到每份 home 的 dispatch-experiments/evaluator。所有文件一起计算 evaluator_hash，进入 condition_hash；Implement/Verify 模型调用前、验收前后都会核对。脚本不放进生成产物目录，不使用生成模型自己编写的测试作为最终研究评分。

这复用现有快照哈希、原生结束边界与 request-ledger；用量缓存分类参考本地上游 Proma bf3e98ca61dd8365eceaef876c0f7473700878a6 的 agent-session-usage.ts，适配为逐请求合计与完整性检查，没有照搬“末次上下文占用”作为总费用。

suite.json 示例（业务断言必须针对实际任务编写，此处只说明接口）：

```json
{
  "version": 1,
  "checks": [
    {
      "id": "business-behavior",
      "description": "按冻结需求检查业务行为",
      "kind": "command",
      "command": "python",
      "args": ["{suite}/check_behavior.py", "{product}"],
      "timeout_ms": 30000
    },
    {
      "id": "gui-flow",
      "description": "独立操作关键界面流程并保存证据",
      "kind": "manual"
    }
  ]
}
```

命令由宿主以 shell=false 执行，exit 0 通过，普通非零退出失败；缺失可执行程序、进程超时等验收器错误标为 error，不能冒充模型失败。单项超时最多 60 秒、输出最多 1 MiB；这不保证自动清理脚本自己启动的全部后代进程，脚本必须负责清理 GUI/服务，不能遗留后台任务。固定解释器与依赖版本另作为实验环境记录；suite_hash 并不封存 PATH 中的二进制版本。

每项同权重，全部项目有 passed/failed 才生成 Q=通过项数/项目数及 success=是否全通过；manual pending 或 harness error 时 Q/success 为 null。exit-code 检查脚本必须实现断言，不能只打印“通过”；真实任务验收需覆盖输入、状态变化、持久化和错误路径，不能把能启动当作业务完整正确。

自动验收日志与人工证据分别保留路径和字节哈希。第一次验收后，只能补齐未判定的人工项目，不能替换结果或重新执行自动项目来挑选较好的结果。生成源文件/证据/验收器变动后，report 会使已记录质量失效。脚本应使用外部临时数据，APP_DATA_DIR 指向验收输出目录；产物哈希排除 .venv、node_modules、git 与缓存。人工界面操作产生的数据也应在外部目录，避免修改评分所绑定的源文件。这里是应用协议与哈希核验，不是进程级安全沙箱。

人工证据格式：

```json
[{"id":"gui-flow","passed":true,"evidence":"C:/experiment-evidence/T1-r1-G12-gui.json"}]
```

证据须来自实际操作，不能为了填齐字段推断通过。人工项目可以由 agent 执行独立 GUI 测试并记录，无法观察的主观评价继续保持 pending。

## 结束与时间

开始覆盖 Implement 前的模型绑定和输入检查。模型循环异常、取消、共享期限耗尽自动落 run_finished；原生 mvp_ready/delivered 落首次 ready 终止记录。machine_ms 是开始到首次机器终止的墙钟时长，因此失败/超时也有值；time_to_ready_ms 仅记录真正到就绪的时间，两个指标不能混用。

同一个结束 run 不允许再次进入 Implement/Verify；修复后重测需 restore 新 run，并保留原样本。首次计划后的自主修复与原生自动修复仍可在终止前发生。人工确认交付不再调用实现模型，仍可以更新 delivered 事件。

阶段事件记录 phase/status/loop_status/duration_ms，原生阶段状态仍保留。human_wait_ms 只在 MVP 到确认间没有机器阶段重启时给值；mvp_review_span_ms 是整个审核区间，不能把含修复的区间称为纯等待。

系统被杀、崩溃或原生尾链停在阻塞状态时，不会凭空产生结束事件。确认进程停止后用 finish 明确记录 interrupted/failed/cancelled/timeout 与原因；没有开始时间的未启动运行耗时仍为 null。未结束记录始终保留，不自动按时间推断模型失败。

## 内部操作

先构建并按上一份文档 prepare/freeze 原生项目；验收目录必须先于真实运行封存。

```powershell
node scripts/dispatch-experiment.mjs matrix --snapshot <快照目录> --home <新矩阵目录> --models <模型对JSON> --run-prefix T1-r1 --task T1 --repeat r1 --evaluator <验收目录> --worker-limit 1
# 六份 home 分别配置原生渠道并运行；matrix 本身不会开始模型调用。
node scripts/dispatch-experiment.mjs evaluate --home <组home> --project <项目ID>
# 有人工项时，先独立执行并保存证据，再补齐：
node scripts/dispatch-experiment.mjs evaluate --home <组home> --project <项目ID> --manual <人工证据JSON>
node scripts/dispatch-experiment.mjs report --home <组home> --project <项目ID> --out <新报告JSON>
# 外部中断时，确认进程已停止后补结束记录：
node scripts/dispatch-experiment.mjs finish --home <组home> --project <项目ID> --outcome interrupted --reason process_crash
```

matrices.json 为各个矩阵清单文件的绝对路径数组，例如 ["C:/experiments/T1-r1/matrix.json"]：

```powershell
node scripts/dispatch-experiment.mjs aggregate --home <实验目录> --matrices <matrices.json> --out <新汇总JSON> --csv <新结果CSV>
```

JSON 包含完整逐运行结果、待完整配对及分层指标；CSV 一次运行一行，未知值为空。文件采用 wx，已有报告不会被覆盖。旧矩阵没有 sample/evaluator 元数据时仍可 report，但不能伪补身份进入本批配对统计。

## 配对与用量

sample 记录 task_id/repeat_id/pair_id/group，进入条件指纹。配对要求六组齐全、共同输入/验收器/平台/预算/采样/V 一致，且 D/E 的绑定符合 G11/G12/G21/G22/S1/S2；同一 task 的重复实验不得悄悄替换输入或验收器。quick 与 longterm 分层，不同实现者资源限额另行汇总，不混入一个均值。重复运行编号/重复轮次或指纹不一致直接拒绝。

所有失败运行保留并按同一验收器评分；只有完整六组且质量证据有效的配对进入指标，其他配对列出 pending，不静默删除。外部崩溃可能留下未结束请求，最终质量仍可评分，用量必须保持不完整标记。

- D：S1 成功率减 S2 成功率，保留符号，避免事先假定谁更强。
- R：S1 失败时 S2 成功的比例，同时给反方向和失败分母；分母 0 时 value=null。
- G：G12−G11、G21−G22 的平均质量差，并比较混合组与两个同构组中总体平均质量较好的组。只有描述性配对统计，没有因果/显著性结论；小样本多次重复不能当作独立任务数量。

请求账本增加 by_model（实际 endpoint_host/model、输入输出与两类缓存、缺失用量数）；支持按 run_id 和显式 home 读取。report 同时保留 project_usage（含该 home 的其他探针/辅助请求）与 run_usage（被绑定实验 run 的 SDK 请求），防止只看 SDK 预算漏掉额外请求。缺失/失败尝试未知成本继续显式报告，完整性不足时不计算 Token 均值。金额需实际供应商费率和账单校准，不能把跨模型 Token 均值当作费用。

准备阶段在来源 home 中记账，与实现/验证成本分开保存；snapshot 不复制旧账本，不能据此宣称准备免费。下一步为通道、费率和额度预检，固定任务验收，再做小样本真实运行；目前尚未开始真实模型实验。

## 本次验证

2026-10-13：全量单测 259 文件/2375 例通过（run-artifacts/data-collection-unit.log）；最后补充每次 SDK 请求的验收器检查、产物不可被验收器修改后，相关 3 文件/51 例通过（data-collection-final-regressions.log，包含新加的第 2376 例，不与全量相加）。原生调度/路由 2 文件/74 例补充回归通过（data-collection-native-regressions.log）。集成 2 文件/8 例、typecheck 和完整构建通过（data-collection-integration.log、data-collection-typecheck.log、data-collection-build.log）。

验证覆盖实际外部子进程评分、六份真实隔离快照/验收器/汇总 CLI/CSV、失败耗时和终止不可复用、人工证据补齐与不可替换、证据/验收器/产物变动拒绝、验收器故障保持未知、配对条件漂移与重复样本拒绝、D/R/G 的已知样本计算和无失败分母，以及按模型/缓存/run 的账本划分。模型部分仍为假 SDK；不能把这些结果当作真实模型性能或费用数据。
