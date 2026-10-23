# Bloma 主执行内核迁移到 Proma/Pi（2026-10-23）

用户本轮只批准“复用成熟的 Proma runtime”。交付阶段、确认规则、独立验证与实验安排保持现行策略；没有开始流程精简或付费对照实验。

## 来源与范围

- Bloma 起点：`sprint2 / c7536f6`。用户已有 `production-workflow-v2-20261020.md` 两行补充不纳入本批提交。
- 只读参考本地 Proma `bf3e98ca61dd8365eceaef876c0f7473700878a6` 的 `apps/electron/src/main/lib/adapters/pi-agent-adapter.ts`、`pi-resource-loader-overrides.ts` 与运行守卫。
- 实际安装并锁定与上游相同的 `@earendil-works/pi-coding-agent`、`pi-agent-core`、`pi-ai` **0.85.1**；通过 package-lock 固定依赖树。
- 普通桌面架构、骨架、实现、工程验证阶段，以及其委派子会话使用真实 `createAgentSession()`。SDK 负责模型/工具循环、顺序执行、原生会话持久化、转向队列、原生重试与压缩。
- 冻结实验配置继续使用原执行器，保持已有实验条件。向导决策的旧 loop 与单次结构化生成接口尚未迁移；本批不改变需求澄清及其决策策略。旧执行器是这些明确入口的兼容实现，生产桌面 Pi 执行失败不会自动回退它。

## 运行结构

```text
既有阶段编排与交付门禁
  → runAgentLoop(runtime='pi')
    → Pi AgentSession / Agent
      → 自定义宿主工具适配：schema / 权限 / 项目写入边界 / 工具预算 / 证据
      → Pi streamFunction 适配
        → 既有 SDKQuery 渠道解析、图片水合、物理请求守卫、真实费用账本
```

没有把旧循环套在 Pi 外面逐轮调用。宿主通过 `beforeToolCall`、`afterToolCall` 和 `shouldStopAfterTurn` 保留授权、持续预算中止、收口前置条件与轮次限制。持久额度耗尽后，同一响应中后续工具也被拦截。SDK 原生重试沿用已有 transcript，不重发最初任务来重做成功工具；传输层的永久拒绝标记关闭本次会话的额外重试。

工具作为 Pi `customTools` 注册，沿用 Bloma 的项目文件、驱动和安装工具及其守卫。没有直接开放 Pi 原生 Bash/PowerShell 或绕过项目边界。原生工具结果中的错误标记、工具反馈、修改文件、子任务标识和状态继续映射到原事件协议；“执行完成”仍不代表业务验收通过。

## 会话、恢复与隔离

- 原生完整记录：`PROMA_HOME/bloma-pi-sessions/<sha256>/session.jsonl`。绑定项目、应用会话、阶段、需求执行范围和工作目录；不按“最近一次会话”全局续接。普通 verify 也绑定需求执行范围。
- 原 UI/审计 JSONL 继续写入。首次进入 Pi 时导入已有配对历史；已有原生记录时不重复导入同一审计前缀。没有结果的旧工具意图不重新执行。
- 在工具返回后、Pi 写入正式结果前保存宿主 receipt，并绑定唯一 assistant entry ID，避免复用工具 ID 时误认旧结果。进程中断后，若只有工具调用而没有结果，优先恢复 receipt；没有本次调用的 receipt 时记录“执行结果未知，先检查”，不自动重做可能已完成的副作用。执行副作用与 receipt 落盘之间仍不能宣称跨进程 exactly-once。
- 最后一行被中断写坏时，先保存原字节副本，再原子修复有效前缀；头部或中间损坏明确报错，不静默清空会话。
- 原生自动压缩及显式压缩使用同一受控传输。当前窗口策略采用保守的 128000 tokens，预留 25600、保留最近 20000；这是平台窗口预算，不代表每个模型的实际最大窗口。重试、压缩与继续调用仍受物理请求/输出和货币守卫限制。
- `noContextFiles/noExtensions/noSkills/noPromptTemplates/noThemes`，空 `agentsFilesOverride` 和 append prompt。只使用宿主已装配的 system prompt、材料、显式技能和记忆；不加载父目录的 AGENTS、用户 Pi 扩展或隐式 APPEND_SYSTEM。
- Pi 模型仅为内部传输桥配置，使用固定 sentinel；渠道密钥保留在既有传输路径。Pi 模型 cost=0 是未配置定价，不能解释成调用免费，费用权威仍是既有 ledger 与 monetary policy。
- 图片在原生会话中仍是短引用，进入原有传输边界才水合。运行中纠错到达 Pi 注入点才标为采用；轮次耗尽时保存待下次处理，取消时明确拒绝。

## 验证

针对性验证使用真实 Pi SDK，不替换 AgentSession：模型协议流可脚本化，另有本地 HTTP/SSE 测试经过实际 provider 适配与账本。覆盖顺序工具、工具结果配对、恢复不重做写入、缺失 receipt、尾行中断、阶段隔离、收口条件、截断、权限拒绝、持续额度、取消、原生压缩、重试、运行中纠错与隐式提示词隔离。

- 正式四目录全量快照：316 文件 / 2800 项通过，`run-artifacts/pi-runtime-full.log`。此执行早于最后的 receipt 绑定、永久拒绝、失败输出证据丢弃和延迟加载等收尾，不标成最终源码全量结果。
- 随后的最终范围回归：6 文件 / 111 项通过，`pi-runtime-final-targeted-2.log`，覆盖 Pi 合约、本地 HTTP 传输、dispatcher、生产主 Agent、预算和 desktop route。最终延迟加载改动另以 3 文件 / 18 项通过，`pi-runtime-lazy-load-final.log`。两组与全量重叠，不累加数量。
- 类型检查、应用构建与文档检查通过：`pi-runtime-types-final.log`、`pi-runtime-build-final.log`、`pi-runtime-docs-final.log`。构建将 Pi 包作为外部 ESM 依赖，产物中保留动态 import，未引入 `__require(`。
- Electron 39.8.10 / Node 22.22.1 实际加载 Pi SDK 并执行工具写入 PASS，`pi-runtime-electron-sdk-final.log`；另有隔离 home / user-data 的原生启动 `S0-UI-007` PASS，`pi-runtime-electron-ui-final.log`。前者证明 Electron 运行环境与 SDK 执行兼容，后者证明界面可启动，不代替真实模型全链验收。
- 早期试跑修正了测试预算枚举和不足以触发压缩的短历史；`pi-runtime-tests.log` 当前是修正后的通过记录。另保留失败记录 `pi-runtime-final-targeted.log`：并行全量负载下出现旧测试超时及 25ms 启动时序假设。后者改为假时钟在 provider 已开始监听后推进 25ms，仍要求真实 abort、宿主错误和不可推进；真实超时策略未放宽。独立复跑和最终范围回归通过。

没有新增真实模型付费请求；因此不能宣称真实时间、费用或生成产物质量已获得改善。原智学伴失败产物和付费记录未改写。应用已重建，用户现有实例未重启；下一次启动加载新构建。未 push。
