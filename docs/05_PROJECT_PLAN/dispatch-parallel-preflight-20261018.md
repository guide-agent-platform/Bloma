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

沿用统一 L2 quick 的已确认需求、草图及 14 项独立业务验收，重新按当前运行包冻结。业务文件逐项哈希与旧输入一致；不复用旧产物、旧实现会话或旧评分。

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

本机启动材料位于 `C:/Users/17359/AppData/Local/Bloma/parallel-preflight-20261018/pilot-r2/`：registry.json、snapshot、evaluator、models.json、limits.json 及六组独立 home。初次离线准备因角色绑定文件格式错误在模型调用前失败，保留 pilot/ 目录；修正后 pilot-r2 六组准备成功，准备阶段 0 次模型调用。

原生启动需显式 `--no-monetary-limit --glm-plan coding --credentials <DPAPI 文件>`；不指定金额模式或同时指定 policy 会拒绝启动。Implement/Verify 主链仍记录用量，其 SSE 金额守卫已关闭。其他独立辅助路径可能有自己的预算；本轮不重新启动 UX 等准备阶段，不将该开关泛化为全应用预算策略。

## 验证与证据入口

- 相关单元 7 文件 86 项通过；核心验证 1 文件 15 项通过；seed 路由 3 项通过；集成 2 文件 8 项通过。
- 项目 typecheck、独立预检脚本 typecheck、完整 build 及最终 main 构建通过。
- 本机探针：`C:/Users/17359/AppData/Local/Bloma/parallel-preflight-20261018/live-r1/preflight.json` 及其 home/usage-ledger。
- 运行与日志同属上述目录；主实验结果在运行结束后补充，不由探针推断。
