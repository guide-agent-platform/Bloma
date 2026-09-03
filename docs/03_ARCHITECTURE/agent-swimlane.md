# 全流程 Agent 调用泳道图

> 文档 ID：DOC-3.7 | 日期：2026-09-02 | 状态：已绘制（对照 sprint2 分支 HEAD 代码实况）
> 依据：2026-08-30 组会决议 5「补画泳道图：画出整个流程中不同 Agent 之间的调用关系（含委派结构）」
> 关系：补充 `architecture.md` §3 总体架构（模块分层视角）与 `sequence-diagrams/`（IPC 时序视角）——
> 本文以 **Agent 角色** 为泳道，回答"谁在什么时候调用谁"。

---

## 0. 术语约定（决议 8）

| 术语 | 含义 | 代码对应 |
|---|---|---|
| 向导 Agent | 需求澄清/PRD 前移/确认卡的主对话 Agent（guide 渠道） | `guide-agent-service.ts` |
| 编程 Agent（=「编程 A」主技能） | MVP 生成的主 Agent 循环（code 渠道），**不是单个子工具** | `agent-loop.ts` + `agent-tools.ts`，由 `programming-orchestrator.ts` 编排 |
| 裁判 Agent | MVP 终审（规则引擎 + 语义腿，audit 渠道） | `judge-engine.ts` + `judge-semantic.ts` |
| 内审子流程 | PRD 生成后的 AC-Lite 攻击→修订→复核闭环（audit 渠道，独立于生成渠道做厂商隔离） | `prd-review.ts` + `prd-defender.ts` |
| 委派子 Agent | 编程 Agent 通过 `delegate_agent` 工具派出的**后台子循环**（非新会话） | `agent-collaboration.ts`（`DelegationRole`：explore/research/implement/review/custom） |
| Harness 调度层 | 主进程各编排服务（非独立"调度 Agent"；决议 9：优先换皮渲染，不重造调度轮子） | `ipc.ts` / `guide-agent-service.ts` / `programming-orchestrator.ts` / `category-routing.ts` |

---

## 1. 主流程泳道图（需求 → PRD → 内审 → 草图 → MVP → 裁判 → 交付/迭代）

```mermaid
flowchart LR
  subgraph LANE_U["泳道 1｜用户（渲染端弹窗与对话区）"]
    direction TB
    U1["① 提需求 / 多轮澄清"]
    U2["③ 需求确认卡<br/>勾选子集·灵感采纳·参考链接"]
    U3["⑦ PRD 确认卡<br/>累计池批量修改"]
    U4["⑨ 草图预览确认"]
    U5["⑬ 使用 MVP / 反馈"]
    U6["⑮ 审查选择题卡 / 让渡卡"]
    U0["⛔ 停止（任意时刻）"]
  end

  subgraph LANE_H["泳道 2｜Harness 调度层（主进程编排）"]
    direction TB
    H4["ipc + backgroundRun<br/>AbortSignal 贯穿各阶段<br/>项目级互斥 AGENT_PROJECT_BUSY"]
    H1["guide-agent-service<br/>会话编排·收敛判定<br/>runPrdPipeline"]
    H3["programming-orchestrator<br/>草图 / MVP / 迭代编排"]
  end

  subgraph LANE_G["泳道 3｜向导 Agent（guide 渠道）"]
    direction TB
    G1["② 澄清对话·点选纠错<br/>方向跨轮继承"]
    G2["②a 市调 guide-research<br/>DDG 失败→必应回退"]
    G3["②b 灵感提炼 LLM→ideas"]
    G4["⑥ PRD 生成 prd-engine-llm<br/>工程模板注入③ few-shot"]
  end

  subgraph LANE_A["泳道 4｜内审子流程（audit 渠道·厂商隔离）"]
    direction TB
    A1["⑤ 攻击轮 Attacker<br/>六维 I/F/Z/U/L/G"]
    A2["⑤a Defender 修订<br/>仅写内存草稿副本<br/>代码级校验（锚点/id/护栏）"]
    A3["⑤b 复核轮 Recheck<br/>只验旧 issue 消除+新伤"]
  end

  subgraph LANE_C["泳道 5｜编程 Agent（MVP Loop·code 渠道）"]
    direction TB
    C1["⑩ Agent Loop<br/>compacting-window·钉轮·收口<br/>工程模板注入⑥ tech_skeleton"]
    C2["⑪ 沙箱工具<br/>read/write/edit<br/>run_preview/web_fetch"]
    C4["⑫ GWT 测试链<br/>EARS 断言→Gherkin feature<br/>→gwt-runner Playwright 执行"]
  end

  subgraph LANE_D["泳道 6｜委派子 Agent（后台子循环）"]
    direction TB
    D1["explore 只读侦察"]
    D2["research 联网调研"]
    D3["implement 实现分工"]
    D4["review 交叉审查"]
  end

  subgraph LANE_J["泳道 7｜裁判 Agent（audit 渠道）"]
    direction TB
    J1["⑭ 规则引擎先行<br/>PRD 背板/GWT 覆盖/P0 可满足"]
    J2["⑭a 语义腿（全绿后）<br/>逐功能项 implemented/<br/>partial/missing/deviated"]
  end

  U1 --> G1
  G1 --> G2
  G1 --> G3
  G1 -->|"判定需求成型"| H1
  H1 -->|"user_decision_required"| U2
  U2 -->|"confirm（含勾选/采纳）"| H1
  H1 --> G4
  G4 --> A1
  A1 -->|"blocking/major 且预算内"| A2
  A2 --> A3
  A3 -->|"未收敛→两轮熔断"| U6
  A3 -->|"收敛→修订稿重落检查点"| U3
  U3 -->|"批量修改→修订回流 runPrdPipeline"| G4
  U3 -->|"确认无误"| H3
  H3 -->|"runSketchTask·模板注入⑤"| U4
  U4 -->|"确认草图"| H3
  H3 --> C1
  C1 <--> C2
  C1 -->|"delegate_agent（后台子循环）"| D1 & D2 & D3 & D4
  D1 & D2 & D3 & D4 -->|"digest『结论:』回流"| C1
  C1 --> C4
  C4 -->|"test-report"| J1
  C1 -->|"mvp_delivered 前置门禁"| J1
  J1 -->|"全绿"| J2
  J2 -->|"通过"| U5
  J2 -->|"退回（限次）"| C1
  J1 -->|"超限/不可修"| U6
  U5 -->|"反馈→runIterationTask"| H3
  U0 --> H4
  H4 -.->|"abort 信号"| H1 & H3 & C1 & A1 & J1
```

**读图要点**：
- **两道用户过目门**：需求确认卡（③）与 PRD 确认卡（⑦）之间隔着内审闭环——先机器互搏（攻击→修订→复核），再请用户过目，不再把审查工作丢给编程 Agent（8/30 质询点 4 已纠正）。
- **内审渠道独立**（泳道 4）：audit 类别渠道与 PRD 生成渠道分属不同厂商时记 `vendor_isolated=true`；审查族回退 `routed-only`，绝不静默落到任意弱模型。
- **委派即后台子循环**（泳道 6）：编程 Agent 在 Loop 内经 `delegate_agent` 派出，子 Agent 最终回复以「结论：」开头供 digest 提取——**不是新建会话**（8/30 质询点 6 结论）。
- **裁判双段门禁**（泳道 7）：规则引擎不过就不跑语义腿（省 token）；语义腿跑 audit 渠道，与内审共用审查渠道路由但 prompt/维度刻意区分。

---

## 2. 委派结构细图（后台子 Agent 树）

```mermaid
flowchart TD
  MAIN["主会话（每会话=一个顶层运行，项目级互斥）<br/>guide 或 MVP Loop 主循环"]
  MAIN -->|"delegate_agent·explore"| E["子循环 A｜explore<br/>只读工具（read/list/grep）<br/>产出：现状侦察结论"]
  MAIN -->|"delegate_agent·research"| R["子循环 B｜research<br/>只读+web_fetch<br/>产出：调研结论"]
  MAIN -->|"delegate_agent·implement"| I["子循环 C｜implement<br/>全量 9 工具<br/>产出：『结论：』+ 变更摘要"]
  MAIN -->|"delegate_agent·review"| V["子循环 D｜review<br/>读+运行测试<br/>产出：审查结论"]
  E & R & I & V -->|"digest 提取（『结论：』句式）"| MAIN
  MAIN -->|"abort 超时 5s 摘除 hang 子循环<br/>崩溃自动标 cancelled + settle"| PERSIST["delegation-persistence<br/>JSONL 落盘·启动对账·continue 重放"]
```

委派生命周期：派发 → 落盘 → （超时 abort / 崩溃标记 cancelled+settle / 正常完成）→ 启动对账自动收口。

---

## 3. 渠道三角色路由（横切机制）

| 类别 | 归属角色 | 渠道 | 说明 |
|---|---|---|---|
| guide / prd / summary | 向导 | 用户主渠道 | 澄清、PRD、总结 |
| sketch / mvp | 编程 | 编程渠道 | 草图、MVP Loop |
| judge / audit | 裁判（审查） | audit 独立渠道（可配备用链） | 内审 + 终审语义腿；厂商隔离判定在 `guide-agent-service` L1220 |

---

## 4. 与导师架构建议的对照（8/30 质询点 6）

| 导师建议 | 当前实现 | 差距与方向 |
|---|---|---|
| 最上层设调度 Agent | 调度在 harness 服务层（`guide-agent-service` / `programming-orchestrator`），非 LLM 调度 Agent | 决议 9 采"换皮渲染"路线：每会话视作 Agent 由调度层统一调度，不动会话管理底层——图中泳道 2 即该调度层 |
| 把每个会话看作 Agent 调度，仅表层渲染 | 会话=顶层运行单位，项目级互斥已实现 | 渲染端已按会话维度组织（atoms family）；表层换皮继续演进 |
| 委派=后台子 Agent | ✅ 已按此实现（泳道 6/§2） | 无差距 |

---

## 5. 维护约定

- 本图随主流程变更同步更新（变更点涉及：确认卡出口、内审闭环、委派角色集、裁判门禁、渠道路由）。
- 模块级调用细节看 `sequence-diagrams/*.puml`；数据结构看 `data-model.md`；本文只回答角色间调用关系。
