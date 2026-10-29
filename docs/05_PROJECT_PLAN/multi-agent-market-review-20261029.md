# Bloma 角色配置现状与多 Agent 市调

核对日期：2026-10-29（Asia/Shanghai）。工程基线 `d9b985b`。本轮是源码核查、官方资料调研和建议，不修改运行配置或UI、不启动真实模型/历史实验、不push。用户原生产流程文档改动保持未暂存。公开产品资料会变化，以下是本次访问快照；官网功能说明不代表已在Bloma中实现或有提速收益。

## 结论

旧角色UI仍存在，保存与路由链也还在；但其中混合了现役流程分组、历史兼容语义和已经独立出来的验收配置。“向导/编程/裁判”不是三个常驻并行Agent，选了三个模型也不等于启用了三Agent协作。当前软件流程已有真实按需委派能力，裁判/内审标签却不能说明当前产品一定会调用一个LLM裁判。

建议先收敛UI语义，再做主负责人统一集成、按需启用的少量专业子任务。优先范围是资料侦察、冻结候选的代码审阅和已有B独立验收设计；视觉审阅及执行型测试助手要先补材料授权、来源绑定和运行隔离。没有依据恢复固定全流程“多角色开会”或承诺多Agent更便宜。

## 本地实际接线

| 层次 | 源码事实 | 能说明什么 |
| --- | --- | --- |
| 旧角色UI | `renderer/components/ChannelSettingsPage.tsx` 的RoleRoutingSection在模型渠道页无条件挂载，文案是给向导/编程/裁判三个Agent分配渠道 | UI没有移除；不是隐藏功能或无提交的残影 |
| 保存与路由 | `shared/types.ts` 将guide映射guide/prd/summary，programming映射sketch/mvp，judge映射judge/audit；`main/ipc/channels-routing.ts` / `category-routing.ts`保存展开后的类别配置 | 主要是模型调用类别分组，不是Agent实例管理 |
| 实际优先级 | `runtime-fallback.ts`、`chat-submit.ts`、`agent-dispatch.ts`按显式会话channel_id → 类别路由 → 默认渠道解析；`ux-confirm.ts`仍解析sketch/mvp | 向导/编程组有真实调用路径；显式选定会话渠道可能盖过角色分组 |
| 当前需求/制作流程 | `lean-guide.ts`明确使用单轮提取，不走独立research/audit管线；`lean-production.ts`让主制作Agent与宿主验证闭环 | 不能把旧PRD六维审查或旧MVP语义裁判文案当现役固定步骤 |
| 旧审查模块 | `main/review/review-delegation.ts`仍有runDelegatedReview定义，静态全main搜索未发现生产调用方；judge_review还保留阶段/路由兼容映射 | 结构和历史代码存在，不证明当前软件项目实际调用裁判/内审模型 |
| 真子Agent | `production-tool-assembly.ts`装配delegate/wait/get/stop；`agent-collaboration.ts`创建独立session并runAgentLoop | 不是仅用提示词模拟角色，具备实际分会话协作 |
| 软件委派限制 | `lean-production.ts`设maxConcurrentDelegations:2、allowChannelOverrides:false、继承父env/预算，子Agent不能再委派 | 默认主模型下按需最多两个并行子任务；这里不支持任意子任务另选厂商/模型 |
| 写与执行 | `collaboration-policy.ts`强制独占且不重叠的write_paths；只读角色无写工具；子Agent无run_command，写子任务活跃时主命令等待，主负责人统一构建/观察/验收 | 当前适合按文件分工；不能把子Agent称作已拥有独立测试机的执行专家 |
| 项目B模型 | `SoftwareModelSettingsPanel.tsx`、`independent-settings.ts` / `independent-design.ts` / `independent-policy.ts`独立配置和记账 | B在实现前基于确认目标/设计生成冻结GUI业务案例，不是旧judge下拉框，也不是最终发PASS的模型 |

“单模型”和“单Agent”必须分开：同一模型可以运行主/子多个会话；B独立设计需要不同模型和单独明确预算，但宿主仍依据实际业务操作、版本和证据裁决。当前是否曾触发委派要看项目事件/记录，源码与本机替身检查不能证明真实项目采用率。

另有 `coding/worktree-isolation.ts` 的通用worktree模块，缺省开关off。没有核对用户正在运行实例的实际开关，不能把模块存在当作当前所有软件子任务均已物理隔离；本轮明确验证的是软件写路径租约和主负责人执行边界。

本次重跑 `category-routing.test.ts`、`software/collaboration.test.ts`、`software/independent-design.test.ts`：3文件50项通过。证据 `run-artifacts/multi-agent-market-20261029/local-checks.log`。使用隔离目录及受控查询/服务，不调用真实模型；覆盖角色展开/保存、实际子循环共享预算、两并发/越权拒绝和B案例执行。它不是当前用户实例屏幕实测、真实模型质量或效率结论。

## 官方产品/框架对照

| 对象 | 本次官网确认的机制 | 对Bloma的启示 |
| --- | --- | --- |
| Claude Code Subagents | 独立上下文、描述/提示词、工具与权限，支持专项调研和审阅 | 角色应绑定可检查的权限与输入，重复职责才做预设。[官方说明](https://code.claude.com/docs/en/sub-agents) |
| Claude Code Agent Teams | 独立会话、共享任务和相互通信；仍标实验性，提示成本及文件冲突 | 先试清晰边界的研究/审阅，充分独立的模块再并行写；不必先做群聊团队。[官方说明](https://code.claude.com/docs/en/agent-teams) |
| Codex | 专业子Agent并行并汇总，强调上下文隔离和读密集任务，也提醒额外token及写冲突 | 主负责人保留目标与决策，子任务只回传有证据的摘要；工具可用与主动触发规则是两回事。[OpenAI官方说明](https://learn.chatgpt.com/docs/agent-configuration/subagents) |
| Cursor | Explore/Browser等专用子Agent，支持自定义提示词/工具/模型；缺省共享checkout，可显式使用隔离worktree/VM | 噪声大、专业工具多的探索/浏览器观察适合拆出；写任务要明确隔离策略。[官方说明](https://cursor.com/docs/subagents) |
| Devin CLI | 有前台/后台子任务、配置profile/权限、状态和续跑；子任务各自消耗额度 | 需要可见的任务生命周期和真实权限，不让后台助手无限继承主预算假设。[官方说明](https://docs.devin.ai/cli/subagents) |
| Aider | architect先给方案，editor再生成具体编辑，是可选双模型顺序工作方式 | 有明确接口问题时才使用两段式；它不是并行团队的证据，也不必强制每次生成经过架构Agent。[官方说明](https://aider.chat/docs/usage/modes.html) |
| LangChain/LangGraph | 明确区分子Agent、handoff、skills、router和自定义工作流；并非每个复杂任务都需要多Agent | 模板/可复用工具/技能优先承接确定行为，真正需要独立上下文或并行推理的工作才拆会话。[官方说明](https://docs.langchain.com/oss/python/langchain/multi-agent) |

OpenAI Agents API另有可配置并发和共享环境的委派机制；共享文件系统不自动提供逐Agent隔离。这是产品/API能力参考，不建议仅因厂商支持就替换当前Pi运行底座。[官方说明](https://developers.openai.com/api/docs/guides/agents-api/multi-agent)

成本收益必须实测。Anthropic的2025年研究系统文章说明并行研究的收益，也报告其多Agent约为普通聊天15倍token，并提醒高共享上下文、依赖密集的编程任务不一定适合。分母是其聊天交互，不能换算成“Bloma多Agent比单Agent贵15倍”，更不能把其研究评测收益当成Bloma编程提速率。[研究系统原文](https://www.anthropic.com/research/multi-agent-research-system)

## 建议安排的分工

| 分工 | 输入和输出 | 当前可用边界/需要补齐 | 建议 |
| --- | --- | --- | --- |
| 组件/资料侦察 | 限定问题、工程路径和公开资料；返回组件候选、依赖/兼容限制及引用 | explore/research只读工具已存在，安装和运行仍归主负责人 | P0按需，不固定每轮启动 |
| 代码与数据审阅 | 冻结候选/指定改动；返回具体缺陷、文件位置、复现条件和未知项 | review只读已存在；源码并发改变时旧结果不能当当前通过。最好绑定稳定候选再审 | P0按需，首期仍沿父模型，不声称异模型独立性 |
| 业务验收设计B | 已确认需求/设计，不看实现；返回冻结业务操作与预期 | 已有单独项目配置、不同模型、预算授权；首期GUI，缺预算或能力不能暗中降级 | P0沿现有入口完善说明，不并入旧judge |
| 视觉/交互审阅 | 当前候选截图、参考设计及业务上下文；返回可见问题和操作建议 | 子Agent虽有view_image，但父debug_session_id受会话归属保护，不能直接越权复用。须受控交付项目内冻结图片或授权材料并绑定版本，真实附图 | P1，契合多模态方向；视觉意见不代替宿主业务断言 |
| 模块实现子任务 | 已定接口/精确文件所有权；返回实际文件改动和未验项 | 可用implement/write_paths；当前共享目录写权限和集成屏障，不能并改package-lock/公共入口再各自宣称构建通过 | P1仅明显可拆分时使用 |
| 故障假设/日志分析 | 限定失败事实、脱敏日志、来源版本；返回定位假设/建议验证 | 可只读并行分析。执行型测试专家尚缺自己的受管命令/进程/数据隔离；不能仅改role名称就给shell | P1先分析，执行权限另验 |

不建议本期新增常驻“项目经理/架构师/测试/安全/裁判”五六段流水线，或让多个Agent随意写同一工程。Bloma的主负责人已经承担决策和集成，测试/进程监管等确定执行器也不是因为换个标签就成为LLM Agent。

## UI与实施顺序建议

1. 先修语义与可观测性：旧“角色配置”改为高级“流程模型路由”，区分当前使用的沟通/制作类别与旧裁判/内审兼容项；保留配置，不直接删除历史值。显示“会话固定/类别路由/默认”真实来源及当前模型，避免保存后误以为一定生效。
2. 单独展示协作策略：主负责人、当前并发上限、同模型继承、只读/写入范围和任务状态。项目B仍单列为“独立验收设计”，明确“B设计案例，平台执行裁决”。不要把“单模型”标成“完全没有子Agent”。
3. 先让少量预设连接既有工具：资料侦察、代码审阅；再补视觉材料授权和冻结版本。现阶段不增加新的强制模型步骤，不偷偷开放异渠道覆盖。
4. 写并行先保留两并发和独占路径；若要让子Agent独立跑测试，再实现和验证专属执行环境/版本、取消、数据隔离、结果回收与共享预算，而非只增加下拉菜单。
5. 最后以同需求/设计/环境比较单负责人、按需只读协作、B设计三种条件。记录完整物理请求/费用/失败/人工介入及缺陷，不复活旧六组实验、不沿用旧额度；真实试验须先明确新的范围与预算。

本轮只交付核查和决策依据，没有代用户改变Agent架构、隐藏UI或开启多Agent付费运行。建议下一轮先做第1–2项，把“界面看起来有”和“当前实际生效”对齐。
