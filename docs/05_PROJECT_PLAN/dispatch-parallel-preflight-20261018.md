# 多实现者并行预实验：链路核对与启动登记

核对日期：2026-10-18，Asia/Shanghai。源码基线为 sprint2 / 8040678 加本次已验证改动；运行包和冻结输入的精确哈希见本机 registry.json。本轮与 10 月 17 日截止报告分开记录。

## 当前授权与模型

用户要求恢复 Flash/GLM 实验，将同组单实现者改为多子 agent 并行，并于本轮明确表示“现在不设限额，想怎么用怎么用”。据此取消新运行的人民币费用上限，保留请求用量、失败样本和旧费用责任。不会把旧 reserved/unknown 改为零。请求数、轮次和墙钟上限仍是实验资源条件与结束规则，不称为金额预算。

- M1 / V：`deepseek-flash`。官方 2026-10-17 更新说明对应 DeepSeek-V4.1-Flash-1017；实时模型目录返回该 selector、1,048,576 上下文、393,216 最大输出，目录名称本身未携带 1017 版本号。
- M2：`glm-5.3`，本轮密钥为 Coding Plan，使用 `zhipu-coding` / `https://open.bigmodel.cn/api/anthropic`，实际请求 `/api/anthropic/v1/messages`。不回退常规 API。
- 两项新密钥仅存于本机 LOCALAPPDATA 下 DPAPI 凭据文件；渠道通过 Electron safeStorage 加密。快照、报告、Git 不包含明文凭据。

官方依据：[DeepSeek 更新日志](https://api-docs.deepseek.com/zh-cn/updates/)、[模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)、[GLM Coding Plan 接入端点](https://docs.bigmodel.cn/cn/coding-plan/quick-start)。Coding Plan 的实时剩余配额和长期持续吞吐尚未读取；成功的小请求不能代替这两项证据。

## 复盘与本次修复

10 月 17 日报告明确：此前同组 worker 数为 1；跨组并发不等于同组多 agent 协作。旧 Flash/Pro 及 Flash/GLM 数据均保留，不与新版模型、Coding Plan 和双 worker 条件混算。

1. **渠道类型**：旧 seed 脚本硬编码常规 GLM API。新增 `--glm-plan coding`，默认 regular 保持历史重放；未知值立即拒绝。
2. **启动容量**：matrix 默认 `--worker-limit 1`，本轮必须显式指定 `2`。G 组续跑指令要求两名实现者协作，任务分解、写范围、依赖、集成和修复仍由调度模型决定。
3. **并发证据**：delegate_agent 后台启动独立 child loop；推理可并发。同项目文件修改、脚本与安装经过项目写 lease，写阶段串行。实验写范围与依赖约束继续生效。
4. **隔离范围**：活动 home、账本、报告均在 LOCALAPPDATA，避免旧 OneDrive 写入故障。组间串行；worker 共用项目目录、按声明写范围约束；worktree 隔离关闭。发现 worktree 失败可降格共享目录、非取消结果可能触发合并，未把该路径当作本轮已验证能力。
5. **预算恢复**：受限探针在用户取消金额上限之前复用了历史责任。GLM 探针短输入经过请求体字节硬门，可用较小上下文预留；其常规费率只是保守代理，不是套餐账单。首次清理因旧 Pro reserved 被全模型激活检查阻挡；新增按模型恢复并完成无收费恢复，旧责任不变。原始错误也保存在报告中。
6. **门禁反馈**：旧 G11 曾因 66 个 CORE_CHECK 场景超过 64 上限而未得到具体原因。本轮明确返回场景数量和上限，未放宽验收标准。

## 已取得证据

真实传输探针调用平台 providers、流式解析与请求账本；每个模型同时启动两个短工具会话，各执行工具调用和工具结果回填。共 **8 次物理请求**，4 条工具往返全部完成，两模型的 `transport_started → transport_finished` 实际请求重叠峰值均为 **2**。探针不是调度模型自主分解或产品质量实验。

离线回归通过真实 dispatcher → delegate_agent → 两个 child loop，使用 fake SDK barrier 证明重叠，同时验证分离文件落盘、固定 executor 模型、共享逻辑计数和收尾。运行中的写范围冲突、未完成依赖会拒绝派遣，等待后可恢复。

这两类证据分别证明传输与本地协作控制流；完整模型自主调度仍需下面的原生试运行证明。

## 新样本与启动条件

最初准备的旧快照 cohort 仅作基础设施探针。用户进一步明确要求从提出需求走完整原生前序，并选择 quick：因此已取消旧快照 G11，73 次查询全部收尾，原生 cancelled / Q=null；其余五组未启动。旧 cohort 已标记退役，不纳入本轮产品比较。观察期间只启动一名 worker，依赖等待未释放，不能宣称该试跑实现了双 worker 并行。

现行方案：全新项目 `255dbbdf-6621-43b9-9b96-6de37efc6446`，从 L2 原始自然语言需求开始，经 Bloma 原生需求清单、PRD 内审/修订与确认、UX 生成/选择与确认，到 Implement 前停点。监督者逐项核对落盘内容，通过原生对话和修改池修订语义，不直接覆写业务背板或补业务实现。确认门需本机监督审阅记录，不能由驾驶脚本盲目点击。

本次已通过原生补充补齐稳定 ID 合并、任意冲突整份拒绝、幂等与失败不变，并通过 PRD 原生修改池退回一条无前提依据的固定计数场景。公共平台骨架使用现有 provisionDesktopSkeletonV2 物化；环境使用 buildInstallPackagesTool 安装并核验，未实现业务。冻结新输入后，各组从同一来源恢复，不使用旧草图或旧 PRD 代替本次流程。

| 组 | 调度器 | 实现者 | worker 条件 |
| --- | --- | --- | --- |
| G11 | Flash | Flash | 两名实现者协作 |
| G12 | Flash | GLM Coding Plan | 两名实现者协作 |
| G21 | GLM Coding Plan | Flash | 两名实现者协作 |
| G22 | GLM Coding Plan | GLM Coding Plan | 两名实现者协作 |
| S1 | 无 | Flash | 直接实现 |
| S2 | 无 | GLM Coding Plan | 直接实现 |

固定 V=Flash、high、temperature=0.1、宿主输出 640000；出口 DS 393216 / GLM 131072。D60/E100、256 次逻辑请求、每组 60 分钟、最多 16 项登记任务；脚本/安装沿用冻结条件。跨组并发 1。该设计是可行性预实验，若后续研究并行本身的收益，需在相同新版本下另跑 worker=1 对照，不能用旧单 worker 结果作因果基线。

先逐组检查，不在发现平台异常时自动启动下一组。每组需分别报告：实际 worker 数、实际 HTTP 重叠、计划/写范围拒绝、请求及 token、首次机器终态、原生交付和独立 Q。Q 未完成时保留 null。两名 worker 存在但推理没有重叠，应记录协议未实现并行，不算并行成功。

退役材料位于 `C:/Users/17359/AppData/Local/Bloma/parallel-preflight-20261018/pilot-r2/`。初次离线准备的角色绑定格式错误保留于 pilot/，均不删除。新原生流程及环境材料位于 `C:/Users/17359/AppData/Local/Bloma/parallel-native-quick-20261018/`；准备调用单列，不算执行样本，也不称为免费前置。

原生启动需显式 `--no-monetary-limit --glm-plan coding --credentials <DPAPI 文件>`；不指定金额模式或同时指定 policy 会拒绝启动。新原生准备还开启 `--review-preparation`。费用开关同时覆盖实验中的 UX 辅助操作，防止空 policy 再回退旧金额策略；只在实验模式与显式 unlimited 标记同时存在时生效，普通操作不变。请求数量、输出长度和阶段超时仍保留并记录，不能称这些限制为金额控制。

公共环境先在新 source 装配，保存解释器 SHA256、Python 版本/架构、全部依赖精确版本及离线 wheel。六组各自新建 .venv，使用同一 wheelhouse 和 pins 重建，比较规范化依赖清单哈希；不复制含绝对路径的 venv，不要求包含路径/mtime 的组内 freshness 指纹相等。平台资产和已确认 PRD/UX 的文件内容哈希另行逐项匹配。

实际环境检查还发现长路径故障：Codex 沙箱会把 LOCALAPPDATA 路径扩展到包缓存目录，长项目路径上的 WebView2 .NET DLL 无法加载。长路径失败原报告保留；短根 `C:/Users/17359/bex-q18/env-probe` 中同版本依赖的真实窗口启动、DOM 与 Edge 用户代理回读通过，进程按所属 PID 子树清理。正式六组改用短根目录，不能只靠 import 成功称 GUI 环境就绪。

准备阶段曾使用 16384 输出，账本确认多笔 PRD 修订 `stop_reason=max_tokens` 且 output_tokens=16384，随后 JSON 解析失败。已保留这些尝试，恢复宿主 640000，并修复请求预算对旧辅助 cap 的误拒；普通非实验操作不变。监督者停止、语义补充及续接均保留原生记录，不把监督者写 STOP 标记的行为归为模型自然失败。旧驾驶报告中的 user-stopped 是历史程序标签，实际操作者为 Codex 监督者。

输出修正后的 PRD 原生修订请求已产生 25556 token 的完整工具调用，随后完成修订与复核，最终 PRD 在 14:05:25（Asia/Shanghai）通过原生确认：11 功能、41 场景；主体仍为离线任务管理。额外澄清为启动后的可见内容、过期筛选开关语义，以及已记录的项目名/引用有效性规则。

首轮 UX 两个 HTML 候选因功能/场景类型关联错误均未通过，程序返回模板兜底，监督者未确认。该处是设计元数据校验失败，不是 JSON 语法错误；底层调用统一用 unparseable 标记，详细 validation_issues 才是归因依据。已补充校验错误的精确 PRD feature_id/kind 绑定及缺漏补齐信息，保持原校验标准，并通过原生 UX 回门重新生成。未手工修补候选元数据后冒充模型通过。

调度协议另明确整批任务结束才释放外部依赖、CORE_CHECK 最多 64 场景；没有提供业务拆分答案。此后冻结的全部执行组使用同一新运行包。

## 验证与证据入口

- 最终相关单元 8 文件 104 项通过；UX 契约/视觉管线 2 文件 33 项通过；seed/原生选择器 9 项通过；集成 2 文件 8 项通过。不同重复执行的计数不相加。
- 项目 typecheck、独立预检脚本 typecheck、完整 build 及最终 main 构建通过。
- 本机探针：`C:/Users/17359/AppData/Local/Bloma/parallel-preflight-20261018/live-r1/preflight.json` 及其 home/usage-ledger。
- 运行与日志同属上述目录；主实验结果在运行结束后补充，不由探针推断。
