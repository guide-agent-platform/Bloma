# 工具事实与恢复协议的局部重构

本页保留第一次离线修复时的状态。用户后来恢复的 DS 冒烟及新增编码修复见 [DS 可靠性记录](./ds-reliability-20261014.md)。

2026-10-14 用户要求先修底层问题，并判断是否需要重构。已完成有边界的局部重构：工具提供执行事实，统一策略生成恢复动作，编排在调用模型前检查恢复准入。此次没有新增模型请求，付费实验继续暂停。

这次没有重写整个 agent loop 或切换上游 SDK。Proma bf3e98c 的完整结构化工具结果、前置参数校验和等待清理作为参考；保留 Bloma 的独立业务验收、固定角色绑定和人民币保护。旧失败数据不改写。

```mermaid
flowchart LR
  A[工具执行与实际断言] --> B[安全的 ToolFeedback 事实]
  B --> C[统一恢复策略]
  C --> D[模型正文与 UI]
  C --> E[委派交接与恢复准入]
  E --> F[下一次模型调用或明确停止]
```

## 实施结果

| 审计问题 | 修复后的行为 | 主要接线 |
|---|---|---|
| 永久额度耗尽却指示 resume | 记录 resource/scope/used/limit/remaining/resets_on；持久 session 额度要求新运行，旧未知语义记 inspect；仅明确的 invocation 限额可恢复 | `shared/tool-feedback.ts`、`tool-feedback-policy.ts` |
| 因退出码 1 猜产品业务失败 | 通用 Python 执行与契约驱动分开；没有有效 FAIL 场景时业务 unverified，保留 stderr 供确认失败对象；实际 FAIL/BLOCKED/PASS 分别保留 | `main/desktop/script-execution-facts.ts`、`child-exec-tool.ts` |
| 工具说明要求无头测试，验收却要求 GUI | 明确受控启动、操作、关闭 GUI；逻辑自测不替代真实 GUI，禁止无结束条件的主循环 | `child-exec-tool.ts` 的实际工具 description |
| 耗尽后继续购买模型调用 | 第一条明确不可恢复预算回执就退出 loop；委派续接在改变状态及调用模型前拒绝；实验终止回执阻止后续绑定/请求 | `agent-loop.ts`、`task-handoff.ts`、`agent-collaboration.ts`、`dispatch-experiment-recovery.ts` |
| 终止事实在压缩交接中丢失 | 持久额度事实优先保留，普通后续读操作不能把它挤出有界交接；重启后的 typed handoff 使用同一恢复规则 | `retainedToolFeedback`、task handoff 读写 |
| 权限拒绝被称为执行失败 | 直接拒绝为 permission/not_run，带稳定拒因和实际范围；不通过错误文字猜分类 | worker scope、dispatcher gate、permission mode/canUseTool 四条路径 |
| 空文件路径消耗额度后才报错 | schema 的 minLength/pattern 在权限及预算计数前校验；保留合法空文件内容，list_files 的默认根目录行为不变 | `tool-input-validation.ts`、文件工具 schema |
| 脚本间接写未授权源文件 | 受控写操作用同项目写入租约串行；脚本前后审计项目源文件，回滚越界编辑/创建/删除；测试数据用独立 APP_DATA_DIR | `source-write-audit.ts`、worker/standalone 包装、child runner |
| 冻结输入只在阶段开始检查 | 每个实验模型请求前再次核对冻结输入；中途变更在下个 RPC 前失败，不按原指纹继续消费 | `dispatch-experiment-inputs.ts`、guardExperimentQuery |
| 脚本次数等隐含上限不可见 | 新模型矩阵冻结 execution_limits：默认脚本 12、安装 4；生产工具使用同一值，记录实际父/子轮数与请求上限的区别 | execution-limits、snapshot、condition hash、report/aggregate、dispatcher 装配 |
| 两份策略文件可能重复使用模型余额 | host/model 唯一活动策略登记；预留与入口切换共用登记锁；在途请求禁止切换；非重置模型须带入所有旧费用和未知预留 | `monetary-epoch.ts`、monetary-budget 预留入口 |

恢复、UI 和持久化仍使用兼容的 schema_version=1，新增字段有白名单与数值一致性校验；不会把 arbitrary detail、请求体或渠道密钥整份透传给模型。生命周期结束仍不代表业务验收通过。

脚本异常只表明验证未完成，不能默认认定错误一定属于脚本或产品。新的通用执行反馈要求先检查 stderr，避免把“修复产品”错误替换为“总是修复验证器”。真正报告 FAIL 的测试仍按产品断言失败处理。

## 预算与暂停

当前新操作入口为 `run-artifacts/reliability-20261014/round2-policy.json`。已用本地操作将它登记为两个模型的活动入口：GLM 依据用户批准的新轮 50 元重置窗口；DeepSeek 不重置，保留原累计 50 元全部条目及未知费用。旧策略、旧状态、新策略、新状态四份文件内容哈希均未改变；只新增活动入口登记。旧入口通过本版守卫被 `MONETARY_INACTIVE_EPOCH` 在 HTTP 前拒绝，且不进行流式重试。

此前新轮 GLM 已报告峰值估算为 9.016836 元，守卫剩余 40.983164 元；DeepSeek 原累计守卫剩余 25.205606 元。此处是保守预算估计，不是供应商发票。本次修复新增模型消费为零。活动入口约束面向使用当前守卫的实验请求，不追溯控制独立旧程序或其他 API 客户端。

## 验证

证据目录：`run-artifacts/tool-feedback-refactor-20261014/`。

- 最终完整单测 267 文件/2439 例通过，包含“中途改冻结输入，下次请求前拒绝”的回归，证据为 `unit-final.log`。
- 集成 2 文件/8 例通过；最终类型检查和构建通过。
- 最终相关回归 3 文件/45 例，以及货币入口 13 例通过，包含真实 FAIL、脚本异常、未知预算、合法 turn_limit 续接、第一条永久额度拒绝即停止、重启与交接保留、旧预算入口拒绝和无自动重试。
- `offline-proof.json`：真实 Python 在受控临时目录修改允许文件及越权文件；越权编辑被还原、越权新文件移除、合法修改保留。活动入口迁移及旧入口拒绝验证均无 HTTP/模型调用，账本原始哈希保持不变。
- `PAUSED.json` 与此前原生 G22 失败仍保留，没有用离线通过结果替换真实失败行。

## 边界与后续验证

源码审计是实验工具链级的副作用检查，不是操作系统沙箱。它只审计项目树，排除 .venv、__pycache__、.git 等管理/缓存目录；并不保证任意 Python 程序无法写项目树外的文件。遇到符号链接、审计容量超限或无法完整回滚时会终止实验并保留现场，不假报通过。隔离实验工作区不能同时被外部编辑器或其他进程改源码；项目写入租约只协调本进程的受控工具。

本轮离线修复和验证已完成，但新版本真实调度交付闭环仍未验证。保持付费暂停，等用户明确恢复后使用新构建和新冻结快照做受限冒烟，不能直接续跑旧终态样本。三个难度档仍是设计候选，L2/L3 外部评分器尚需实现与校准。
