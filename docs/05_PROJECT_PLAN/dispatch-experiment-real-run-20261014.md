# 真实实验预检与执行方案

当前状态：用户已于 2026-10-14 要求暂停，先查清运行问题。只执行了 quick 的 G11/G22/S2，未完成六组；费用、终止与独立 GUI 诊断见 [暂停与故障诊断](dispatch-experiment-diagnosis-20261014.md)。下面的 12/36 样本和三路并发为计划，不是已完成结果。

用户已补充额度并明确 GLM 使用常规 API。2026-10-13/14 本机预检确认官方目录提供 `deepseek-flash`（DeepSeek-V4.1-Flash）及 `glm-5.3`，DeepSeek 预检余额 63.96 元。两个模型均已完成真实工具调用探针；这些探针不是六组产品实验结果。

GLM 账号的 Anthropic 端点返回 Coding Plan 到期错误，常规 OpenAI 端点 `https://open.bigmodel.cn/api/paas/v4/chat/completions` 成功。实验 GLM 渠道类型为 `zhipu`，不使用 `zhipu-coding`。原生传输新增 OpenAI 消息、工具结果、思考历史、按 index 装配工具增量以及缓存用量转换；参考本地 Proma `bf3e98c` 的 `packages/core/src/providers/openai-adapter.ts`，保留 Bloma 原生循环和账本。

DeepSeek 实际模型选择器采用官方目录的 `deepseek-flash`；新的别名沿用 DeepSeek Flash 的思考档位编码，避免未知模型回退为禁思考。D/E 仍按 G11/G12/G21/G22 和 S1/S2 六组绑定，V 固定为 DeepSeek Flash。

## 预算

继续执行每模型本轮合计 50 元上限，准备、预检、辅助请求及 V 全部计入相应模型。`BLOMA_MONETARY_POLICY` 指向全部隔离 home 共用的本地策略；`monetary-budget.ts` 在每次物理 SSE 请求（包括重试）及非流式资格调用前预留费用。跨进程使用独占锁和原子替换共享状态；策略变更、状态损坏、未知模型或缺少输出上限拒绝请求。锁最多等待 2 秒，崩溃残留锁必须人工查证，不自动清除。

预留按完整 1M 上下文与有效输出上限、峰值费率计算；只有完整成功响应的用量可释放多余预留。失败、取消、崩溃及缺失用量保留全额，因此预算账本包含保守预留，不能称为供应商实际账单。峰值费用估计使用 2026-10-13 获取的官方人民币费率（元/百万 token）：

| 模型 | 未缓存输入 | 缓存输入 | 输出 |
|---|---:|---:|---:|
| DeepSeek Flash | 2 | 0.04 | 8 |
| GLM-5.3 常规 API | 8 | 2 | 28 |

来源：[DeepSeek 模型价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)、[智谱 API 定价](https://docs.bigmodel.cn/cn/guide/start/pricing)。实际 DeepSeek 非高峰费用可能低于估计。此守卫覆盖原生模型传输及资格请求；外部账户消费不属于本实验的请求预算。策略和加密凭据留本地，不随输入快照传播；实际运行必须设置同一绝对策略路径。凭据通过 Windows DPAPI 与每 home 的 Electron safeStorage 保存，不进入 Git、产物、日志或公开报告。

## 样本与并发

预检先 quick、longterm 各六组每组 1 次，共 12 个样本；预算允许时补到每组 3 次，共 36 个。一次重复使用新恢复的 home，不能续跑同一样本后挑选结果。首轮每样本最多 1 名实现者；增加实现者资源是后续单独实验。

用户同意多个条件并行：每批最多 3 个条件，六组分两批；重复轮换分组及启动顺序。报告记录 batch、并发度、启动和完成时间。耗时解释为并发负载下表现；速度差异需要另做串行复验，不宣称隔离机器上的耗时。

共同任务为离线桌面待办清单：标题新增/去空格/拒绝空白，完成和取消完成，全部/未完成/已完成筛选，删除，同名任务隔离与重启持久化。普通用户需求不指定实现技术或测试方法。两个模式分别按原生流程准备并停在 Implement 前；longterm 还要选择已完成的骨架交接。共同外部验收在运行前封存，真实操作界面并保存证据，生成模型自己的测试不代替研究 Q。

操作使用 `scripts/dispatch-experiment-native.mjs`、既有 freeze/matrix/report/evaluate/aggregate CLI。原生驾驶只创建及打开隔离项目、发送共同需求/继续消息并操作确认门，不编写生成产物。

## 目前验证

263 文件/2397 单测及 2 文件/8 集成测试通过，typecheck/build 通过；新增最终小调整后费用及协议定向 2 文件/8 例通过。证据在 `run-artifacts/real-experiment-preflight/{unit,integration,build,typecheck,final-regressions}.log`。实际工具探针与官方页面缓存也在该目录。尚无产品六组的评分与统计结论；原生准备和矩阵执行以各 home 事件及后续报告为准。
