# 科研计划

> 项目：向导 Agent 多智能体协同开发平台  
> 文档ID：DOC-5.2  
> 版本：v1.0 | 日期：2026-07-10 | 状态：已完成  
> 依赖：DOC-1.1 `user-stories.md`、DOC-3.4 `data-model.md`、DOC-4.1 `api-spec.md`、DOC-5.1 `sprint-plan.md`

---

## 1. 研究目标

本研究关注自然语言驱动的软件生成平台如何降低零基础用户完成软件原型和 MVP 的门槛。平台以 Proma fork 为底座，通过向导 Agent、编程 Agent、裁判 Agent、预览优先交互、点选纠错、快照回滚和 GWT 门禁形成完整闭环。

研究目标：

- 衡量零基础用户从想法到可运行 MVP 的完成效率。
- 比较“预览优先 + 点选纠错”相对传统文本对话的理解成本。
- 评估自动测试、裁判门禁和自愈回滚对交付质量的影响。
- 分析快消型与长期迭代型两种模式的适用边界。
- 形成可复用的自然语言软件生成交互范式和工程治理框架。

---

## 2. 研究问题

| 编号 | 研究问题 | 核心指标 |
|---|---|---|
| RQ1 | 两道门模式是否能帮助零基础用户更快进入合适的软件生成流程？ | 模式选择耗时、模式切换/升级率、完成率 |
| RQ2 | 验证草图是否能降低用户确认需求的成本？ | FIRT、草图确认率、草图纠错次数 |
| RQ3 | 点选纠错是否比纯文本描述更有效地表达修改意图？ | 纠错成功率、同一区域重复纠错次数、每轮修改耗时 |
| RQ4 | GWT 测试、裁判门禁和自动修复是否提升 MVP 可交付质量？ | GWT 通过率、裁判通过率、自动修复成功率、熔断率 |
| RQ5 | 快照与回滚是否提升用户安全感和继续尝试意愿？ | 回滚使用率、回滚后继续率、满意度、放弃率 |

---

## 3. 实验设计

### 3.1 实验对象

| 用户组 | 定义 | 招募目标 |
|---|---|---|
| P0 用户 | 无编程经验，不理解前后端、数据库、测试等概念 | 12-20 人 |
| P1 用户 | 有基础概念但不写代码 | 6-10 人 |
| 研究用户 | 课题组成员或研究者，只查看数据和访谈材料 | 3-5 人 |

Phase 1 主要验证 P0 用户闭环；P1 用户用于对照理解专业概念是否影响效率。

### 3.2 实验任务

| 任务 | 示例 | 难度 |
|---|---|---|
| T1：个人小工具 | 家庭记账、本周待办、健身记录 | 低 |
| T2：信息管理工具 | 图书/笔记/客户信息管理 | 中 |
| T3：带统计的管理页 | 销售统计、预算看板、课程报名 | 中高 |

每位参与者完成 1 个主任务，必要时追加 1 个纠错任务。

### 3.3 对照条件

| 条件 | 说明 |
|---|---|
| 实验组 A | 使用本平台完整体验：两道门、草图、预览、点选纠错、快照回滚 |
| 对照组 B | 使用普通 AI 对话式生成流程：用户用文本描述需求，查看代码或生成说明 |
| 对照组 C | 使用本平台但关闭点选纠错，仅允许文本描述修改 |

Phase 1 最小可行实验先做 A/B；若样本充足，再加入 C 以单独评估点选纠错。

### 3.4 实验流程

1. 参与者填写背景问卷。
2. 研究者说明任务目标，不讲解技术概念。
3. 参与者独立使用工具完成任务。
4. 系统记录埋点、快照、测试和裁判结果。
5. 参与者填写满意度和安全感问卷。
6. 半结构访谈 10-15 分钟。
7. 研究者脱敏导出数据进行分析。

---

## 4. 指标体系

### 4.1 核心效率指标

| 指标 | 定义 | 计算方式 |
|---|---|---|
| FIRT | First Interactive Result Time，首次可交互草图时间 | `sketch_generated.created_at - project_created.created_at` |
| Time-to-MVP | 从创建项目到 MVP 可运行的时间 | `mvp_delivered.created_at - project_created.created_at` |
| 澄清轮次 | 用户首次输入到开始草图生成的对话轮数 | `conversation_submitted` 计数 |
| 纠错轮次 | 从草图或 MVP 到用户满意的修改轮数 | `point_correction` 计数 |

### 4.2 质量指标

| 指标 | 定义 | 计算方式 |
|---|---|---|
| GWT 通过率 | GWT 场景通过比例 | `passed_count / total_count` |
| 裁判通过率 | 裁判输出 pass 的比例 | `judge_verdict.pass / judge_verdict.total` |
| 自动修复成功率 | 自修复后恢复正常的比例 | `repair_success / self_repair_triggered` |
| 熔断率 | 自动修复达到上限并回滚的比例 | `rollback_after_repair / self_repair_triggered` |

### 4.3 用户体验指标

| 指标 | 定义 | 数据源 |
|---|---|---|
| 完成率 | 用户完成任务并标记项目完成 | `project_finalized` |
| 放弃率 | 用户中途关闭或放弃项目 | 项目状态 + 会话终止 |
| 回滚后继续率 | 用户回滚后继续修改或生成 | `user_undo` 后续事件 |
| 满意度 | 用户对最终结果打分 | `satisfaction_marked` |
| 安全感 | 用户是否觉得“搞坏了能恢复” | 问卷 + 访谈 |

---

## 5. 13 类埋点到指标映射

| 事件类型 | 关键字段 | 支撑指标 |
|---|---|---|
| `project_created` | `project_id`、`mode`、`template_type`、`created_at` | 样本量、模式分布、FIRT 起点、Time-to-MVP 起点 |
| `conversation_submitted` | `session_id`、`stage`、`message_length`、`created_at` | 澄清轮次、对话负担、阶段停留 |
| `guide_role_switched` | `from_role`、`to_role`、`stage`、`latency_ms` | 角色切换成本、内部编排效率 |
| `sketch_generated` | `project_id`、`duration_ms`、`page_count`、`snapshot_id` | FIRT、草图复杂度、草图成功率 |
| `mvp_delivered` | `project_id`、`duration_ms`、`test_summary`、`snapshot_id` | Time-to-MVP、MVP 成功率 |
| `user_undo` | `snapshot_id`、`reason`、`stage` | 回滚使用率、回滚后继续率 |
| `point_correction` | `target_type`、`fallback_mode`、`repeat_count`、`duration_ms` | 纠错效率、重复纠错、点选命中率 |
| `mode_upgraded` | `from_mode`、`to_mode`、`snapshot_id` | 快消升级长期比例、模式适配性 |
| `programming_execution` | `task_type`、`duration_ms`、`status`、`error_type` | 编程成功率、失败类型、耗时 |
| `self_repair_triggered` | `reason`、`attempt_count`、`result` | 自动修复成功率、熔断率 |
| `judge_verdict` | `verdict`、`hard_failed_count`、`soft_failed_count` | 裁判通过率、退回原因 |
| `satisfaction_marked` | `score`、`stage`、`comment_masked` | 用户满意度、主观质量 |
| `project_finalized` | `status`、`duration_ms`、`final_mode` | 完成率、放弃率、总体效率 |

---

## 6. 数据治理

### 6.1 存储与导出

- 运行时数据写入 `~/.proma/agent-workspaces/{workspace-slug}/analytics.jsonl`。
- 会话和 Agent 流写入 `agent-sessions/{session-id}.jsonl`。
- 科研导出使用脱敏 CSV；如需统计工具分析，可离线转换为 SQLite。
- SQLite 只作为离线导出格式，不进入产品运行时。

### 6.2 脱敏规则

| 数据 | 处理 |
|---|---|
| 用户原始需求 | 本地保留；科研导出时做实体替换和摘要化 |
| 项目名称 | hash 或替换为序号 |
| 业务 payload | 不进入研究数据 |
| API Key | 永不进入 renderer、日志、埋点和导出 |
| 错误堆栈 | 导出时只保留错误分类 |
| 截图 | 默认不导出；需要单独授权 |

### 6.3 样本偏差标注

研究报告必须标注：

- 数据采集关闭的用户比例。
- 因网络、模型渠道、系统环境失败导致的样本剔除比例。
- P0/P1 用户比例。
- 快消型/长期迭代型比例。
- 任务难度分布。

---

## 7. 分析方法

| 问题 | 方法 |
|---|---|
| A/B 组完成率差异 | 卡方检验或 Fisher 精确检验 |
| FIRT / Time-to-MVP 差异 | Mann-Whitney U 检验或 t 检验 |
| 纠错方式差异 | 纠错轮次、成功率、重复纠错次数对比 |
| 质量门禁效果 | GWT 通过率、裁判退回率、修复成功率趋势分析 |
| 主观体验 | Likert 量表统计 + 访谈主题编码 |

显著性阈值默认 `p < 0.05`。样本不足时不做强结论，只报告效应量和探索性发现。

---

## 8. 论文大纲

### 8.1 题目候选

- Preview-First Natural Language Software Generation for Non-Programmers
- Guided Multi-Agent Software Creation with Visual Correction and Local-First Governance
- From Intent to MVP: A Desktop Agent Workflow for Zero-Code Software Prototyping

### 8.2 论文结构

1. 引言：零基础用户软件生成的门槛与现有 AI 对话工具限制。
2. 相关工作：自然语言编程、Agentic coding、低代码/无代码、BDD、用户可控 AI。
3. 系统设计：两道门、三阶段生成、向导/编程/裁判 Agent、预览优先、点选纠错、快照回滚。
4. 工程实现：Proma fork、IPC 四层、Local-First JSON/JSONL、safeStorage、MCP 工具、GWT 门禁。
5. 研究方法：参与者、任务、A/B 设计、埋点、问卷、访谈。
6. 结果：效率、质量、体验、安全感、模式选择。
7. 讨论：适用边界、失败模式、用户控制感、工程治理。
8. 威胁与局限：样本量、任务类型、模型波动、学习效应。
9. 结论：预览优先多 Agent 工作流对零基础软件生成的贡献。

---

## 9. Phase 路线

| Phase | 研究能力 |
|---|---|
| Phase 1 | 记录 13 类埋点，支持 JSONL 脱敏导出，完成小样本可用性研究 |
| Phase 2 | 增加长期迭代型文档、架构确认、Sprint 规划数据 |
| Phase 3 | 完整点选纠错、升级路径、裁判让渡体验分析 |
| Phase 4 | 上线研究看板、A/B 实验对比、CSV 导出和覆盖率标注 |

---

## 10. 修订记录

| 版本 | 日期 | 修订内容 |
|------|------|----------|
| v1.0 | 2026-07-10 | 首版，定义研究目标、研究问题、实验设计、指标体系、13 类埋点映射、数据治理、分析方法和论文大纲 |
