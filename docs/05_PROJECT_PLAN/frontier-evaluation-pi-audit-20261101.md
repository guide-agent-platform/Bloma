# 前沿路线首批：评测身份与 Pi 适配审计

后续：用户已授权继续升级，Pi已按新版原生接口推进到1.4.0，见[升级记录](pi-runtime-upgrade-20261101.md)。下文0.85.1是前两批的历史基线，不再作为后续目标版本。

日期：2026-11-01（Asia/Shanghai）。起点 `ae43c7e`。用户授权先理清评测身份与Pi适配，实施有证据的优化、验证后分批提交；本轮不跑付费模型、不push。

## 第一批：实际运行身份

原 `single/independent` 只是B设计开关，C/V和普通子任务仍按生产策略运行。本批保留旧文件可读，但新binding为v2，显式记录B、C/V策略、探索边界、工人执行方式、并发上限及宿主策略实现摘要。报告明确比较轴为 `independent_design_B_only`，不再以“single”代表单Agent。

实际父/子Pi启动在请求前报告已加载包版本、适配实现摘要、Node/Electron/OS、模型/协议与脱敏端点身份、上下文/压缩/输出/思考/权限/重试设置、工具定义、系统提示、显式技能和记忆内容摘要。只保存哈希，不保存API Key、URL凭据、query参数或技能/记忆正文。原生Pi扩展仍关闭。

宿主为C/V补充实际角色，保存候选的协作选择记录。模型请求账本中的loop/handoff记录与session/run/model/host观测交叉核对；缺少身份、角色观测或身份改变均保留未知，不生成可比较结论。对子角色保留实际profile和选择次数，不把“策略允许”当作“实际调用”。

配对要求父运行配置、提示、工具、技能/记忆摘要及非B策略一致。未知或不同即拒绝配对；未实现语义归一化，因此即使人认为两份提示等价，字节差异也可能保守拒绝。策略实现按运行进程载入时取摘要，磁盘新build不冒充旧进程已升级。历史v1记录不自动补签身份；报告依旧保留失败/取消/未完成样本。

本批不提供关闭生产C/V的后门，也没有完成真正“无C/V”实验变体；后续消融需在隔离评测入口增加明确策略配置与独立验收。当前首先使已有B对照的含义和限制可核查。

## Pi适配审计

| 面 | 实际接线 | 处置 |
| --- | --- | --- |
| 版本 | package与node_modules均0.85.1；上游1.4.0已有恢复/摘要等变化 | 本轮不直接升级，不改lock；先验证实际适配缺口 |
| 生命周期 | 真AgentSession、SessionManager持久会话、独占session、工具回执、损坏尾行归档 | 保留；恢复不重放副作用 |
| Skills/记忆 | 原生自动发现关闭，但适配器显式调用Bloma `/skill:`、recall、learnings | 纠正调研误判；不再把显式技能当缺失，不另开一套技能loader |
| 模型/窗口 | `bloma-transport`合成模型、128k窗口、固定压缩保留；实际请求走SDKQuery | 先记录真实配置。货币预留context_tokens不是模型能力元数据，不能拿它直接替换窗口 |
| 工具 | Pi内置工具关闭，自定义工具经Bloma权限、预算与回执；sequential | 保留；共享ctx与状态不支持直接把属性改为parallel |
| 传输 | 图像引用水合、供应商请求/usage/金额准入仍由Bloma负责 | 上游原生provider修复未必适用，升级测试须走同一桥 |
| 完成 | 宿主完成守卫、候选检查、C/V与冻结案例仍裁定交付 | 不由Pi生命周期completed代签产品通过 |
| 错误/恢复 | 已有重复失败与修复停止；Pi错误字符串和Bloma类型错误共同处理 | 不重做防空转框架；针对调用/结果配对调查确定反例 |

本地Proma上游核对 `bf3e98c` 的 `apps/electron/src/main/lib/adapters/pi-agent-adapter.ts`、`pi-model-registry.ts`：其也显式采用串行工具，模型注册有独立能力元数据。Bloma采用自定义供应商桥与项目账本，不照搬其模型默认值或整体适配器。

直接Pi上游对照：[1.4.0](https://github.com/earendil-works/pi/releases/tag/v1.4.0)、[恢复调用/结果配对 #11233](https://github.com/earendil-works/pi/pull/11233)。已读取实现及回归diff，不把上游测试通过当作Bloma通过。暂定保留0.85.1并补实际可复现的桥接问题；若后续需要1.x新API，再单独升级、回归与留回退点。

## 验证记录

本机日志在忽略目录 `run-artifacts/frontier-r0-*`。所有模型响应为受控query或127.0.0.1 HTTP/SSE，未访问真实供应商。

- 初测发现Pi仅导出ESM import条件，`createRequire.resolve`不能正确取版本。改为ESM解析及源码测试路径回退，未知版本仍不得比较；失败日志保留。
- 定向2文件28项通过；随后制作、协作、选择器、Pi、真实本机HTTP/SSE及架构8文件59项通过，包含quick/longterm实际Node成品生成与宿主验证，以及父/C子会话观测。
- 随后补强身份完整性、账本关联与历史策略读取，最终2文件15项通过，记录在 `frontier-r0-final.log`。各轮重叠，不累加成一次全仓测试。
- `frontier-r0-types-final.log`、`frontier-r0-build-final.log`通过；主bundle的动态 `__require(` 调用为0，`frontier-r0-smoke.log` 的隔离Electron `S0-UI-007` PASS。没有全仓模型质量结论、干净机器认证或供应商性能结论。

用户原有生产流程文件未暂存/修改，保护hash `53c7abb3aef8497d8b0522b8aab806c82b2ec164`。磁盘构建变化不意味着用户现用实例已加载，本轮不重启用户实例。

## 第二批：修复实际复现的消息配对缺口

第一批提交 `44d59db` 后，针对上游恢复配对问题建立本地反例。修复前4个纯投影用例失败，另一个真实Pi持久会话恢复用例失败；原Pi组其余16项通过，记录 `frontier-r1-before.log`。本地确有问题：`toTransportTurns`省略error/aborted assistant，却仍发送其toolResult；独立孤立结果、重复结果、跨assistant轮结果和没有结果的调用也可能进入请求。

在Bloma线协议投影层按同一assistant轮匹配调用id与工具名，只投影完整的一对；保留正常文本和正常工具结果。先线性扫描配对，再生成请求，不改变原native JSONL、审计或宿主回执，不重放写入、不补造成功、不绕过预算/权限。与上游 #11233 的差异：上游修改AgentSession恢复状态；本批保持0.85.1，修复我们自己供应商桥的投影边界，覆盖被省略assistant后的残留结果。

修复后6文件42项通过：消息投影、真实Pi恢复、127.0.0.1 HTTP/SSE与图片、超过旧96轮/160请求阈值的连续执行、长任务取消续跑、quick/longterm实际制作。日志 `frontier-r1-regression.log`；类型和构建 `frontier-r1-types.log`、`frontier-r1-build.log`通过，`frontier-r1-smoke.log`隔离Electron启动PASS。并非真实供应商或真实模型效果测试。

后续仍需：独立隔离的无C/V消融入口、可信渠道能力元数据、受控自动技能发现、只读并行实验。上述没有被本轮偷偷开启，也不因费用余额为正而启动付费模型。先用本批身份数据和离线契约定位收益，再单独决定生产默认策略。
