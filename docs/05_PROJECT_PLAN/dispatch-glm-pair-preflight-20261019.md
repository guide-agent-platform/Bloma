# GLM 5.3 Flash / GLM 5.3 并行预实验

用户于2026-10-19改定 M1=`glm-5.3-flash`、M2=`glm-5.3`，共同验证 V 继续为 `deepseek-flash`。M1/M2 共用原有 GLM Coding Plan 账号与 `zhipu-coding` 通路。旧 DeepSeek/GLM 配对作为历史记录保存，不混入新配对。

## 当前进度

新配对传输资格通过，修复后的运行时已构建；有效版本为 v4，六组最终环境与原生界面核验全部通过，起跑前执行调用均为0，现已由真实界面启动 G11。v3 因新增渠道误把显示名作为上游型号，在首个请求即失败，已保留并修正，不混入 v4。

共同业务起点为本轮新做的完整 quick 原生流程：新请求、澄清、需求确认、PRD 审阅确认、草图生成/改稿/确认。保持已确认的11功能、23规则、41场景与最终草图，不因替换执行模型重写需求。没有拿旧实验 PRD/UX 代替这轮准备。准备阶段模型使用及失败记录独立核算，详见上一份起跑报告。

| 组 | D | E（最多两名） | V |
| --- | --- | --- | --- |
| G11 | GLM 5.3 Flash | GLM 5.3 Flash | DeepSeek Flash |
| G12 | GLM 5.3 Flash | GLM 5.3 | DeepSeek Flash |
| G21 | GLM 5.3 | GLM 5.3 Flash | DeepSeek Flash |
| G22 | GLM 5.3 | GLM 5.3 | DeepSeek Flash |
| S1 | 无 | GLM 5.3 Flash，直接实现 | DeepSeek Flash |
| S2 | 无 | GLM 5.3，直接实现 | DeepSeek Flash |

该配对用于检验能力差异及调度效果，尚不能断言本任务上的能力差距。两模型均固定 high、temperature=0.1。用户取消金额上限，调用使用明确 unlimited 标记；运行保护与计量继续记录，不作金额控制。

## 通路与推理参数

[官方说明](https://docs.z.ai/guides/vlm/glm-5.3-flash)确认精确 ID=`glm-5.3-flash`、支持 Coding Plan、128K输出、强制思考以及 low/high/max 深度。Bloma 此前只识别 `glm-5.3`，未知模型兼容分支会发送 disabled；已为 Flash 新增精确适配，high 发 enabled+output_config.effort=high，显式 off 在发 HTTP 前明确拒绝，400 不删除必要参数后静默降级。其余旧模型行为保留。全局默认策略留待实验后单独讨论。

已在同一 Coding Plan 账号真实测试四种三路组合：全 Flash、Flash+两完整版、完整版+两 Flash、全完整版。12条两轮工具会话、24次物理请求全部成功，每组物理峰值3；请求守卫核验精确模型与 Flash high 参数。传输成功只作为容量资格，不能代替真实子 agent 派遣与产品验收。

证据：`C:\Users\17359\AppData\Local\Bloma\parallel-native-quick-20261018\transport-glm-pair-v3\preflight.json`。未取得 Coding Plan 精确余额，不把可用性探针当余额查询。

## 平台修复与新起点

上一版 v2 G11 已出现两执行会话物理重叠，但 worker 状态保存遇 Windows 原子替换 EPERM。监督者停止本组，150次逻辑/物理调用全部收尾，Q=null；其他五组未启动。原始异常和用量保留于 `infrastructure-incident-v2.json`，未人工补齐业务后冒充模型产物。

修复复用文件系统退避（50/100/200/400ms）：短暂占用释放后原子替换，耗尽后保留旧文件并清理临时文件。另一 Windows 进程实际持有不给 Delete 共享的文件句柄，已复现原生 rename 失败并验证修复成功；永久锁和 POSIX权限拒绝分别验证，未直接覆盖旧文件。atomic/helper13项、dispatch64项检查通过；Flash相关69项、seed/native9项通过，类型检查与构建通过。

v3 的 G11 首请求实际发送了 seed 的显示名 `GLM 5.3 Flash`，上游400/1211“模型不存在”。这是监督者新增渠道配置错误，非模型任务失败。1个逻辑/物理请求已收尾，无usage，未知用量不记零；其他五组未启动。修正 seed 的 model.name=`glm-5.3-flash`，测试加入精确断言，起跑核验增加 D/E/V 的实际上游 selector 与指定model_id逐项相等。样本保留于 `infrastructure-incident-v3.json`，没有覆盖报告后重跑。

新运行时独立工作目录：`C:\Users\17359\.codex\worktrees\parallel-pilot-runtime\guide-agent-platform-sprint0`。

| 封存项 | 值 |
| --- | --- |
| 运行时提交 | `48fcef096907d8a563b78a6338a5a4346ad9c51f` |
| 主包 SHA256 | `108e342d8158b1e458a352212b9a9b5bf54935aedb876b2f054fa60dee9d0194` |
| 新输入 SHA256 | `15d2d440144e952a9cdfe40f270d362a5d63db813b6197b55b9587926cc8b55c` |
| 新 cohort | `C:\Users\17359\bex-q18\pilot-v4` |
| 验收 SHA256 | `ed92ad56a86dca68652509e282ccc7429bfa367b4d00d25e1fa5c22700df2d2a` |

新输入哈希含当前运行与实验准备元数据；源 PRD/UX/环境契约的业务文件逐项比对不变。六组独立 .venv 使用同一解释器与离线精确依赖，保护 `00_ENV` 与已确认材料；跨组并发1。D60/E100回合、256逻辑请求、宿主输出640000、M1/M2出口131072（V出口393216）、墙钟60分钟、脚本64次/安装8次等运行保护保持一致；直接基线无 D。

外部14项业务验收已封存。实际 worker 数、物理重叠、协议拒绝、用量、原生终态和独立 Q 分开记录。Q 未完成记 null，不以内部自测或通路探针推断质量；此次为可行性预实验，不能用历史单 worker 样本作并行收益的因果基线。

当前起跑证据：证据根下 `readiness-v4.json`、`platform-v4-ready.json`、`env-v4/{group}/report.json`；本机 cohort 的 `readiness-release.json` 记录94个运行文件与4个驱动文件哈希，并逐项记录 D/E/V 精确上游型号。`pilot-v4-runs/G11/launch-receipt.json` 为实际启动收据，`observation.json` 为进行中观测，不是已完成的交付或独立业务验收。资格截图对空草稿 revision 的影响留档后恢复，不删改会话历史。
