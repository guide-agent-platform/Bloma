# 版本变更记录

> 项目：向导Agent与编程Agent多智能体协同开发平台
> 文档ID：DOC-7.1
> 版本：v1.1 | 日期：2026-07-12 | 状态：待审
> 依赖：PRD v5.0（§17）、全部已确认文档

**v1.1 修订说明**：同步 §5 已知待同步项状态（4 项全部已同步），新增 §5.1 目录结构重组记录。按 `workflow.md §2.4` 走修订流程，待评审后回到已确认。

## 工程修复与联网工具（2026-08-25）

| 属性 | 值 |
|------|-----|
| **状态** | 已确认 |

### 变更内容

**缺陷④修复：后台链路刷新会话索引**
- `[修复]` 编程编排器后台任务（草图/MVP/迭代/终验/让渡恢复）不经 runAgent，agent-sessions.json 索引 updated_at 停在最后一次交互消息（实测后台跑完数小时仍不刷新，历史列表排序失真）——`publish()` 前置节流刷新（同会话 30s 一次，旁路容错不阻断事件）；附带后台链路回填 Project.last_session_id；新增 seam `resetSessionActivityThrottleForTests`

**意图分流放行一致化（遗留待查项闭环）**
- `[修复]` L1 修改词表先于进度子串门：「进度词 + 修改动词」混合句（「做完了没？把按钮换成蓝色」）此前被进度子串门整句吞掉、永远到不了 L1/L3；纯进度句/纯寒暄行为不变
- `[修复]` L3 应答解析死正则：/\b(...|修改|改|...)\b/ 的 \b 仅基于 ASCII \w，中文分支永不命中，模型答「修改」被误判 other（此前只因恰好答 ASCII「modify」侥幸工作）——归一化后整 token 匹配 + ASCII \b 兜底

**Agent Loop 新增 web_fetch 联网只读工具（9 工具）**
- `[新增]` 编程/子/探索角色可用：抓取公网网页/文档→纯文本；SSRF 防护（私网/环回/链路本地/保留段 IP、localhost/.local/.internal、无点主机名拒绝，重定向终态复检）；15s 超时、2MB 响应上限、ACI 截断（缺省 12000 字符）；权限登记 warning（防 URL 夹带数据外发）；api-spec §12.10/§13 同步

**工程卫生**
- `[修复]` 删除陷阱34修复前残留的 `undefined/` 测试污染目录与空目录 `-p/`；README §3.7 失效的 `当前已完成.md` 引用改指 changelog

### 影响评估

- 受影响模块：programming-orchestrator / orchestrator / agent-tools / permission-service / api-spec / README
- 测试：新增 unit 8 例（session-activity-refresh 2 / ready-iteration 意图分流 2 / agent-tools web_fetch 4 含角色裁剪与权限登记断言）；受影响单测全绿；typecheck 0 错、docs:check 过

---

## Sprint 3 项目管理补全 + 多项目预览 + 远程功能整合（2026-08-15）

| 属性 | 值 |
|------|-----|
| **状态** | 已确认（随 `sprint2` push 发布） |

### 变更内容

**项目管理（迁移自 Proma 归档/删除 + 安全独立计数）**
- `[新增]` 项目硬删除 `project:delete`：索引条目 + 项目/文档/快照/事件文件 + 关联会话物理清理，路径安全防护，删除前停沙箱
- `[新增]` 取消归档 `project:unarchive`（archived → active）
- `[新增]` 历史列表「进行中 / 已归档」视角 Tab，`project:list` 增 `scope`（active/archived/all）
- `[新增]` 历史项目行内「归档 / 恢复 / 删除」操作 + 删除二次确认弹窗
- `[新增]` 安全独立计数（PRD §10.5）：`Project.security_repair_count`，repair-engine 新增 `security_error` 类别，上限 3 次不计入普通退回

**多项目预览**
- `[新增]` 多项目预览地址按 project_id 隔离（`previewUrlsAtom`），各项目独立沙箱预览

**澄清选项（对齐协作者工作）**
- `[修改]` GUIDE_SYSTEM_PROMPT 澄清部分以协作者 86ff8eb 版本为准（一个明确问句 + 可点选答案、选项互斥具体、末条固定「你帮我决定」）；本地「澄清选项约束为具体子类型」（c2）因语义重复放弃（`git revert`）

**渠道模型字段**
- `[修复]` 渠道模型取 `name` 而非 `id`（id 是渠道内唯一标识，不能传 API），`buildSdkEnv` 透传 `provider_type`；含 `autoNameProject` 内部字段对齐

**整合协作者已推送工作**
- `[新增]` 决策卡片规范化：澄清选项纠偏 + 修改确认门
- `[修复]` 回滚 EBUSY：沙箱停稳杀净 + rmSync 重试 + cwd 锁根除
- `[新增]` 需求确认后自动命名：LLM 起名 + 口述前缀剥离兜底

**工程/测试**
- `[修复]` S2-PROJECT-001 E2E mock 补齐（`getFirstEnabledChannel` + `buildSdkEnv` PATH + `getSdkQuery` 确定性 LLM 响应）
- `[新增]` 声明 `@playwright/test` E2E 依赖（此前未声明，依赖 node_modules 残留）
- `[修复]` `npm audit fix` 修复 nanoid/postcss（extract-zip 需 electron breaking 升级，记录豁免）

### 影响评估

- 受影响文档：DOC-4.1 `api-spec.md`（v1.2，补 `project:unarchive`/`project:delete`/`project:list` scope）
- 受影响模块：project-service / repair-engine / ipc / preload-bridge / ProjectHistoryPage / App / programming-orchestrator / guide-agent-service / agent-atoms / platform-services / session-service / orchestrator / shared-types
- 测试：新增 S3-PROJECT-001~017 + 协作者测试（auto-name / guide-agent-service / orchestrator-ready-iteration / platform-services）；`npm run test:all` 全绿
- 是否需要回滚测试：是（归档/删除/回滚路径已覆盖）

### 协作备注

- 本次 push 通过 `git merge origin/sprint2` 整合协作者 bukejiegg 的 3 个 commit（决策卡片规范化 / 回滚 EBUSY 修复 / 需求自动命名）
- 本地「澄清选项约束」（c2）与协作者版本语义重复，已 `git revert` 放弃
- 作者 email 已统一为 `leiyuwan22@gmail.com`（filter-branch 修正），备份分支 `backup-sprint2-pre-push` 保留

---

## 1. 版本号规则

本项目采用**语义化版本**（Semantic Versioning）：`主版本.次版本.修订号`

| 版本号段 | 递增条件 | 示例 |
|---------|---------|------|
| **主版本**（MAJOR） | 产品核心定位或交互范式发生根本性变更；架构推翻重来；不再向后兼容 | v1→v2：从"预览确认"切换为其他确认方式 |
| **次版本**（MINOR） | 新增 Phase 或重大功能模块；新增 Agent 角色；模板扩充；文档目录结构重大调整 | v1→v1.1：新增 PlantUML 代码一致性校验 |
| **修订号**（PATCH） | 文档修订、bug 修复、文案调整、小幅功能改进 | v1.1→v1.1.1：修正 FIRT 计时描述 |

### 1.1 版本状态标记

| 标记 | 含义 |
|------|------|
| `-draft` | 草稿，仍在编写中 |
| `-rc.N` | Release Candidate 第 N 版，待最终确认 |
| （无后缀） | 正式发布版 |

### 1.2 文档版本与代码版本的对应

设计阶段仅产文档，不产代码。文档自身的版本与未来代码版本分开管理：

- **文档版本**：本文档追踪。每份文档独立版本号（在文档元信息中标注）
- **代码版本**：进入实现阶段后启用 git tag，格式同语义化版本

进入 Phase 1 实现后，`changelog.md` 将同时记录文档版本变更和代码版本变更。

---

## 2. 变更分类

| 分类 | 前缀 | 说明 |
|------|------|------|
| **新增** | `[新增]` | 新增文档、功能、模块、角色、规则 |
| **修改** | `[修改]` | 修改已有内容 |
| **修复** | `[修复]` | 修正错误 |
| **移除** | `[移除]` | 删除已有内容 |
| **废弃** | `[废弃]` | 标记为即将移除但仍暂时保留 |

---

## 3. PRD 版本历史

本 PRD 经历五个大版本迭代。以下记录基于 PRD v5.0 §17 并补充上下文。

### v5.0（当前版本）

| 属性 | 值 |
|------|-----|
| **日期** | 2026-05-31 |
| **状态** | ✅ 已确认 |
| **修订人** | 项目组（经导师对齐后定稿） |

**核心变更**（相对 v4.0）：

- `[修改]` **恢复两道门设计**：快消型与长期迭代型作为两个独立入口，重新分离两套文档深度、PlantUML 使用、裁判严格度、退回次数上限和角色激活规则
- `[修改]` **UML 格式切换为 PlantUML**：`.puml` 机读格式替代之前的轻量类图方案
- `[修改]` **测试体系升级为 BDD+GWT**：采用 Gherkin 格式，替代之前的自然语言测试
- `[新增]` §3.4 恐惧点对照表（6 条恐惧点 → 产品应对）
- `[新增]` §4.3 模式对比表（9 个维度逐项对比两种模式）
- `[新增]` §6.5 测试 Agent 与裁判 Agent 的职责边界
- `[新增]` §7.2/7.3 两种模式文档目录完整对比
- `[新增]` §10.2 按模式区分的硬约束规则表
- `[新增]` §12.2 模板推断规则（4 种用户表述 → 模板）
- `[新增]` §12.5 模板配置结构示例（Web 全栈）
- `[新增]` §13.2 启动体验：模式选择页的语言设计
- `[新增]` §13.6 心理防御文案表（9 个关键场景文案）
- `[新增]` §14.4 13 个关键埋点事件清单
- `[修改]` §16 开发路线图细化为 4 个 Phase 各含子任务表
- `[新增]` 文档末尾总结：v5.0 核心立场声明

### v4.0

| 属性 | 值 |
|------|-----|
| **日期** | 2026-05-30 |
| **状态** | 已废弃（被 v5.0 替代） |

**核心变更**（相对 v3.0）：

- `[修改]` **确立"速度即质量"为核心设计立场**（§2.1）：FIRT < 60s 作为最高优先级设计约束
- `[新增]` 三阶段生成模型（验证草图 → MVP → 迭代打磨）
- `[修改]` 取消两道门，改为运行时开关（版本内切换模式）—— 后被 v5.0 推翻
- `[新增]` 用户最终裁量权（§2.5、§10.4）
- `[修改]` PlantUML 在草图阶段不介入，MVP 阶段由向导 Agent 产出轻量类图约束编程 Agent
- `[修改]` 独立重构全文结构，以设计理念推导替代功能堆叠

### v3.0

| 属性 | 值 |
|------|-----|
| **日期** | 2026-05-30 |
| **状态** | 已废弃 |

**核心变更**（相对 v2.0）：

- `[新增]` 参照导师版补充：完整文档体系（7 个目录）
- `[新增]` PlantUML 强约束层（§9）
- `[新增]` 裁判 Agent 机制（§10）
- `[新增]` PRD-测试强对应体系（BDD + GWT）（§11）
- `[新增]` 工程模板体系（§12）

### v2.0

| 属性 | 值 |
|------|-----|
| **日期** | 2026-05-30 |
| **状态** | 已废弃 |

**核心变更**（相对 v1.0）：

- `[移除]` Agent 精简约 50%——从 7 个 Agent 缩减为双 Agent 体系 + 独立裁判模块
- `[移除]` 技术细节正文中不再描述具体代码实现方式
- `[修改]` Phase 规划重新排布
- `[修改]` 科研指标从固定百分比修正为统计显著性检验（p < 0.05）

### v1.0

| 属性 | 值 |
|------|-----|
| **日期** | 2026-05（原始版） |
| **状态** | 已废弃 |
| **作者** | 学生初版 |

**已知问题**（据 v2.0 修订说明）：
- 7 Agent 架构过重，角色边界模糊
- 技术细节过多，偏离需求文档定位
- 功能膨胀，超出 MVP 范围
- 科研指标缺乏统计严谨性

---

## 4. 设计阶段文档版本总表

以下记录设计阶段所有文档的当前版本。日期截止 2026-07-10。

### 4.1 第零层：基础文档

| 文档 | 文档ID | 版本 | 日期 | 状态 |
|------|--------|------|------|:--:|
| 产品需求文档 | PRD | v5.0 | 2026-05-31 | ✅ 已确认 |

### 4.2 第一层：需求细化

| 文档 | 文档ID | 版本 | 日期 | 状态 |
|------|--------|------|------|:--:|
| 用户故事 | DOC-1.1 | v0.1 | 2026-06-06 | ⚠️ 待同步（内容已完成，元信息待更新） |
| 术语表 | DOC-1.2 | v1.0 | 2026-07-10 | ✅ 已确认 |

### 4.3 第二层：UX 设计

| 文档 | 文档ID | 版本 | 日期 | 状态 |
|------|--------|------|------|:--:|
| 站点地图 | DOC-2.1 | v0.4 | 2026-06-06 | ⚠️ 待同步（内容已完成，元信息待更新） |
| 用户流程 | DOC-2.2 | v1.0 | 2026-07-10 | ✅ 已确认 |
| 线框原型（6 个 HTML） | DOC-2.3 | v1.0 | 2026-07-10 | ✅ 已完成 |
| 设计系统 | DOC-2.4 | v1.0 | 2026-07-10 | ✅ 已确认 |
| 交互规格 | DOC-2.5 | v1.0 | 2026-07-10 | ✅ 已确认 |

### 4.4 第三层：架构设计

| 文档 | 文档ID | 版本 | 日期 | 状态 |
|------|--------|------|------|:--:|
| 架构设计 | DOC-3.1 | v1.2 | 2026-07-10 | ✅ 已确认（Proma core 对齐） |
| 组件设计 | DOC-3.2 | v1.2 | 2026-07-10 | ✅ 已确认（Proma core 对齐） |
| Prompt Engineering | DOC-3.3 | v1.1 | 2026-07-10 | ✅ 已确认（Proma core 对齐） |
| 数据模型 | DOC-3.4 | v1.1 | 2026-07-10 | ✅ 已确认（Proma core 对齐） |
| 核心类图 | (puml) | v1.1 | 2026-07-10 | ✅ 已完成（Proma core 对齐） |
| 时序图（5 个） | (puml) | v1.1 | 2026-07-10 | ✅ 已完成（Proma core 对齐） |

### 4.5 第四层：接口与规划

| 文档 | 文档ID | 版本 | 日期 | 状态 |
|------|--------|------|------|:--:|
| API 接口规范 | DOC-4.1 | v1.1 | 2026-07-10 | ✅ 已确认 |
| Sprint 计划 | DOC-5.1 | v1.1 | 2026-07-10 | ✅ 已完成（三人分工修正） |
| 团队角色配置 | DOC-5.2 | v1.0 | 2026-07-10 | 🟡 待审（本次新增） |
| 科研计划 | (同 DOC-5.2 编号) | v1.0 | 2026-07-10 | ✅ 已完成 |
| 开发工作流 | DOC-5.3 | v1.0 | 2026-07-10 | 🟡 待审（本次新增） |

### 4.6 第五层：测试

| 文档 | 文档ID | 版本 | 日期 | 状态 |
|------|--------|------|------|:--:|
| 测试计划 | DOC-6.1 | v1.0 | 2026-07-10 | ✅ 已完成 |
| GWT Feature（6 个） | DOC-6.2 | v1.0 | 2026-07-10 | ✅ 已完成 |

### 4.7 第六层：版本与总览

| 文档 | 文档ID | 版本 | 日期 | 状态 |
|------|--------|------|------|:--:|
| 版本变更记录 | DOC-7.1 | v1.0 | 2026-07-10 | 🟡 待审（本次新增） |
| 项目总览 | DOC-8.1 | v1.0 | 2026-07-10 | ✅ 已完成 |

---

## 5. 已知待同步项

> **状态说明**：本节登记设计阶段收口时（2026-07-10）遗留的待同步项。每一项完成时记录同步日期。

| # | 文档 | 问题 | 建议操作 | 同步状态 |
|---|------|------|---------|:---:|
| 1 | `user-stories.md` | 元信息状态标"草稿 v0.1"，日期 2026-06-06，但内容已定稿 | 更新为 v1.0 / 已确认 / 2026-07-10 | ✅ 2026-07-10 已同步（见 `01_PRD/user-stories.md` 元信息） |
| 2 | `sitemap.md` | 元信息状态标"待审 v0.4"，日期 2026-06-06，但内容已定稿 | 更新为 v1.0 / 已确认 / 2026-07-10 | ✅ 2026-07-10 已同步（见 `02_UX_DESIGN/sitemap.md` 元信息） |
| 3 | `research-plan.md` | 与 `team-config.md` 共用 DOC-5.2 编号 | 建议 `research-plan.md` 改为 DOC-5.2-R（Research 后缀），或独立编号 | ✅ 2026-07-10 已同步（`research-plan.md` 已用 DOC-5.2-R，见 `当前已完成.md`） |
| 4 | 目录结构 | 所有文档平铺在 `docs/` 根目录，清单要求分目录（`01_PRD/`、`02_UX_DESIGN/` 等） | 进入实现阶段前重组目录结构 | ✅ 2026-07-12 已同步（本轮完成，详见下方 §5.1） |

### 5.1 目录结构重组记录（2026-07-12）

**操作**：将 `docs/` 根目录平铺结构重组为官方规范要求的 7 个编号目录。

**最终结构**：

```
docs/
├── 01_PRD/         (3 个文件：prd.md, user-stories.md, glossary.md)
├── 02_UX_DESIGN/   (4 个 .md + wireframes/ 子目录含 6 个 HTML)
├── 03_ARCHITECTURE/(4 个 .md + 1 个 .puml + sequence-diagrams/ 子目录含 5 个 .puml)
├── 04_API_SPEC/    (1 个文件：api-spec.md)
├── 05_PROJECT_PLAN/(5 个 .md：sprint-plan, team-config, research-plan, workflow, role-a-prompt)
├── 06_TESTS/       (1 个 .md + features/ 子目录含 6 个 .feature)
├── 07_VERSIONS/    (1 个文件：changelog.md)
├── README.md       (根目录)
└── 当前已完成.md   (根目录)
```

**附带的引用修复**：
- `role-a-prompt.md` 中的 `docs/xxx.md` 路径全部更新到 `docs/NN_XXX/xxx.md`
- `sitemap.md` 中的 14 处 `[[PRD#...]]` 伪链接更新为 `[[../01_PRD/prd.md#...]]`
- `glossary.md` 和 `sitemap.md` 元信息中的依赖路径从 `PRD/第五阶段prd_v5.md` 更新为 `../01_PRD/prd.md`
- PRD 文件从 `第五阶段prd_v5 (1).md` 重命名为 `prd.md`（去除 Windows 复制产生的 "(1)" 后缀，与官方规范 `01_PRD/prd.md` 一致）

---

## 6. 版本变更模板

后续所有变更按以下模板记录：

```markdown
## vX.Y.Z

| 属性 | 值 |
|------|-----|
| **日期** | YYYY-MM-DD |
| **状态** | [草稿/待审/已确认] |

### 变更内容

- `[分类]` 变更描述（关联文档/模块）
- `[分类]` ...

### 影响评估

- 受影响的文档：[文档ID列表]
- 受影响的模块：[模块名列表]
- 是否需要回滚测试：是/否
```

---

## 7. 代码版本变更记录

> 进入实现阶段后的代码版本修订记录，按时间倒序排列（最新在最前）。对应 git tag 与语义化版本。

### v1.3（2026-08-25）

| 属性 | 值 |
|------|-----|
| **日期** | 2026-08-25 |
| **状态** | 待审 |

**变更内容**（Agent Loop 转正唯一运行时 + 委派协作收尾 + 审计修复 + 废旧管道删除）：

- `[变更]` **Agent Loop 转正**：`BLOMA_AGENT_LOOP` 缺省开启（`=0` 紧急关闭、`=1` 兼容无害），agent loop 成为 MVP 生成唯一运行时；渠道不支持工具循环 / 探测失败 / 探测无结论一律发布用户可见错误并如实抛错，不再静默回退固定管道
- `[变更]` **路由层能力过滤**：`resolveChannelEnv`/`pickBackupChannelEnv` 增 `requireTools`，MVP 类别按 `supports_tools` 过滤（主渠道不支持 → 走备用序，全不支持 → `tools_unsupported`；`undefined` 放行探测）
- `[新增]` **委派协作 M1~M4**：`delegate_agent`/`wait_for_delegations`/`ask_delegation_question`/`answer_delegation` 工具 + 子会话生命周期（`delegation_started`/`delegation_completed`/`delegation_failed` 事件）+ loop 门禁 + judge 终审 + 渲染端协作视图
- `[变更]` **终验门禁 M4-A**：`runAgentLoopPostTesting` 语义固定为「只终验不重修」（GWT → 安全扫描 → judge），loop 内自测自修已用尽修复预算，不给外部修复预算
- `[变更]` **提示词槽位**：废弃 `mvp-system`，新增 `loop-system`（追加模式，覆盖内容 append 在动态 system prompt 之后，背板锚定段不可覆盖）
- `[移除]` **废旧管道**：删除 `mvp-engine-llm.ts` / `mvp-engine.ts` / `repair-engine.ts` 及 `resolveMvp`/`ensureSandboxRunning`/`runPostMvpTestingFlow`/管道回退分支；埋点契约不变只换来源（`self_repair_triggered` → loop `onRepairRound`；`programming_execution` 无新产生点，类型保留向后兼容历史 JSONL）
- `[修复]` 审计报告九项：委派并发/生命周期、一致性、收尾三类（P1/P2/P3）
- `[变更]` **存量项目**：不写迁移代码，切换前 `via_agent_loop=false` 项目在旧版完成（D6）

**影响评估**：

- 受影响的文档：DOC-4.1 api-spec.md（补 `delegation_*` 事件、移除旧管道专属通道）、DOC-3.4 data-model.md
- 受影响的模块：`main/programming-orchestrator.ts`、`main/runtime-fallback.ts`、`main/agent-loop.ts`、`main/agent-tools.ts`、`main/agent-collaboration.ts`、`main/project-scaffold.ts`、`main/prompt-service.ts`、`shared/types.ts`、`main/ipc.ts`
- 删除文件：`main/mvp-engine-llm.ts`、`main/mvp-engine.ts`、`main/repair-engine.ts` 及对应单测/验收
- 是否需要回滚测试：是（`npm run typecheck`、`npm run test:unit`、`npm run test:acceptance:sprint0/2/3`、`npm run docs:check`）

---

### v1.2（2026-08-07）

| 属性 | 值 |
|------|-----|
| **日期** | 2026-08-07 |
| **状态** | 待审 |

**变更内容**（历史对话管理：会话索引与读取 + 前端回访恢复）：

- `[新增]` IPC 通道 `agent:list-sessions` / `agent:load-messages`；共享契约新增 `AgentSessionRecord` / `AgentListSessions(Input|Result)` / `AgentLoadMessages(Input|Result)` 与 `SESSION_NOT_FOUND` 错误码（`shared/types.ts` §6.5）
- `[新增]` `main/session-service.ts`：维护 `agent-sessions.json` 会话索引、best-effort 回填 `Project.last_session_id`、尾部截取历史消息加载（默认排除 `[terminal]` 内部终态行）
- `[修改]` `main/orchestrator.ts` 每次 Agent 运行后调用 `recordSessionActivity` 维护会话索引
- `[修改]` renderer 启动恢复/回访流程：以 `project.last_session_id` 续接会话（不新建 id），调用 `agent:load-messages` 灌入历史、`agent:list-sessions` 灌入会话索引，加载期间对话区显示骨架占位（对齐 sitemap §2.6）
- `[修改]` `renderer/agent-atoms.ts` 全局监听器在收到流事件时同步追加新会话到 `agentSessionsAtom`
- `[修复]` `S0-UI-005` renderer 启动顺序断言：移除 `as any` 与前置分号，统一 store → listeners → render 顺序
- `[移除]` `storage/config-paths.ts` 遗留的 Conversation 命名死代码（`getConversationsIndexPath` / `getConversationPath`），统一术语为 Agent 会话

**影响评估**：

- 受影响的文档：DOC-4.1 api-spec.md（§5.4/§5.5）、DOC-5.1 sprint-plan.md、DOC-3.4 data-model.md（术语对齐）
- 受影响的模块：`shared/types.ts`、`main/ipc.ts`、`main/session-service.ts`、`main/orchestrator.ts`、`preload/bridge.ts`、`renderer/agent-atoms.ts`、`renderer/components/App.tsx`、`WorkspaceShell.tsx`、`ChatPanel.tsx`
- 是否需要回滚测试：是（运行 `npm run typecheck`、`npm run test:acceptance:sprint0`、`npm run test:acceptance:sprint1`）

---

> 本文档从设计阶段起持续维护。进入实现阶段后，每次 Sprint 交付或关键节点均需更新本文档。变更记录按时间倒序排列，最新版本在最前。
