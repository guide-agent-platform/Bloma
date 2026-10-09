# Bloma 提示词现状与审查

日期：2026-10-09（北京时间）。审查基线：`sprint2 / d0a08d6`；首批运行链修复提交：`1a30188`。后续形状传递和措辞修复随本报告提交，版本以 Git 为准。

## 结论

当前最主要的问题是**提示词的接线、信息传递和验收证据口径**，不是规则数量不足。部分已经写好的规则没有进入模型请求；实现者只拿到短功能标题；旧通用 loop 把未装配验证工具的豁免当成通过。这些问题比重写一份更长的总提示词更值得先修。

Bloma 实际上没有一份覆盖所有工作的总启动提示词。它采用多个专项 system：向导、PRD 工程、内审、桌面调度员，以及由项目需求与阶段约束构建的子会话基底。统一的是平台规则与事实来源；不同角色需要不同工作说明。这种分工应保留。

本次没有新增自动读取 AGENTS.md，没有改变确认门、生成品类或模型思考策略。本地用户覆盖文件保持原样；其内容与仓库默认的差异列为待整理事项。

## 审查范围与证据边界

- 检查源码调用方、提示词构建器、工具装配、设置服务、两个本地实际存在的覆盖文件，以及各阶段任务书和形状模板。
- 本地覆盖目录：`C:\Users\17359\.proma\prompts\`。有效覆盖为 `guide-system.md` 与 `prd-system.md`；`sketch-system.md.retired-20261005` 是退役备份，加载器不读取它。若启动实例指定其他 PROMA_HOME，须重新核对该目录。
- 本地上游参考：`C:\Users\17359\OneDrive\Desktop\proma-upstream`，核对 `refs/heads/main=bf3e98ca61dd8365eceaef876c0f7473700878a6`。参考 `apps/electron/src/main/lib/agent-prompt-builder.ts` 的静态规则、动态上下文、角色和实际工具分工；不整体迁移 Pi runtime，也不照搬其工具名。
- 测试使用隔离临时 home 和模型请求替身，能证明请求装配与工具生命周期；本次没有进行真实供应商对照实验或从零生成业务程序，不能宣称生成成功率已提高。

## 当前提示词地图

| 类别 | 当前调用入口 | 实际装配与覆盖方式 | 审查结论 |
| --- | --- | --- | --- |
| 向导澄清 | `main/guide/stages/guide-pipeline.ts`、`guide-runtime.ts` | `guide-system.md` 替换默认；首轮附 FIRST_TURN_RULE；loop 模式再附 GUIDE_LOOP_ADDENDUM，用 guide_decide 提交决策 | 主线活跃；本地覆盖的收敛/防扩范围规则优于旧内置版 |
| PRD 工程 | `main/guide/prd-engine-llm.ts` | `prd-system.md` 替换默认；动态章节 schema；能力契约/关键任务按既有开关追加；同类 few-shot 在任务输入中注入 | 主线活跃；需要统一“文档与结构化字段冲突”规则和示例 |
| 需求加厚 | `main/guide/requirement-enricher.ts` | `enricher-system.md` 或默认；输出 story、断言、引用原话、优先级 | 主线活跃；默认取值与引用保真之间有张力，需更严谨地标假设 |
| 修改归一化 | `main/guide/requirement-normalizer.ts` | `normalizer-system.md` 或默认；revise/append/skip/out_of_scope | 主线活跃；示例擅自写“最近 20 条”，应随下次文案整理移除无依据数字 |
| EARS 改写 | `main/guide/requirement-earsifier.ts` | 内置专项 system，词表动态渲染；代码检查引用与语义重叠 | 主线活跃；应维持只改句式，不借改写新增业务 |
| PRD 内审 | `main/review/prd/prd-review-prompts.ts`、`main/review/prd-defender.ts` | Attacker 首审、增量复核、Defender 修订；代码守住条目/约束/草稿提交 | 主线活跃；证据纪律较好，但换名不矛盾、来源可追溯等规则需避免被术语纪律压过 |
| UX 草图 | `main/guide/ux-sketch.ts`、`main/agent/prompting/ux-sketch-prompt.ts` | 现在统一由 `sketch-system.md` 覆盖；静态 HTML，示例数据自洽附录始终保留 | 原设置槽位缺失与文件名问题已修；旧手工文件名兼容 |
| 桌面调度员 | `main/desktop/dispatcher-phases.ts`、`dispatcher-prompt.ts` | 阶段任务书、阶段约束、推进协议、工具纪律、需求契约、草图与形状纪律 | 主线活跃；保留角色与宿主门，修复信息漏传和离线措辞冲突 |
| 桌面子会话 | `buildDesktopChildBaseSystem` → `main/agent/delegation/child-run-context.ts` | 项目契约与阶段约束 + 角色说明 + 具体委派任务；子会话不能继续委派 | 需求、全文 PRD 与形状细则现在直接进入子会话基底，减少依赖父模型转述 |
| 通用 loop 追加 | `main/agent/loop/agent-loop.ts`、`prompt-config.ts` | `loop-system.md` 每次启动读取一次，追加到原 system，主/子会话共用入口 | 原来只能保存、没有运行消费方；已接线 |
| 产品形状 | `main/desktop/shape-templates.ts` | 四种宿主形状 + 条件规则 + 验收教学；按项目 shape 渲染 | 主线活跃；记录重复策略与子会话漏传已修；“硬门”标签不等于已实现确定性校验 |
| 骨架组件手册 | `main/templates/skeletons/desktop-python/ui/PATTERNS.md`、`app.py` docstring | 实现者通过 read_file 按需读取，由阶段任务书指向 | 是有效的内部工程约束；不应让用户在需求中指定它们 |
| 灵感/市调 | `main/guide/stages/research-flow.ts`、`requirement-confirm.ts` | agent 灵感与抓取结果提炼分开；来源标签不同 | 不搜索的建议不能冒充真实市调；现有来源区分应保留 |

设置页六槽位现在是 PRD、UX 草图、向导、加厚、归一化与 loop 追加。桌面阶段表、角色说明、内审与 EARS 目前仍由代码维护；设置页并不覆盖所有提示词。

## 已修复的问题

| 优先级 | 问题与影响 | 本次处理与验证 |
| --- | --- | --- |
| 高 | 桌面需求摘要只传 id/标题/优先级/材料引用，丢失 acceptance、behavior_assertions、constraints、out_of_scope、assumptions；默认最多 24 项、标题 140 字 | 运行装配保留全部条目与长描述，增加验收、断言、范围边界、假设及正式 PRD 全文。真实临时 prd.json 回归检查第 30 项和长描述尾部进入调度员/子会话 |
| 高 | 未装配 GWT 时豁免位为 true，安全扫描通过后 loop 提前撤掉全部工具，并注入“GWT 全部通过、任务已经完成” | 自动全绿收口要求真实装配功能验证面；桌面扫描通过仍可继续执行自测与 GUI 工作。收口、恢复头与受阻报告区分未测/豁免，不扩大成功范围 |
| 高 | 产品形状细则只进入调度员任务书，子会话仅有形状概要；llm-provider.json、待配置态与禁止替代等具体要求依赖父模型再次转述 | scaffold/implement 子基底接 shapeBrief，verify 接 shapeVerifyBrief。实际注册给委派器的 parent context 已验包含形状细则 |
| 中 | loop-system 设置已保存但源码没有调用加载器 | runAgentLoop 统一追加，保留原项目锚；测试覆盖主会话、子会话与下次运行即时读取 |
| 中 | UX 草图用 loadPromptOverride('ux-sketch.md') 导致寻找 ux-sketch.md.md；设置注册表没有 sketch-system，但 IPC 测试期待存在 | 统一 sketch-system，并兼容 ux-sketch.md/ux-sketch.md.md；设置、读取、生成与重置一致。重置连兼容文件一起清除，避免“恢复默认”后仍加载旧规则 |
| 中 | 记录管理形状要求“重复内容缺省拒绝”，与子会话纪律的“不能擅加业务限制”冲突 | 区分一次提交的重复触发与两次独立保存；默认允许内容相同的独立记录，业务唯一性只按 PRD |
| 中 | 桌面任务书同时允许真实 LLM/联网形状，又称整个产物“完全离线” | 改为界面资产离线可用，已确认的联网业务按 PRD/产品形状实现；不放宽 CDN、外链字体、npm 构建限制 |
| 低 | 空白覆盖文件存在时设置显示 has_override=true，实际却回退默认 | 标记依据有效加载内容；加载时清理 BOM |

## 仍需整理的设计问题

### 1. 默认版与本地覆盖分叉

当前本地向导覆盖版已有更合理的收敛策略：不为凑 3~5 个功能而增项；只补主任务必要环节；不默认加入历史/导出/分类；催开工不替代确认；使用 F-001 格式。内置版却保留“管理/留存直接补齐”、固定条数和小写 id 的旧指令。

PRD 覆盖版增加了章节派生、生成式断言与优先级不等于削减范围的规则。更换 PROMA_HOME 或清空覆盖后，这些改进会消失。本轮只读本地覆盖，没有覆盖用户文件；建议下一次把已经采用的规则回收进版本化默认，保留覆盖作为明确的定制层。

### 2. 同一语义存在互相冲突的说法

- PRD 的“严格只提炼”与“按同类常见预期补齐”边界不清。应把已确认需求、必要的行为具体化、待确认建议、工程默认分开，避免假设升级成承诺。
- 加厚提示词要求断言引用真实原话，又鼓励把用户没说的具体时刻按默认写进断言。建议保留可执行的任务行为，将未确认具体值标为可调整假设。
- PRD 正文与结构化字段的优先级不能只靠最后一句提示词定夺。源码读写处理已包含同源校正，但本次不宣称已对所有同字段冲突建立确定性拒收；应做带矛盾样例的行为评估。
- 缺省“九态”应理解为按产品选择适用状态，不是要求计算器也具备批处理/取消/待配置全部状态。

### 3. 代码里的提示词不等于运行中的提示词

`rules-registry.ts`、`prompt-expression.ts`、`main/prompts/shared.ts` 仍保留旧规则文本，但本次查不到它们进入桌面生成请求的生产消费点；不能把它们称为当前统一规范。特别是 server/routes/ctx.writeData 与纯静态 connect-src=none 都是旧 web 语境。

`buildLoopInjection`、`buildSketchInjection`、技术 plan 腿也不能因文件存在就算现行桌面能力。向导中构建了 templateSection/history，但实际 runGuideLoopTurn 收到的是 baseSystem，不能声称那份模板澄清切片已进入当前 loop 请求。不要把旧切片重新接回主线：它们本身仍含 index.html 唯一入口/localStorage/禁止数据库等旧假设。

建议后续明确分出活跃构件、兼容构件和待退役构件，再移除误导性的“全已接线”注释与无消费开关；不在本次顺手复活旧生成路线。

### 4. 提示词承诺强于当前验收

形状规则渲染为“硬门/出现即拒收”，但大部分体验语义仍靠生成者断言与探索发现，平台没有对每条规则逐项裁决。quick 仍以宿主安全检查与启动冒烟收口，不能因提示词要求实际点击就声称 GUI 业务已强制验收。

本次修复扫描后提前停工具，给实现者留下真正验证的机会；没有新增通用 GUI 硬门、没有改变探索 findings 的交付阻断策略。下一步应先用真实产物建立“新增/错误输入/重开留存/重复提交”这类少量稳定用户操作验收，再讨论门禁范围。

### 5. 专项提示词应减少角色无关内容

子会话基底中实现与 JSON 事务纪律也会发给架构、研究和审查角色。具体任务书又重复一遍，容易让模型把“我负责实现”与“只读研究”混在一起。建议后续拆成共同事实、角色职责、阶段任务和验证证据四块，并让恢复/续跑保留事实而不累积历史任务书。

向导的 JSON 默认格式与 loop 工具格式通过明确优先附录兼容，当前不是解析缺陷；长期可以直接维护工具模式版默认，减少相互否定的格式指令。

## 下一步建议

1. 把现有有效覆盖的澄清/保真规则回收进默认；把实现、研究和审查提示词按角色切片。
2. 建一个小规模提示词行为评估集：一句话模糊需求、明确微工具、相同内容重复保存、真实 AI 与用户自配 key、含 30 个功能的任务、异常后续跑。记录输出和需求保真，不只断言提示词字符串存在。
3. 以真实 GUI 操作与数据差分验证质量改进；按失败证据继续修平台，而不是继续堆“不许失败”的文案。

## 验证

首批修复：8 文件、134 例针对性测试通过（含设置 IPC、通用 loop、实际模型请求装配边界、需求 digest 与分层约束）；typecheck/build 通过；主 bundle `__require(`=0。证据：`run-artifacts/prompt-audit-tests.log`、`prompt-audit-build.log`。

后续形状接线与措辞修订：完整单测 223 文件、2133 例通过（`run-artifacts/prompt-audit-unit-final.log`）；最后补传正式 PRD 全文后，受影响的需求/形状/子会话/设置链及层规则复验 5 文件、78 例通过（`prompt-audit-final-targeted.log`）。最终 typecheck/build 通过（`prompt-audit-final-build.log`），主 bundle `__require(`=0。Vitest 的路径过滤会匹配 run-artifacts 中的历史测试快照，本次显式排除该目录，只验当前源码。
