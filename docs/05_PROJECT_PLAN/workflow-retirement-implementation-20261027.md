# 旧流程退役实施记录（批次 D）

## D0：迁出共享代码

长期型批次 C 的提交为 `ab4afab`。开始删除旧执行前，将新制作流程依赖的工具装配、子任务完成等待、运行时工具及宿主验收门/输入输出类型迁至独立模块：`production-tool-assembly.ts`、`production-completion.ts`、`production-runtime-tools.ts`、`production-contracts.ts`。

当前主线直接引用这些模块；旧模块保留兼容导出，旧执行行为暂不改变。尤其不能将 `lean-v1` 仍消费的 Python 工具与旧 dispatcher 整体一起删掉。下一步先提供明确的副本迁移入口并关闭旧执行，再清除不再有消费者的编排代码。项目、历史卡片、产物、证据和费用记录仍保留。

类型检查和实际制作回归日志为 `run-artifacts/retirement-d0-typecheck-20261027.log`、`retirement-d0-production-tests-20261027.log`；机器依赖清单随此次拆分更新。验证均使用隔离 home 和离线查询，没有真实付费模型请求。

D0 已提交 `878aba1`，相关 3 文件 / 9 项回归、类型与依赖复核、文档检查通过。

## D1：退役入口与显式副本迁移

未标记历史项目在主分发、向导、桌面入口和制作入口返回明确退役状态，先于渠道解析与模型准入；旧需求确认 IPC 不再消费卡片。已用短流程的 lean-v1 保留现行能力，并可选择复制为 software-v1。未知版本拒绝执行。

冻结实验配置的存在独立于旧开关识别，包括损坏配置；不因开关关闭而当作新项目执行。实验 CLI 只准 `inspect/report/aggregate`，原生重放和 supervisor 入口关闭。配置、账本、原证据、失败事件均保留。执行主体在下一子批清除。

历史列表提供“复制到新流程”。迁移使用经过验证的独立工程导入，复制当前源码目录及其中的数据，保留原项目身份与所有外部数据/账本；不继承旧确认、验收 PASS、发布指针或费用授权。新副本从需求确认开始。外部数据位置必须在新任务单中核对，不自动迁入，更不覆盖原位置。

验证：`retirement-d1-tests-20261027.log`（3 文件、8 项），`retirement-d1-entry-tests-20261027.log`（4 项，补验主 runAgent 在渠道解析前退出），类型检查和完整构建通过。原生 `scripts/verify-workflow-migration.mjs` 的 4 组检查通过，见 `run-artifacts/retirement-d1-native-20261027.log` 和 `workflow-migration-20261027/report.json`。截图独立查看；旧开关启用时发送“继续”仍只返回退役，实际界面复制后原源码/数据/账本不变，副本无交付权威。

发送历史消息会正常记录活动时间；迁移本身保持原索引记录逐字段不变。首次原生检查误用旧构建、第二次断言未区分消息活动时间，失败日志与报告保留为 `*-stale-build*`、`*-activity-timestamp*`；补建当前版本及修正验证边界后复核通过，没有放宽执行/数据门禁。
