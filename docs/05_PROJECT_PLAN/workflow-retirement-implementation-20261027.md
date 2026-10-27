# 旧流程退役实施记录（批次 D）

## D0：迁出共享代码

长期型批次 C 的提交为 `ab4afab`。开始删除旧执行前，将新制作流程依赖的工具装配、子任务完成等待、运行时工具及宿主验收门/输入输出类型迁至独立模块：`production-tool-assembly.ts`、`production-completion.ts`、`production-runtime-tools.ts`、`production-contracts.ts`。

当前主线直接引用这些模块；旧模块保留兼容导出，旧执行行为暂不改变。尤其不能将 `lean-v1` 仍消费的 Python 工具与旧 dispatcher 整体一起删掉。下一步先提供明确的副本迁移入口并关闭旧执行，再清除不再有消费者的编排代码。项目、历史卡片、产物、证据和费用记录仍保留。

类型检查和实际制作回归日志为 `run-artifacts/retirement-d0-typecheck-20261027.log`、`retirement-d0-production-tests-20261027.log`；机器依赖清单随此次拆分更新。验证均使用隔离 home 和离线查询，没有真实付费模型请求。
