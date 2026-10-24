# GUI验证工具契约修复

2026-10-24。基线f94339f。用户要求先修复最新计算器会话反复验证报错，再形成软件专精四项优先方案。

## 问题与证据

Bloma会话e47b41d6-ab3a-4adc-a86a-cf58d03d73bc中，register_gui_check调用61次全部失败；inspect_app调用17次，其中14次参数错误。步骤schema没有公开id/kind/equals，错误只有简短错误码；预期文本和映射反复抄写；进展名单漏掉新工具。此前固定SDK回放使用手写正确参数，未覆盖仅凭公开契约调用工具的路径。

追踪与原始隔离复验位于run-artifacts/latest-bloma-session-verification-review-20261024.md、latest-calculator-diagnostic/result.json。该次复验不是原项目交付认证。

## 已完成修复

- gui-tool-contract统一公开步骤schema、字段含义与最小示例，inspect_app/register_gui_check/协议查询共用；kind/id必填，精确断言为equals。
- 解析错误携带steps索引、缺失字段和修正方法；restart后的空断言段明确报错。
- 新software-v1流程由宿主绑定已确认expected，不要求模型重复传expectations。兼容显式旧参数但拒绝改写目标；lean-v1仍保持原有要求。
- acceptance_refs明确为expect步骤id→F编号数组，全部功能覆盖、真实交互、固定场景不可降低预期、版本绑定继续保留。
- 参数拒绝反馈为not_run/invalid_input/correct_input；宿主执行异常不当作业务断言失败。错误说明明确：前置拒绝不表示后续字段已校验。
- 成功的run_command/start_service/stop_process/inspect_app/register_gui_check/register_cli_check计入工程进展；read_process轮询和失败调用不能冒充进展。GUI工具连续失败时提醒先查契约，不因参数错误修改业务代码。
- 制作指令与按需协议同步，未增加新的审查角色、固定重试限次或付费调用。

## 验证

| 记录 | 范围与结果 |
| --- | --- |
| gui-contract-fix-tests.log | 初始5文件/36项通过，包含原生Python GUI、冻结预期、协议查询和进展判定 |
| gui-contract-pi-gui-regression.log | 3文件/23项通过，含真实Pi SDK读取公开schema、历史坏参数被拒、随后正确参数登记；Electron/浏览器正常入口操作与错误预期反例 |
| gui-contract-final-regression.log | 最终4文件/26项通过，包含新增契约回归、进展检测、制作/修复/预算与公开创建到真实Python GUI/CLI交付的兼容路径 |
| calculator-contract-fix-replay.log | 在隔离新项目中注册修正后的真实会话输入，操作现有打包Calculator.exe，F-001/002/003本次固定场景通过；更改固定预期999仍被拒 |
| gui-contract-fix-release-types.log | 类型检查通过 |
| gui-contract-fix-build.log | renderer/main/preload构建通过 |
| gui-contract-fix-electron.log | 隔离Electron主窗正常加载通过 |

定向集合相互重叠，不能相加。诊断与回放均未调用付费模型。真实模型是否能稳定一次正确调用新工具，仍需后续带明确费用上限的在线验证；固定SDK回放不冒充该结论。

## 数据与版本边界

本次没有给原计算器项目补写验收suite或改成已交付，没有改原历史、目标或源文件。calculator-contract-fix/result.json记录原项目索引字节、源码指纹未变。隔离项目的通过只证明此次契约和宿主执行路径。

新构建需在用户正常重新启动Bloma后生效；不重启用户现有实例。用户已有production-workflow-v2文档两行改动保留，未纳入修复提交。不push。

## 后续方案约束

四项优先方案另见software-specialization-four-priorities-20261024.md。新增工具的公开schema、运行校验、恢复反馈与进展识别必须同批接线和回归；不能再次只测预先写对的参数。方案是后续开发稿，不作为每个用户项目必须执行的新流程。
