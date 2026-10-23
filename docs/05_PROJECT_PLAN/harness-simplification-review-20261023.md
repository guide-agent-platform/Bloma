# 草图故障与 Proma-Easy 设计对照（2026-10-23）

结论：需要削减默认流程和重复协议。Pi 接入只替换执行内核，不会自动消除向导、草图和审查阶段的冗余。下一刀优先落在草图阶段，不能把生成失败包装成成功，也不靠增加提示词和重试预算解决协议过重。

## 本次真实草图故障

项目 `5c7f3775-e001-4dc8-a375-29944b62c78e`，会话 `9a0543a9-e582-4344-a683-692582bc0e89`。18:34:13 开始、18:38:13 出兜底，约4分钟、7次物理请求，其中1次缺用量，不折算为准确账单。

- 候选A三次在设计记录处截断。原始输出44095/44328/44328字符，其中已经完整生成的HTML分别38223/34071/34071字符。旧解析器因外层JSON未闭合，连完整HTML也没有保留，重试继续输出整份HTML与记录。
- 候选B生成了25157字符的完整界面。首次存在多处功能/场景关联错误，第二次剩4处页面声明/流程覆盖错误；尚未通过既有设计契约，不能宣称已验收。
- 所有候选失败后，视觉管线返回候选A的机械模板。模板将功能描述与验收文字排成列表，UX确认层仍发“草图画好了”和开工按钮，形成用户看到的文字PRD。
- 模型使用内置 sketch-system，不是本地旧提示词覆盖导致。此路径仍是单轮生成链，不经过刚接入的桌面 Pi 执行循环。

原证据位于 `PROMA_HOME/agent-workspaces/default-software-builder/documents/<项目ID>/diagnostics/ux-design-attempts.jsonl` 及产物目录 `00_UX/exploration/8a24c311-d16d-4e91-9204-6b107d43fd04/`。原项目、会话与原始证据未改写。只读提取的候选与截图保存在 `run-artifacts/ux-generation-20261023/`，未作为确认版本。

## 本批缺陷修复

1. 外层JSON截断时，只保留能独立JSON解码、通过现有HTML安全检查的完整html字符串；不补造缺失字符，不接纳不完整设计记录。下一轮明确要求只补design，实际新增HTML标记时仍要求重发完整视图。
2. 已确认PRD对应的草图生成失败时明确报错。需求列表模板不再进入正式设计确认；旧模板摘要与失效/缺失预览也不能获得开工授权。
3. 失败卡只提供重新生成、调整与稍后处理；不提供确认开工或让渡开工。失败原因、待处理意见和阶段状态持久保存，重启后可明确重试。
4. 有效设计仅因预览发布失败时，保存该HTML与设计记录；明确重试只重新发布预览，不再调用模型重画。

原始需求、适用验收关联校验和真正交付门禁未放松。尚未实施下文的流程精简建议，也未新增付费模型调用。

## Proma-Easy 核对范围

用户指定分支 `p1-quick-engineering`，本次GitHub连接器核对HEAD为 `df23df7d121d349e6a58365f3207e9b0047c59c5`。只读分析13个设计、状态与核心源码文件，缓存于 `run-artifacts/proma-easy-reference-df23df7/`；未安装依赖、运行该项目或宣称其产品质量更高。

需要区分旧设计和当前实现：旧 [v2.3设计](https://github.com/orphiczhou/Proma-Easy/blob/df23df7d121d349e6a58365f3207e9b0047c59c5/docs/nanju-v2.3-design.md) 的quick在prototype后结束；当前 [路由源码](https://github.com/orphiczhou/Proma-Easy/blob/df23df7d121d349e6a58365f3207e9b0047c59c5/apps/electron/src/main/lib/nanju-router.ts#L252) 已要求prototype→architecture→coding→testing→delivered。不能把旧流程图当作现行的轻量实现。

| 设计 | 对照后建议 |
| --- | --- |
| 固定阶段替代动态树形管理 | 保留少量宿主状态；无需让模型解释或维护编排树 |
| task/output_path/constraints 交接，按阶段读取产物 | 学习其简洁原则；只给当前任务、约束和权威文件入口，避免在多份任务书中复写同一PRD |
| L1只能委派、L2才允许写入 | 默认开发不采用；主执行者直接读写验证，独立任务才委派 |
| 原型先连续两轮截图无缺陷，再强制AC及独立视觉裁决 | 不作为默认草图路径；设计探索按明确需求启用，有结果后由用户判断方向 |
| 草图绑定全部F/W/AC状态 | 从默认视觉生成中拆走这份完整验收工作；实际功能验收保留独立的需求依据和运行证据 |
| 原型统一要求横向故事tab、每项P0都做JS模拟 | 不照搬固定布局或一律做交互原型；按用户目标决定静态外观还是交互演示 |
| 驱动注册、版本绑定、环境预检、真实结果解析 | 保留；这些代码保证错误/未执行不能冒充通过，减少它们不能靠删除校验实现 |
| 每项测试都要求真人单次批准 | 不直接照搬到Bloma已授权的自动执行范围；执行权限、付费和不可逆边界由既有宿主策略掌握 |

源码依据：[基础Agent提示词](https://github.com/orphiczhou/Proma-Easy/blob/df23df7d121d349e6a58365f3207e9b0047c59c5/apps/electron/src/main/lib/agent-prompt-builder.ts#L1) 明确静态提示词只描述运行时或schema未强制的行为，但 [向导任务构造](https://github.com/orphiczhou/Proma-Easy/blob/df23df7d121d349e6a58365f3207e9b0047c59c5/apps/electron/src/main/lib/nanju-router-prompt.ts#L396) 又注入了较重的阶段和审计流程；第608行要求原型连续两轮截图检查，第643行起要求AC。故该分支也需要取舍，不能整体照搬。其 [执行器](https://github.com/orphiczhou/Proma-Easy/blob/df23df7d121d349e6a58365f3207e9b0047c59c5/apps/electron/src/main/lib/nanju-engineering-execution.ts#L173) 将注册、批准、执行、版本检查与结果解释放在宿主侧，值得借鉴。部分 [Windows服务执行](https://github.com/orphiczhou/Proma-Easy/blob/df23df7d121d349e6a58365f3207e9b0047c59c5/apps/electron/src/main/lib/nanju-engineering-service.ts#L1) 仍明确blocked，也不能当作Windows桌面交付的直接基线。

## 建议第一批删减（待实施）

默认草图路径收为：需求与使用目标 → 一个可渲染HTML → 用户看图反馈。自动双候选、截图裁判、再改稿、再投票改为可选设计探索。F/W/AC全量映射与业务失败状态解释不与HTML同轮输出，移到实际实现和验收阶段。

默认执行路径保持一个主Agent连续工作，宿主保存状态、控制权限与预算、执行真实验证。AC、多角色架构论证与额外文档按风险或用户要求启用。删减前逐项确认哪些门由真实代码消费，不能只删文案而留下不可满足的门，也不能删门后继续报告同等验证强度。

## 工程验证

- 相关向导、UX、用户输出、桌面路由回归：35文件 / 295项通过，`run-artifacts/ux-fallback-fix-regression.log`。
- 随后限制“仅明确重试可复用预览，新修改意见必须重新生成”，最后增量回归4文件 / 59项通过，`ux-fallback-fix-final-delta.log`。与上述套件重叠，不相加。
- 最终类型检查、应用构建、文档检查通过，分别见`ux-fallback-fix-types-final.log`、`ux-fallback-fix-build-final.log`及最终主进程重建`ux-fallback-fix-main-final.log`、`ux-fallback-fix-docs.log`；原生隔离启动证据见`ux-fallback-fix-electron.log`。
- 本次未重跑全库全部测试，未新增付费模型请求。当前通过本地替身流、真实临时文件与原生渲染验证修复，不能由此推断真实模型重跑的费用或产品质量。复盘中保留的历史候选未自动替换用户项目，也没有替用户确认或开工。
