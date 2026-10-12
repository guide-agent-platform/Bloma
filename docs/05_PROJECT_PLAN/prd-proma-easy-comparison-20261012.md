# PRD 对照：Proma-Easy p1-quick-engineering（2026-10-12）

## 核查范围与结论

用户要求核查 `orphiczhou/Proma-Easy` 的 `p1-quick-engineering` 分支；如果实现与 Bloma 当前相同，则按本会话讨论的需求模型改造。

- 本次通过 SSH 实际查询远端并浅克隆指定分支，固定提交 **df23df7d121d349e6a58365f3207e9b0047c59c5**。不是此前 `proma-ai/Proma` main 的本地副本。
- Bloma 对照基线 **ae5af90**，其中复杂生成实际运行源码为 **67ef7af**；失败链路见 [产出链路核查](prd-production-path-audit-20261012.md)。
- **两者的 PRD 主路径不同。** Proma-Easy 由需求分析师直接产出 Markdown PRD，以同一文档的 US 编号连接后续实现与验收；Bloma 的本次失败则先把原话冻结为 F-001，正文另列十二项，机器仍保存一项。
- 因此用户给出的“相同就实施”条件不成立。本轮完成只读对照、离线解析探针和文档，不修改 Bloma 生成流程、不修改真实提示词、不改旧产物、不调用模型。
- 不同不代表 Proma-Easy 已经实现完整的目标/对象/流程/规则/功能/验收需求模型，也不证明其真实生成质量更高。本轮未运行它的应用或付费生成。

## 1. 实际 PRD 产出与消费路径

以下路径均相对于参考仓库 `apps/electron/src/main/lib/`。

1. `nanju-router.ts:216–246` 的 requirements 阶段指定 requirement-analyst，直接产出 `01_PRD/prd.md`。任务要求用生活语言交流、提供选项、列 US 用户故事，每条附验收标准。这里的“3–5”是引导问题数量，不能误解为功能数量硬上限。用户让渡时由分析师推荐、标注代选，不由这段宿主代码构造全文 F-001。
2. `nanju-router-prompt.ts:396` 的 buildL2TaskWithAC 构造角色任务，包含阶段约束、产出路径和审计指令。`nanju-router-prompt.ts:461` 要求 prototype/coding/testing 完整读取 PRD，并逐条对照用户故事；不是只消费摘要。
3. 同文件 `368` 的 getPrdSummary 仅取前 500 字，作为任务中的摘要；实际任务另提供前序文件路径和完整读取要求。不能据此声称“后续只收到 500 字需求”，也不能把提示词要求等同于已验证每次实际完整读取。
4. `nanju-user-stories.ts:2` 的 parseUserStories 从 PRD 文本所有匹配位置提取 US 编号，归一化并去重。`nanju-gwt-runner.ts:1951` 读取同一 PRD 形成覆盖基准；`nanju-acceptance-baseline.ts:21` 也消费该解析器。
5. 架构阶段产出 `03_ARCHITECTURE/acceptance.json`，与 PRD US 关联，分 normal/boundary/exception 三类验收。
6. `nanju-project.ts:356` 新建项目设置 acceptanceBaselineRequired=true。`nanju-router-gate.ts:1265` 据此在架构、编码、测试阶段执行规格与绑定校验；旧项目缺标记的兼容路径不能泛化为新项目保证。
7. `nanju-phase-advance-consumer.ts:1070` 进入 coding 前调用 freezeAcceptanceSpecification，冻结 PRD 和验收规格哈希。后续规格改变则旧基线失效；测试阶段还检查适用 AC 编号是否绑定到场景文件。

## 2. 与 Bloma 当前问题逐项对照

| 方面 | Proma-Easy 指定分支 | Bloma 当前已核查行为 | 判断 |
| --- | --- | --- | --- |
| 功能提炼 | 需求分析师在 PRD 文档里组织 US 故事 | 本次 auto 入口直接冻结全文 F-001；模型正常入口可提供清单 | 入口机制不同 |
| 需求依据 | 后续 US 编号直接从 PRD 文档提取 | 结构化清单与模型正文分别存储，未校验编号一致 | 同源方式不同 |
| 业务结构 | 要求故事与验收；未看到与此前建议等价的独立业务规则及关联模型 | 已有可选 personas/data_model 等，但主功能清单不能表达完整流程和规则关联 | 都仍有深化空间，不等于同样缺陷 |
| 审查 | 作者任务中注入读产物文件的攻防审计要求 | 攻击/复核任务只发送背板五字段，缺正文和验收等 | 输入方式不同 |
| 修订 | 作者/委派代理修改文件；无本次观察到的 validateDefenderDraft 假设丢弃路径 | 两次真实修订提交 assumptions，宿主均返回原七条 | 不能把 Bloma 特定问题归因给此分支 |
| 确认 | 人工确认或 autoClarify 自动审核，通过阶段推进门 | 用户确认仅验证数组并记时间；delegate_all 忽略残留问题 | 自动审核也不同，不宜混称 |
| 验收前置 | 编码前冻结三类验收规格并绑定 PRD 哈希 | 已有需求身份/验收关联和后续门，但本次正文/结构冲突未在确认前拦住 | 可借鉴其时机和三类覆盖 |

## 3. 可以吸收的成熟做法

- **同源性**：用户阅读的 PRD 与工程/验收需求不能各自拥有独立编号集合。Bloma 可以通过结构化模型生成正文实现同源，不必照搬 Markdown 正则解析。
- **验收前置**：实现开始前定义可观察的验收规格，覆盖正常、边界、异常；不等代码完成后由作者反推一组容易通过的检查。
- **规格冻结与变更失效**：PRD、验收规格和执行证据绑定版本；修改规则后旧通过证据不能继续授权交付。
- **完整来源可读**：给审查与工程提供完整需求模型与原始来源，摘要只用于导航。代答决策应披露、单独审查，不能伪装成用户明确要求。

以上是需要结合 Bloma 当前实现适配的原则，不是整套移植其调度器、平台支持范围或自动授权策略。

## 4. 不能直接照搬的局限

### 编号出现不等于声明正式需求

parseUserStories 使用全篇正则匹配，不限定故事标题/清单。离线加载原始解析器得到：

| 输入 | 实际提取 |
| --- | --- |
| 两个正式标题 US-01、US-02 | US-01、US-02 |
| 一个正式标题 US-01，另写“US-99 仅为编号示例，不是需求” | US-01、US-99 |
| 标题 US-1，文中引用 US-01 | 去重归一为 US-01 |

这是源码行为反例，未声称真实项目发生过此问题。改造应使用结构化声明和明确关联，不能把全文出现的编号当作权威清单。

### 需求确认前的结构检查较薄

`nanju-router.ts:701` 的 requirements 最低格式检查只要求 Markdown 标题；`nanju-router-gate.ts:1296` 另检查普通文件和最少 100 字节。三类验收覆盖主要在架构后续门执行，不能把它说成需求阶段已经完成业务完整性判定。

### 审计提示词不等于强制收敛证明

`nanju-router-prompt.ts:644` 注入攻防、修复、复审和最多两轮的要求。requirements 节点 requiresAC=false；`nanju-router.ts:688` 的红问题阻断只在 requiresAC=true 时触发。这一对照证明任务指导与宿主红问题硬门不同，不能把“有审计指令”当作“所有 PRD 均已通过独立审计”。

### 验收项齐备不等于业务正确

acceptance.json 检查编号、三种路径及 GWT 字段，并冻结哈希；它无法单凭结构证明业务数值正确、原话没有遗漏、跨功能规则已全部覆盖。文件有哈希也不能证明其内容正确。

## 5. 对后续设计的建议（未实施）

保留本会话讨论的结构化需求模型，以目标与范围、核心对象、使用流程、跨功能业务规则、功能能力、验收场景及来源关联组织内容；小项目允许短模型，无业务对象时不强填复杂实体。

在此基础上吸收参考分支的文档同源、验收前置和版本冻结原则：

1. 每个入口先整理候选需求，原话/项目目标不再冒充 F-001；用户让渡只改变默认选择方式。
2. 用稳定对象、流程、规则和功能编号建立关联；规则同时约束计算、保存、导入等能力。
3. 生成用户正文与工程契约的不同视图，统一由模型数据投影，禁止独立编号。
4. 审查完整模型与原始来源；修订明确采纳/拒绝字段，不静默丢弃。
5. 确认前验证结构和引用；编码前冻结验收规格；需求变更使相关验证失效。

是否据此继续实施属于下一步方向：不能把“参考分支不同”重解释成用户给出的“相同就实施”条件已经满足。

## 证据与复现

- 参考副本：`run-artifacts/proma-easy-p1-reference/`，只读浅克隆，未安装或执行应用。
- 离线探针：`run-artifacts/proma-easy-prd-comparison-probe.mjs`、`proma-easy-prd-comparison-probe.json`，三项源码行为均复现，模型调用 0。
- 源码：[requirements 节点](https://github.com/orphiczhou/Proma-Easy/blob/df23df7d121d349e6a58365f3207e9b0047c59c5/apps/electron/src/main/lib/nanju-router.ts#L216)、[角色任务与审计](https://github.com/orphiczhou/Proma-Easy/blob/df23df7d121d349e6a58365f3207e9b0047c59c5/apps/electron/src/main/lib/nanju-router-prompt.ts#L396)、[US 解析](https://github.com/orphiczhou/Proma-Easy/blob/df23df7d121d349e6a58365f3207e9b0047c59c5/apps/electron/src/main/lib/nanju-user-stories.ts#L2)、[验收规格与冻结](https://github.com/orphiczhou/Proma-Easy/blob/df23df7d121d349e6a58365f3207e9b0047c59c5/apps/electron/src/main/lib/nanju-acceptance-baseline.ts#L17)、[阶段门](https://github.com/orphiczhou/Proma-Easy/blob/df23df7d121d349e6a58365f3207e9b0047c59c5/apps/electron/src/main/lib/nanju-router-gate.ts#L1265)。
