# 全流程 Agent 调用泳道图

> 文档 ID：DOC-3.7 | 日期：2026-09-02 初绘 | **2026-09-06 修订**（对照 sprint2 分支 HEAD 实况，补：plan 腿、修复回流入口 A/B、终轮退行守卫、API 契约探测、完整程序契约链、就绪引导卡与迭代路由）
> 依据：2026-08-30 组会决议 5「补画泳道图：画出整个流程中不同 Agent 之间的调用关系（含委派结构）」+ 2026-09-06 用户拍板「终点不是 MVP——完整程序 = 前后端分离」
> 关系：补充 `architecture.md` §3 总体架构（模块分层视角）与 `sequence-diagrams/`（IPC 时序视角）——
> 本文以 **Agent 角色** 为泳道，回答 "谁在什么时候调用谁"。

---

## 0. 术语约定（决议 8 + 2026-09-06 增补）

| 术语 | 含义 | 代码对应 |
|---|---|---|
| 向导 Agent | 需求澄清/PRD 前移/确认卡的主对话 Agent（guide 渠道） | `guide-agent-service.ts` |
| PRD 工程腿 | 向导群内的独立工程子代理：dual-form 产出 document+结构化字段+interface_spec 契约（prd 渠道） | `prd-engine-llm.ts` |
| 功能项加厚腿 | 与工程腿并行：薄功能项补 story/行为断言/优先级（三层守卫，接地守卫防编造） | `requirement-enricher.ts` |
| 内审子流程 | PRD 生成后的 AC-Lite 攻击 → 修订 → 复核闭环（audit 渠道，独立于生成渠道做厂商隔离） | `prd-review.ts` + `prd-defender.ts` |
| plan 腿（技术规划腿） | loop 前单轮规划：产出技术合同（目标文件/复用点/验证口径），**契约进任务输入+架构纪律**（数据留存必列 server/routes） | `loop-planner.ts` |
| 编程 Agent（主循环） | MVP 生成的主 Agent 循环（mvp 渠道），**不是单个子工具** | `agent-loop.ts` + `agent-tools.ts`，由 `programming-orchestrator.ts` 编排 |
| 修复回流 | 终验失败后的定向修复：入口 A（终验现场）+ 入口 B（blocked 卡「继续修」，消费 test-report.json） | `repair-loop.ts` |
| 裁判 Agent | MVP 终审（规则引擎 + 语义腿，audit 渠道） | `judge-engine.ts` + `judge-semantic.ts` |
| 委派子 Agent | 编程 Agent 通过 `delegate_agent` 派出的 **后台子循环**（非新会话） | `agent-collaboration.ts`（`DelegationRole`：explore/research/implement/review/custom） |
| 退行守卫 | 终轮「零 tool_use+正文退行」判传输事故：带反馈重试 1 轮，仍脏如实 turn_limit；learnings 源头过滤 | `output-integrity.ts`（`isDegenerateText`） |
| API 契约探测 | 终验侧按 interface_spec 无参 GET 端点逐个探测，404/5xx = 契约失活并入修复回流 | `api-contract.ts` |
| Harness 调度层 | 主进程各编排服务（非独立 "调度 Agent"；决议 9：优先换皮渲染，不重造调度轮子） | `ipc.ts` / `guide-agent-service.ts` / `programming-orchestrator.ts` / `category-routing.ts` |

---

## 1. 主流程泳道图（需求 → PRD → 内审 → 草图 → plan → MVP → 终验 → 交付/迭代/完整程序）

```mermaid
flowchart LR
  classDef user    fill:#e3f2fd,stroke:#1976d2,color:#0d47a1
  classDef harness fill:#fff3e0,stroke:#f57c00,color:#e65100
  classDef guide   fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20
  classDef prd     fill:#fce4ec,stroke:#c2185b,color:#880e4f
  classDef plan    fill:#f3e5f5,stroke:#7b1fa2,color:#4a148c
  classDef code    fill:#ede7f6,stroke:#4527a0,color:#311b92
  classDef deleg   fill:#e0f7fa,stroke:#00838f,color:#004d40
  classDef judge   fill:#fff8e1,stroke:#f9a825,color:#e65100

  subgraph LANE_U["泳道 1｜用户"]
    direction LR
    U1["① 提需求"]
    U2["③ 需求确认卡"]
    U3["⑦ PRD 确认卡"]
    U4["⑨ 草图确认"]
    U5["⑬ 使用 / 反馈"]
    U6["⑮ 审查选择卡 / 让渡卡"]
    U7["⑯ 就绪引导卡"]
    U0["⛔ 停止"]
  end

  subgraph LANE_H["泳道 2｜Harness 调度层"]
    direction LR
    H1["guide-agent-service"]
    H3["programming-orchestrator"]
    H4["ipc + backgroundRun"]
    H5["ready 直答 + 成熟度锚"]
  end

  subgraph LANE_G["泳道 3｜向导 Agent"]
    direction LR
    G1["② 澄清·纠错"]
    G2["②a 市调"]
    G3["②b 灵感提炼"]
  end

  subgraph LANE_A["泳道 4｜PRD 工程腿 + 内审"]
    direction LR
    G4["⑥ PRD 生成"]
    E0["④a 加厚腿"]
    A1["⑤ 攻击轮"]
    A2["⑤a Defender"]
    A3["⑤b 复核轮"]
  end

  subgraph LANE_P["泳道 5｜编程-规划"]
    direction LR
    P1["⑨a plan 腿"]
  end

  subgraph LANE_C["泳道 6｜编程 Agent（Loop）"]
    direction LR
    C0["⑩ 骨架渲染"]
    C1["⑩a Agent Loop"]
    C2["⑪ 沙箱工具"]
    C3["⑫ 交付"]
    C4["⑫a GWT + API 契约"]
  end

  subgraph LANE_D["泳道 8｜委派子 Agent"]
    direction LR
    D1["explore"]
    D2["research"]
    D3["implement"]
    D4["review"]
  end

  subgraph LANE_J["泳道 9｜裁判 Agent"]
    direction LR
    J1["⑭ 规则引擎"]
    J2["⑭a 语义腿"]
  end

  class U1,U2,U3,U4,U5,U6,U7,U0 user
  class H1,H3,H4,H5 harness
  class G1,G2,G3 guide
  class G4,E0,A1,A2,A3 prd
  class P1 plan
  class C0,C1,C2,C3,C4 code
  class D1,D2,D3,D4 deleg
  class J1,J2 judge

  U1 --> G1
  G1 --> G2
  G1 --> G3
  G1 -->|"需求成型"| H1
  H1 -->|"user_decision_required"| U2
  U2 -->|"confirm"| H1
  H1 --> G4
  H1 -.->|"并行"| E0
  G4 --> A1
  A1 -->|"blocking/major"| A2
  A2 --> A3
  A3 -->|"未收敛→熔断"| U6
  A3 -->|"收敛"| U3
  U3 -->|"批量修改"| G4
  U3 -->|"确认无误"| H3
  H3 -->|"runSketchTask"| U4
  U4 -->|"确认草图"| H3
  H3 --> C0
  C0 --> P1
  P1 -->|"技术合同注入"| C1
  C1 <--> C2
  C1 -->|"delegate_agent"| D1 & D2 & D3 & D4
  D1 & D2 & D3 & D4 -->|"结论: 回流"| C1
  C1 -->|"退行重试"| C1
  C1 --> C3
  C3 --> C4
  C4 -->|"test-report"| J1
  J1 -->|"全绿"| J2
  J2 -->|"通过"| U7
  J2 -->|"blocking"| U6
  C4 -->|"首败→修复回流 A"| C2
  C4 -->|"耗尽+健康快照→回滚"| U5
  C4 -->|"耗尽+无快照→让渡"| U6
  U6 -->|"继续修→入口 B"| C2
  U7 -->|"数据上服务端→迭代"| H3
  U7 -->|"导出部署"| EXP["导出：前后端工程 + README"]
  U5 -->|"反馈→runIterationTask"| H3
  U0 --> H4
  H4 -.->|"abort 信号"| H1 & H3 & C1 & A1 & J1
  H5 -.->|"就绪后直答"| U5
```

**读图要点（2026-09-06 增补）**：
- **两道用户过目门**：需求确认卡（③）与 PRD 确认卡（⑦）之间隔着内审闭环——先机器互搏（攻击 → 修订 → 复核），再请用户过目，不再把审查工作丢给编程 Agent（8/30 质询点 4 已纠正）。
- **契约先行（完整程序阶段 2）**：PRD 工程腿产出 interface_spec（数据留存信号词命中即必有，LLM 漏报由 `deriveInterfaceSpec` 确定性兜底）——契约随背板冻结，进 plan 任务输入与 loop 锚定；终验侧 `api-contract` 按契约探测存活，失活并入修复回流。**localStorage 禁令在护栏层锁死：「PRD 说刷新后仍在」不构成例外的理由**。
- **修复回流两入口**：入口 A = 终验首败现场（新鲜失败证据）；入口 B = blocked 卡「继续修」（消费 test-report.json，省一次注定失败的重验）。预算共享 test_repair_count（quick 1 / longterm 2），loop 内 edit-after-failure 预算 3 次。
- **熔断回滚诚实化**：回滚落点是终验失败前的快照，话术如实附加未通过断言清单（failureNote）；无健康快照才让渡 blocked。
- **迭代路由（12cdb87）**：修改确认门后 normalize 判 skip 且上次终验留有失败 → 走定向修复而非整版重摇；无失败快照才重摇。
- **终轮退行守卫**：零 tool_use+正文混入工具调用原文/退行重复 = 传输事故，反馈重试 1 轮，仍脏如实 turn_limit 交终验——垃圾收工轮不再骗到成功话术。
- **就绪引导卡**：ready 收敛发 next_steps 卡（数据上服务端/导出部署）；ready 直答带成熟度事实锚（路由数/data 建用/契约条数/AI 可用性），按差距引导。
- **委派即后台子循环**（泳道 8）：编程 Agent 在 Loop 内经 `delegate_agent` 派出，子 Agent 最终回复以「结论：」开头供 digest 提取——**不是新建会话**（8/30 质询点 6 结论）。
- **裁判双段门禁**（泳道 9）：规则引擎不过就不跑语义腿（省 token）；语义腿跑 audit 渠道，与内审共用审查渠道路由但 prompt/维度刻意区分。

---

## 2. 委派结构细图（后台子 Agent 树）

```mermaid
flowchart TD
  classDef main    fill:#ede7f6,stroke:#4527a0,color:#311b92
  classDef deleg   fill:#e0f7fa,stroke:#00838f,color:#004d40
  classDef persist fill:#fff3e0,stroke:#f57c00,color:#e65100

  MAIN["主会话（每会话=一个顶层运行，项目级互斥）<br/>guide 或 MVP Loop 主循环"]:::main
  E["子循环 A｜explore<br/>只读工具（read/list/grep）<br/>产出：现状侦察结论"]:::deleg
  R["子循环 B｜research<br/>只读+web_fetch<br/>产出：调研结论"]:::deleg
  I["子循环 C｜implement<br/>全量 9 工具<br/>产出：『结论：』+ 变更摘要"]:::deleg
  V["子循环 D｜review<br/>读+运行测试<br/>产出：审查结论"]:::deleg
  PERSIST["delegation-persistence<br/>JSONL 落盘·启动对账·continue 重放"]:::persist

  MAIN -->|"delegate_agent·explore"| E
  MAIN -->|"delegate_agent·research"| R
  MAIN -->|"delegate_agent·implement"| I
  MAIN -->|"delegate_agent·review"| V
  E & R & I & V -->|"digest 提取（『结论：』句式）"| MAIN
  MAIN -->|"abort 超时 5s 摘除 hang 子循环<br/>崩溃自动标 cancelled + settle"| PERSIST
```

委派生命周期：派发 → 落盘 → （超时 abort / 崩溃标记 cancelled+settle / 正常完成）→ 启动对账自动收口。委派深度 1 层（子 agent 禁止再派）；审查族（六维+语义）默认委派子 agent 可视化。

---

## 3. 完整程序契约链（2026-09-06 新增；终点拍板：终点不是 MVP）

**前后端分离的契约流**——每个环节都有确定性的承载物，不依赖模型自觉：

```mermaid
flowchart LR
  classDef prd     fill:#fce4ec,stroke:#c2185b,color:#880e4f
  classDef plan    fill:#f3e5f5,stroke:#7b1fa2,color:#4a148c
  classDef code    fill:#ede7f6,stroke:#4527a0,color:#311b92
  classDef judge   fill:#fff8e1,stroke:#f9a825,color:#e65100
  classDef user    fill:#e3f2fd,stroke:#1976d2,color:#0d47a1
  classDef harness fill:#fff3e0,stroke:#f57c00,color:#e65100

  A["PRD 工程腿<br/>interface_spec 产出<br/>（信号词触发+漏报兜底）"]:::prd
  B["锚定注入<br/>renderBackplaneAnchor<br/>【后端 API 契约】段"]:::plan
  C["plan 腿<br/>架构纪律：filesToTouch<br/>必含 server/routes"]:::plan
  D["Agent Loop<br/>写 server/routes/*.js<br/>（文件名即 /api 前缀，热加载）"]:::code
  E["交付<br/>app server + /api/llm env<br/>+ data/ 目录"]:::code
  F["终验<br/>GWT ?mock=1 + API 契约探测<br/>404/5xx=失活→修复回流"]:::judge
  G["就绪引导卡<br/>数据上服务端 / 导出部署"]:::user
  H["前后端工程 + README<br/>（API 表·BLOMA_APP_LLM_* env）"]:::harness

  A -->|"随背板冻结 prd.json"| B
  B --> C
  C --> D
  D --> E
  E --> F
  F -->|"ready"| G
  G -->|"导出"| H
```

| 环节 | 确定性承载物 | 兜底机制 |
|---|---|---|
| 契约产出 | prd.json `interface_spec` | 信号词（历史/保存/记录/持久/刷新或重开后仍在/清空/收藏/回顾）→ `deriveInterfaceSpec` 派生 records 最小契约 |
| 契约可见 | 锚定【后端 API 契约】段 + plan 任务输入 | 聚焦模式不裁剪；plan 架构纪律字段 |
| 契约实现 | server/routes/*.js（文件名即 /api 前缀，热加载） | loop 护栏禁 localStorage 存业务数据 |
| 契约验证 | api-contract 无参 GET 探测（可达性语义：服务器不可达跳过） | 失败并入 failure_summary → 修复回流 |
| 数据持久 | data/ 目录（原子写） | 快照/回滚「先清空再复制」精确回时点（锁定测试） |
| 真实 AI | /api/llm 同源代理（OpenAI/anthropic 双协议，密钥只进服务器进程 env） | 未配置 503 llm_not_configured，前端失败态兜住；跨站预检 403 |

---

## 4. 工程模板体系（模板资产与注入时机，2026-09-06 增补）

工程模板是「确定性骨架 + 差异化注入」的两层机制：**模板资产** 由平台在确定性时机渲染/注入（不依赖模型自觉），**业务内容** 由编程 Agent 在模板上填充。对应泳道 6 的 C0（loop 前）、C1（注入消费）、C3（交付期接管）。

```mermaid
flowchart LR
  classDef stage0 fill:#f3e5f5,stroke:#7b1fa2,color:#4a148c
  classDef stage1 fill:#fff3e0,stroke:#f57c00,color:#e65100
  classDef stage2 fill:#ede7f6,stroke:#4527a0,color:#311b92
  classDef stage3 fill:#fff8e1,stroke:#f9a825,color:#e65100

  subgraph T0["loop 前（确定性渲染，无 LLM）"]
    S1["骨架包 skeletons/web-fullstack/<br/>manifest（build·files·readonly）<br/>+ index.html + src/styles.css + src/examples/"]
    S2["官方模块库 official-modules/<br/>catalog+源码（web 4 模块/game 4 模块）"]
    S3["类型化模板文档 *.md<br/>personal-tool / web-fullstack / game / desktop-tool"]
  end
  subgraph T1["system 组装期（template-injection 注入点）"]
    I1["① template_meta 随背板<br/>（下游注入路由依据）"]
    I2["② 澄清框架切片"]
    I3["③ PRD few-shot（≤500 token 配额）"]
    I4["⑤ 草图切片"]
    I5["⑥ MVP loop 切片<br/>tech_skeleton/目录约定/依赖白名单"]
    I6["skeletonMap + moduleMap<br/>（文件树+职责+只读声明）"]
  end
  subgraph T2["loop 运行期"]
    W["write/edit 业务文件<br/>src/*、server/routes/* 可写"]
    BAN["托管文件拒绝写：<br/>package.json / static-server.js"]
  end
  subgraph T3["交付期（平台接管）"]
    G1["renderPackageJson / renderStaticServer<br/>（app server：/api/llm 代理 + routes 挂载）"]
    G2["构建门禁：esbuild 按 manifest.build<br/>打包校验模块图（import 错误构建期暴露）"]
  end

  C1L["Agent Loop 在骨架上填充"]

  class S1,S2,S3 stage0
  class I1,I2,I3,I4,I5,I6 stage1
  class W,BAN,C1L stage2
  class G1,G2 stage3

  S1 -->|"renderSkeletonToProject（已存在跳过）"| I6
  S2 -->|"module_rendered 写 src/official-modules/"| I6
  S3 -->|"切片"| I1 & I2 & I3 & I4 & I5
  I6 --> C1L
  C1L --> W
  BAN --> G1
  W --> G2
```

**模板资产清单**：

| 资产 | 位置 | 渲染/注入时机 | 消费者与守卫 |
|---|---|---|---|
| 骨架包（web-fullstack） | `main/templates/skeletons/web-fullstack/` | loop 前 `renderSkeletonToProject`（幂等：已存在跳过，迭代不覆盖） | 编程 Agent 填充实现；`src/examples/` 只读；构建门禁按 `manifest.build` 校验 |
| 官方功能模块库 | `main/templates/official-modules/` | loop 前渲染到 `src/official-modules/`（`module_rendered` 决策，`BLOMA_MODULES` 开关缺省开） | loop 按纪律复制改编（storage-state/modal-dialog/filter-list/form-validation；game：game-loop/fsm-state/input-control/aabb-collision） |
| 类型化模板文档 | `main/templates/{personal-tool,web-fullstack,game,desktop-tool}.md` | 注入点 ②③⑤⑥ 按 `template_meta.type` 切片 | 澄清框架 / PRD few-shot / 草图 pages / loop 目录约定 |
| 模板元信息 | 背板 `template_meta` | 注入点 ① 随背板落盘 | 下游全部注入点路由（GWT 必测类别差异化：game = 状态机/碰撞/胜负边界） |
| 平台托管文件 | `renderPackageJson` / `renderStaticServer` | 交付期渲染（loop 工具被 `agent-tools` 拒绝写） | app server（/api/llm 代理 + server/routes 挂载）与导出 |
| 外置提示词覆盖 | `~/.proma/prompts/{id}.md` | 文件存在即生效，改完即时生效（无需重启） | 对应引擎全量替换内置默认 |

**模板类型（TemplateType）路由**：personal_tool / web_fullstack / game（P1-9）——类型决定骨架选择、模板文档切片、GWT 必测类别与 few-shot 路由；类型由对话/描述推断（游戏/复刻/重制 →game）。

---

## 5. 渠道三角色路由（横切机制）

| 类别 | 归属角色 | 说明 |
|---|---|---|
| guide / prd | 向导 | 澄清、PRD 工程腿（prd 独立类别路由） |
| sketch / mvp | 编程 | 草图、MVP Loop、修复轮（mvp 渠道） |
| judge / audit | 裁判（审查） | 内审 + 终审语义腿；厂商隔离判定，审查族回退 routed-only |

---

## 6. 与导师架构建议的对照（8/30 质询点 6）

| 导师建议 | 当前实现 | 差距与方向 |
|---|---|---|
| 最上层设调度 Agent | 调度在 harness 服务层（`guide-agent-service` / `programming-orchestrator`），非 LLM 调度 Agent | 决议 9 采 "换皮渲染" 路线：每会话视作 Agent 由调度层统一调度，不动会话管理底层——图中泳道 2 即该调度层 |
| 把每个会话看作 Agent 调度，仅表层渲染 | 会话 = 顶层运行单位，项目级互斥已实现 | 渲染端已按会话维度组织（atoms family）；表层换皮继续演进 |
| 委派 = 后台子 Agent | ✅ 已按此实现（§2） | 无差距 |

---

## 7. 维护约定

- 本图随主流程变更同步更新（变更点涉及：确认卡出口、内审闭环、委派角色集、裁判门禁、渠道路由、修复回流、完整程序契约链）。
- 2026-09-06 修订对照实况：终轮退行守卫（output-integrity）、API 契约探测（api-contract）、修复回流入口 A/B（repair-loop）、迭代路由（skip+失败快照 → 定向修复）、就绪引导卡（ready_next_steps）均为本日落地。
- 模块级调用细节看 `sequence-diagrams/*.puml`；数据结构看 `data-model.md`；本文只回答角色间调用关系。
