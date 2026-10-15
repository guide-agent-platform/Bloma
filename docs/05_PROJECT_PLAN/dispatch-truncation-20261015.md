# L3 截断分支审计与 640000 请求上限

用户先要求维持 GLM 本轮累计 50 元、完成校准与 L3，六组暂不开跑；随后明确要求输出请求上限给到 640000。DS 原累计 50 元和 GLM 新轮累计 50 元均不改变。

## 数据与旧值来源

8192 是本轮实验试运行的资源配置，不是经过 L3 校准的充分预算，也不是供应商推荐值。`main/platform/llm/model-resolution.ts` 早已记录过 16384 思考耗尽的历史问题，并将生成默认设为 640000；本轮为控成本压低输出上限，未充分考虑这一已知风险。

首轮 L3，run=`l3-method-S1-20261015-r1`，有4次响应的已报告 output_tokens=8192，正文与工具调用均为零。查询 ID：

- `f263f291-8321-46ff-8af7-32e82b89c739`
- `e7be785b-1661-431b-873f-94b84a457f77`
- `e2b24467-643f-43d4-aabc-df2e579086a0`
- `e4acffb7-b794-4d9e-b136-60874eb44c1a`

原始 `native/main.log` 的 thinking_delta 是 SSE 事件条数，不是 token 数；结论使用账本 output_tokens 与无正文/工具的记录交叉核对。旧账本没有保存 stop_reason，不能事后补造为明确 max_tokens。实测符合输出预算耗尽形态；旧 loop 对明确 max_tokens 也会返回 completed 的缺陷已由确定性测试复现。

官方[思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)区分思考强度与输出限制；[当前规格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)给的是模型最大能力，不证明某个更小的预算足够。思考模式中 temperature 被忽略，因此实验记录的0.1是请求值，不声称服务端实际采用该采样温度。

## 已修正的三处接线

1. 无工具且收到 max_tokens 不再作为完成。保留真实输出与用量，至多两次反馈续接，仍受原 maxTurns 和输出上限约束；不重放空 assistant、不执行残缺文本中的工具意图。持续截断返回 turn_limit/output_token_limit，实验终态为 EXPERIMENT_OUTPUT_BUDGET_EXHAUSTED。
2. 原生 gate-exhausted 的暂停边界结束为失败实验，不再等驾驶脚本30分钟超时才取到终态；功能 Q 独立保留未知。首次终态不可被后续 delivered 覆盖。
3. 640000 联动到实验默认、宿主上限、冻结 limits 和渠道 seed；run seed 读取本次冻结资源，不再把渠道暗中重置为8192。真实 seed 无模型调用验证：DS=640000、GLM常规=131072。GLM-5.3 官方[规格](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)是128K输出，传输出口保留该约束；本轮不调用GLM。DS按640000声明请求，不承诺服务端必定输出到此长度。

账本新增 stop_reason，区分HTTP/传输正常结束、用量完整和业务任务完成，三者不能混同。人民币预留仍按每个实际物理请求体计算，不把token配置当成充值或增加累计预算。

首轮由 Codex 在 no-marks/gate-exhausted 后中断并封存，reason=THINKING_TRUNCATION_COMPLETION_AUDIT，质量未知、不纳入模型能力比较。`run-artifacts/full-experiment-20261015/l3/archive-interrupted-manifest.json` 对38个文件保存哈希。

下一轮使用同一准备 home 的原 PRD/UX/起点文件，在新目录恢复。平台版本和输出条件同时改变，必须分别报告，不能声称是严格同条件复跑或单独识别某项修复的效果。CLI快照的input_hash包含runtime_hash，因此业务输入文件哈希相同时，跨构建的input_hash仍会改变。

验证：构建固定后全量271文件/2471项通过；集成2文件/8项通过；相关五文件193项通过；typecheck/build、原生加密渠道seed及驾驶参数回归通过。测试证明代码分支与配置接线，不替代下一轮真实模型产物验收。
