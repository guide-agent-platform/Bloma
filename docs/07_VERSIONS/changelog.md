# 版本变更记录

> 项目：向导Agent与编程Agent多智能体协同开发平台
> 文档ID：DOC-7.1
> 版本：v1.1 | 日期：2026-07-12 | 状态：待审
> 依赖：PRD v5.0（§17）、全部已确认文档

**v1.1 修订说明**：同步 §5 已知待同步项状态（4 项全部已同步），新增 §5.1 目录结构重组记录。按 `workflow.md §2.4` 走修订流程，待评审后回到已确认。

## 指标采集补齐：轮级 usage + 拒因修复分类（2026-10-02）

| 属性 | 值 |
| --- | --- |
| 类型 | feat（竞品对照指标体系的两个采集缺口：#2 段首重建成本 / #4 回炉 token 比 / #9 回炉分类分布） |
| 模块 | `main/agent/loop/agent-loop.ts`（turnsUsage）、`main/desktop/dispatcher-loop.ts`（遥测消费 + deriveRepairClass） |

### 变更内容

- **轮级 usage**：AgentLoopResult 增可选 `turnsUsage`（每次模型调用的渠道返回 usage 按轮登记，与 usageTotals 同源累积）；dispatch 遥测 payload 增 `turns_usage.head3_input_ratio`（前 3 轮 input / 段总 input——段式编排 vs 竞品连续会话的结构性差异度量，连续会话形态应→0）与 `per_turn` 明细。纯增量可选字段，非采集方零感知。
- **拒因修复分类**：`deriveRepairClass` 纯函数把拒收映射到竞品 PE 回炉口径——behavior（driver fail/安全缺陷→回炉 coding）/ mapping（contract-invalid 协议方言错配，不烧 coding 预算）/ coverage（空驱动/场景覆盖不足→补场景）+ structure / environment / confirm（非回炉）/ discipline（推进纪律）；锚定拒收教育稳定前缀（改文案须同步）。进遥测 `repair_class` 字段。

### 影响评估

- 单测 199 文件/1957 例全绿（新增锁定×2：turnsUsage 按轮登记+无 usage 渠道不登记、repair_class 映射与遥测 payload）；typecheck 0 错。
- 指标体系自此可采：#1/#3 段级 usage 已有，#2/#4/#9 本批补齐——下一轮狗粮即可产出「段首重建成本」「回炉 token 比」「回炉分类分布」三张对比表，作为方案 1-4（先跑后聊/同会话续接/确认收敛/driver 任务书）落地优先级的验收基线。

## 狗粮 f277dbf1 复盘修复批：stderr 证据直达 + 竖线锚点方言 + 入口路径口径（2026-10-02）

| 属性 | 值 |
| --- | --- |
| 类型 | fix（狗粮第二轮实测复盘：遥测 18 段，desktop-verify 三连 reject 的根因链修复） |
| 模块 | `main/desktop/dispatcher-loop.ts`、`main/desktop/process-driver.ts` |

### 变更内容

- **driver fail 拒收教育附执行证据**：教育文案只给路由原因不给证据时，修复轮要自己 read 报告重新定位（狗粮三轮 40 轮烧在同一 RecursionError 上）——stderr 尾部摘要（末次异常行 + 首个栈帧，各 160 字符）随教育直达，修复轮零轮次定位。
- **锚点解析兼容竖线方言**：`SCENARIO|<id>|<outcome>|<detail>` 与 `SUMMARY|total=..|pass=..` 行可解析（官方骨架教 PASS/SUMMARY 空格方言，生成物自创竖线方言——不兼容时锚点静默丢失，撞空驱动门）。两方言并存互不干扰，锚点优先裁决语义不变。
- **裁判门③入口路径口径修正**：entry 是应用入口的产物形态声明，桌面骨架标准布局实现文件在 00_IMPLEMENT/ 下（骨架样例 entry:"app.py" 对应 00_IMPLEMENT/app.py）——项目根直下或 00_IMPLEMENT/ 下存在都算，不写死根目录（狗粮实证：app.py 在 00_IMPLEMENT/ 下，写死根会误拒）。
- **狗粮侧直接修复（非本仓库文件）**：项目根 driver.py 薄转发的自导入死循环（`import driver as _impl` 解析回自身，RecursionError ×996）改为 importlib 按路径加载 00_IMPLEMENT/driver.py——修后本地实跑 **7/7 场景全 PASS、exit 0**，四门推演全绿（安全预扫无高危；PRD P0 2 项 ≤ 7 场景；入口 00_IMPLEMENT/app.py 可达）。

### 影响评估

- 单测 199 文件/1955 例全绿（新增锁定×2：stderr 证据直达、竖线方言解析+混用+锚点优先裁决）；typecheck 0 错。
- 遥测 18 段复盘：arch(29+确认)→scaffold(12)→implement(29/40-no-marks/16 三段收敛)→verify 四段——四批修复的机制全部按设计运转（确认凭据链/拒收教育/驱动真实执行/fail-closed）；卡点为生成物两层缺陷（薄转发自递归 + 方言偏离），平台侧证据直达与方言兼容已补。

## 全链路审查修复批四：P0-1 完整版——桌面线裁判门三件套 + 中文锚点实证修复（2026-10-02）

| 属性 | 值 |
| --- | --- |
| 类型 | feat+fix（P0-1 完整版：裁判确定性硬约束桌面化 + verified 快照分级恢复 + 软对账遥测；中文场景锚点解析实证 bug 修复） |
| 模块 | `main/desktop/dispatcher-loop.ts`、`main/desktop/process-driver.ts`、`scripts/probe-glm-stream.cjs` |

### 变更内容

- **裁判门（P0-1a）**：desktop-verify 收口第四道门——judge-engine 确定性硬约束的桌面化子集（对齐 09-26 拍板「验收走驱动执行」，不复活 GWT/LLM 语义腿）：①PRD 背板存在且功能项非空；②驱动场景覆盖（P0 功能项数 ≤ driver 非 skipped 场景数，场景源=回读锚点非自述）；③入口真实存在（contract.entry 文件在产物根）。零渠道依赖 fail-closed；无项目上下文（测试桩）跳过不阻断。
- **verified 快照分级恢复（P0-1b）**：全绿收口（driver pass + 证据门 + 安全门 + 裁判门 + 阶段推进）拍 verification:'verified' 快照——latestVerifiedSnapshot（熔断回滚优先恢复）自此有生产写入方；快照失败不阻断推进（留痕下次可补）。
- **软对账遥测（P0-1c）**：P0 断言与 driver 场景名的 2-gram 滑窗命中对账，只观测不阻断，缺口进 desktop_dispatch_run 遥测（judge_coverage_gaps）——狗粮标定误杀率后再议升硬门。
- **中文场景锚点解析修复（裁判门实证发现）**：parseDriverStdout 锚点正则 `(\S+)\b` 的 \b 在中文字符间不存在词边界——中文名场景静默解析为零场景（既有测试全 ASCII 名从未暴露；狗粮 driver 场景名是中文，裁判门会把全 PASS 中文场景误判零覆盖拒收）。改为 `[^	s:]+`（首段非空白非冒号，主名语义不变）。
- **glm probe 退行采样（记忆挂账清偿）**：probe-glm-stream 补退行检测（与 output-integrity.isDegenerateText 同源判据：工具协议原文混入 + 连续重复 ≥8 单元且覆盖 ≥25%；触发打印单元/次数/占比供参数对比）。HKCU REPAIR_NOOP_GUARD 已确认不存在（开关清理批已清，无需处理）。

### 影响评估

- 单测 199 文件/1952 例全绿（新增锁定×3：干净产物全绿推进+verified 快照、空 PRD 拒收、P0 覆盖不足拒收；既有双门用例补 projectId 修正（实证：旧用例未传 projectId 致 findProject PROJECT_NOT_FOUND、门静默跳过——生产行为一直正确，测试构造缺口））；typecheck 0 错。
- 行为变化：①desktop-verify 收口从「driver pass 即推进」升为四门全绿（空 PRD/覆盖不足/入口缺失拒收，拒收教育闭环引导补齐）；②全绿交付自动落 verified 快照，熔断回滚自此优先恢复已验证版本；③中文场景名 driver 报告可正确解析。
- 挂账（后续批）：取消/工具收尾四件（quiescence 锁释放时序/工具 kill 句柄/web_fetch signal 并联/wait_for_delegations 消费门）；export \* 桩清理；main 集成债；修复循环对齐 Proma-Easy 参照项。

## 全链路审查修复批三：清账（PRD 确认卡 env / sticky P2 / 委派工具面隔离）（2026-10-02）

| 属性 | 值 |
| --- | --- |
| 类型 | fix（审查挂账第三批：PRD 链 P1×2 + 委派跨线 P1×1） |
| 模块 | `main/guide/prd-confirm.ts`、`main/guide/stages/prd-pipeline.ts`、`main/guide/stages/guide-pipeline.ts`、`main/project/prd-store.ts`、`main/agent/delegation/agent-collaboration.ts`、`main/desktop/dispatcher-loop.ts`、`main/review/review-delegation.ts` |

### 变更内容

- **PRD 确认卡 env 断链（P1-10）**：PendingPrdConfirm 补 env 字段随卡挂起；adjust 回传的归一化与 PRD 管线复用同一 env（旧版 env 断链致 normalizer 走词表 fallback，调整文本被当 append 原样追加污染 PRD）；追问定向 revise 同源修复（挂起表本就携带 env，旧版硬编码 undefined 致 LLM 判定从不执行）。与审查卡已修的同款 bug 对齐。
- **模板直写 sticky P2（P1-11）**：构建侧 normalizeRequirement 不再物化 priority 缺省（F-001=P0/其余=P2 兑底移回读取侧 requirementPriority——行为同值）；物化写盘会挡住 enricher 升档（merge「priority 缺才补」），渠道抖动首写全员 P2 后 P0/P1 永补不进。与断言 stripDefaultAssertions 迁移通道对称。
- **委派子工具面跨线隔离（P1-12）**：DelegationParentContext 新增 childToolsBuilder 随父上下文按 sessionId 隔离，优先于全局单例——桌面线（realFullstackVariant 写面）与 review 线（web 组合面）并发时后注册者的全局覆盖不再串面（旧竞态：桌面子会话丢写面拒写 *.py 卡死，或 review 子会话拿到桌面写面）。全局单例保留作缺省（未改造注册方与测试兼容）。

### 影响评估

- 单测 199 文件/1950 例全绿（新增锁定×2：sticky P2 升档恢复、priority 落盘无字段+读取侧兑底；语义更新×1：document-engine 厚形态断言）；typecheck 0 错；prd-store 保持 ≤800 行（R7 只减不增红线未破）。
- 行为变化：①确认卡「有要调整的」文本进入 LLM 归一化（不再原样追加）；②追问答案能真正修到目标项；③渠道恢复重跑后 P0/P1 判定可升档；④双线并发委派不再串工具面。
- 至此全链路审查挂账（除 P0-1 完整版）全部清偿。P0-1 完整版（语义审查对齐 driver 场景）待桌面狗粮 7bc4eeff 收口后按实际卡点设计。

## 全链路审查修复批二：收口双门 + 守卫无条件化 + pending 失效 + worktree 装配（2026-10-02）

| 属性 | 值 |
| --- | --- |
| 类型 | fix（审查挂账清单第二批：P0-1 缓解×2 + P1×3） |
| 模块 | `main/desktop/dispatcher-loop.ts`、`main/agent/loop/agent-loop.ts`（writeGuardEnabled）、`main/agent/tools/agent-tools.ts`、`main/guide/stages/requirement-confirm.ts`、`main/guide/stages/guide-pipeline.ts`、`main/index.ts` |

### 变更内容

- **desktop-verify 收口双门（P0-1 缓解 + P1-5）**：①宿主强制安全扫描门——driver pass 后宿主对产物根强制执行 run_security_scan（含 .py 硬红线），高危/严重命中 → 拒收推进（fail-closed），不再依赖子会话自愿调用；无项目上下文/扫描器异常时跳过留痕（不做可用性单点）。②最低验证证据门——零场景锚点 + 零 SUMMARY 自报的「空驱动」（exit 0 直通）不再作为验证凭据，要求锚点或 SUMMARY 至少其一。driver 纯函数路由语义不变（拦截在收口层）。
- **write 守卫无条件化（P1-4）**：BLOMA_WRITE_GUARD 缺省翻转 off→on（盲覆盖「本轮未读过的既有文件」默认拦截；新建文件不受影响；=0/false 显式逃生口）。同步修边界优先序：只读/系统路径跳过读守卫直接给边界拒绝文案（对只读路径提示「先读再写」是错误指引）。测试同步：同会话连续写用例改共享 ToolState（对齐真实 loop 语义）。
- **需求确认弹窗失效（P1-8）**：handleGuideMessage 入口失效挂起弹窗 pending——弹窗携带弹出时点需求快照，用户继续聊即演化，旧快照确认会 stale 覆盖新需求；失效后旧弹窗点击返回 started:false，新对话收敛出新弹窗（新时点快照）。
- **worktree provider 生产装配（P1-9）**：应用启动入口（main/index.ts）重新装配 setChildRunContextProvider(buildDelegationWorktreeProvider())——web 线拆除时旧 generate.ts 装配点被一并拆掉，BLOMA_DELEGATION_WORKTREE 开关静默 no-op；现在开关 on 真实生效（依赖倒置：coding 构造、agent 注入、编排接线）。

### 影响评估

- 单测 199 文件/1949 例全绿（新增锁定×4：空驱动拒收/安全门拒收/干净产物不误杀/弹窗失效；语义更新×4：D4a 两态、manifest 两态、W3 先读后写、连续写共享 state）；typecheck 0 错。
- 行为变化：①桌面线收口多两道硬门（空 driver 与高危产物不再直通 delivered）；②盲覆盖默认拦截（模型多一轮 read，防静默覆盖）；③挂起弹窗在用户继续对话后不可再确认；④worktree 开关 on 时子会话真实隔离（不再静默直写主根）。
- 存量 flaky 留痕：worktree-isolation 全量并发下单例偶现 71s 超时（git spawnSync 负载敏感；单独重跑稳定全过），与未批无关，归 flaky-detector 观察面。
- 挂账（后续批）：裁判/语义审查/对抗审查/交付分级的桌面线重接（P0-1 完整版，需产品决策：桌面线 GWT 等价物/裁判退回三选 UI）；setChildToolsBuilder 跨线单例参数化；PRD 确认卡（prd-confirm）env 断链与 sticky P2。

## 全链路审查修复批：P0-2 安全盲区 + 收口如实化 + 会话/PRD/快照链路 P1（2026-10-01）

| 属性 | 值 |
| --- | --- |
| 类型 | fix（全链路审查：四方向并行只读审查 + 主会话交叉验证；P0×1 + P1×6 批） |
| 模块 | `main/verification/security-scan.ts`、`main/desktop/dispatcher-loop.ts`、`main/agent/loop/agent-loop.ts`、`main/agent/loop/loop-planner.ts`、`main/coding/tool-handlers.ts`、`main/orchestration/stages/agent-dispatch.ts`、`main/ipc/shared.ts`、`main/ipc/projects.ts`、`main/ipc/sandbox-snapshots.ts`、`main/platform/sessions/session-service.ts`、`storage/json-store.ts`、`main/guide/requirement-enricher.ts`、`main/delivery/snapshots.ts`、`renderer/components/App.tsx` |

### 变更内容

- **P0-2（安全扫描 Python 盲区）**：SCAN_EXTENSIONS 补 `.py`；新增 Python 危险调用硬红线（`os.system`/`os.popen`/`subprocess shell=True`→critical，`eval`/`exec`→high；`pyOnly` 过滤防 JS 同形词误杀）；桌面子会话工具面（buildDesktopChildTools）拼接 buildDomainTools 获得 `run_security_scan`——桌面线在本机 spawn 执行的 Python（driver/scaffold）不再零扫描裸奔，生成方自扫自修。
- **收口如实化（审查 P1）**：loop 收口判定中 web 线拆除后无置位路径的 gwt/api 位改为工具面豁免预置（未装配=豁免 true，与 D1 无契约豁免同构；security 位不豁免——装配扫描工具的会话必须扫过才收口）；apiChecked 背板预置同源豁免；B3 守卫3 / W5 清单 / loop-planner / repair_control 四处提示文案只引用当前工具面真实存在的验证工具，不再指点幽灵工具（run_gwt_tests/run_preview/run_preflight 已退役）。
- **P1-1（PROJECT_BUSY 静默丢消息）**：runAgent 排队判定升级为项目级（同项目另一会话/后台审查占锁也入队）；safeInvoke 补 AGENT_PROJECT_BUSY 映射；渲染端 handleSendOutcome 补对应分支引导。
- **P1-2（删项目不停 run）**：PROJECT_DELETE handler 先按 project_id 批停全部活跃运行（cancelAgent，异常不阻断删除）。
- **P1-3（会话索引单点）**：writeJsonFile 改 tmp+rename 原子写（rename 失败回退直接写，不比旧世界差）；readSessions 损坏自愈（改名 .corrupt-<ts> 留证 + 重建空索引，会话 JSONL 正文直读不受影响）。
- **P1-5（PRD 修订回滚）**：mergeExistingFields 方向修正——冻结清单已带的修订厚字段（用户亲答 story/断言/priority）优先，盘上旧 prd.json 只补缺省，不再落盘即回滚用户修订。
- **P1-13/14/6/7（快照链路）**：SNAPSHOT_CREATE/ROLLBACK 入口加项目运行锁互斥（防撕裂快照与回滚/生成写交错）；归档快照回滚可达（ensureSnapshotActive 活跃索引 miss 时从 archive/ 搬回）；createSnapshot 半成品目录失败即清理（抛 SNAPSHOT_CREATE_FAILED）；restoreSnapshotFiles 改「先复制到同级临时目录成功后再原子切换」，复制失败不再清空项目根。

### 影响评估

- 单测 199 文件/1945 例全绿（含新增锁定：Python 扫描规则×3、归档回滚×1、修订不回滚×1；语义更新×3：PROJECT_BUSY 入队、收口豁免预置、无验证工具时的如实提醒文案）；typecheck 0 错。
- 行为变化（均为审查认定的修复目标）：①同项目并发消息从「静默丢弃」变「排队」；②删项目即停运行；③装配扫描工具的会话收口需扫描过（硬门）；④无验证工具的会话提醒文案不再点名已退役工具。
- 存量失败如实登记：tests/regression/sprint1 S1-SKETCH-002 草图预览回归在本批之前即红（web 生成线拆除后 previewUrl 无来源，stash 对照验证），与本批无关，待桌面线草图等价物补齐后处置。
- 挂账（后续批）：裁判/语义审查/对抗审查/交付分级的桌面线重接（P0-1 完整版）；setChildToolsBuilder 跨线单例参数化；write_file 盲覆盖 CAS 缺省化；确认卡 pending 失效机制；空 driver 最低断言校验；worktree provider 生产装配或显式退役。

## 扩展 A 期：AgentEvent 事件总线订阅面（P2-A）（2026-09-08）

| 属性 | 值 |
| --- | --- |
| 类型 | feat（pi harness 差距方案 §5 A 期；B/C 期 gate 后另立） |
| 模块 | `main/agent-event-bus.ts`（新）、`main/orchestrator.ts`、`main/coding/programming-orchestrator.ts` |

### 变更内容

- 新模块 `main/agent-event-bus.ts`：`onAgentEvent(type, handler)`（type 支持单事件名或 `'*'` 全量；返回幂等退订）→ `emitAgentEvent(event)` 广播。**A 期只抽订阅面、不改行为**：无 block/改参能力，B/C 期（钩子/注册）gate 后另立。
- 两条发布接缝套层接线：`setAgentStreamPublisher`（orchestrator）与 `setProgrammingEventPublisher`（programming-orchestrator）在接线时把事件先 `emitAgentEvent` 广播到订阅面再转发原目标——原发布链路零改动，总线只读旁路。默认 no-op 发布者在未接线时不广播（单测环境事件不进总线，与现状一致）。
- 订阅方抛错只 console 留痕、绝不阻断发布链路（降级链铁律：对齐委派超时/审查降级先例）。
- `resetAgentEventBusForTests()` 测试 seam。

### 影响评估

- 行为零变化（纯内部缝）；全事件可订阅（含 delegation_* / loop_compaction / steer_injected / usage_summary）。
- 测试：agent-event-bus.test.ts 6 例（类型订阅/全量订阅/退订幂等/抛错隔离/orchestrator 接缝真实路径/编程接缝接线安全）；typecheck 0 错。

## 会话 fork：从任意 user 消息重开（P0-2）（2026-09-08）

| 属性 | 值 |
| --- | --- |
| 类型 | feat（pi harness 差距方案 §2，P0-2） |
| 模块 | `main/session-tree.ts`（新）、`main/session-service.ts`、`shared/types.ts`、`main/ipc.ts`、`preload/bridge.ts`、renderer（ChatPanel/WorkspaceShell/App）、api-spec §5.8、data-model JSONL v2 |

### 变更内容

- JSONL 会话行 v2：新写入每行带 `id`（8 位 hex，`nextSessionEntryId`）与 `parentId`（前一行 id，首行 null）——**旧文件零迁移**（读侧对未知字段天然透明，不加头部行免去全读路径过滤改造）。收敛全部 20 处会话 JSONL 直写点（agent-loop / orchestrator / programming-orchestrator / ipc / guide-agent-service / recovery-service / runtime-fallback / decision-log / delegation-persistence）走新 helper `appendSessionMessage(sessionId, message)`（`main/session-tree.ts`，含 resetSessionTreeForTests）。
- 父会话链接不落 JSONL 头，改记索引：`AgentSessionRecord` 增 `fork_entry_id`（`parent_session_id` 复用既有字段）。
- `session-service.forkFrom(sessionId, {project_id, entry_id?, entry_timestamp?, new_session_id?})`：活跃会话拒绝（`AGENT_SESSION_BUSY`，复用 isSessionActive）；锚点解析 entry_id（v2 行 id）优先、旧文件回退 entry_timestamp（须命中 user 文本消息，否则 `SESSION_FORK_ENTRY_NOT_FOUND`）；复制「首行到锚点」前缀进新会话文件（树链重写为线性 v2），**原文件一字不动**；索引登记新会话（parent_session_id/fork_entry_id）。
- IPC 四层 `agent:fork-session`（入参 AgentForkSessionInput / 结果 AgentForkSessionResult）；ErrorCode 增 `SESSION_FORK_ENTRY_NOT_FOUND`。
- Renderer：user 气泡「↪ 从这里重新来」入口（ChatPanel → WorkspaceShell → App 三级 prop 透传）；点击 fork 成功后续接新 sessionId（setActiveSessionId + loadSessionHistory + 草稿复位 + 系统提示气泡「已从这里重新开始…」）。
- 与项目快照正交：时间轴管产物回滚、fork 管对话回溯，互不接管。

### 影响评估

- 风险最大处（读路径全覆盖）由「不加头部行 + 只增可选字段」消解：conversation-excerpt / session-service / continue 重放 / agent-monitor 等读侧零改动（session-fork 测试覆盖 loadMessages 读 v2 链字段无干扰）。
- 既有线性会话与委派子会话照常写入（链字段伴随，无行为变化）；委派子会话 v1 只读不 fork（树链照写，为将来留门）。
- 测试：session-fork.test.ts 8 例（链写入/前缀复制+原文件字节不动/旧文件零迁移/entry_id 定位与拒绝/活跃 BUSY/索引登记/读兼容）；typecheck 0 错。

## 只读工具并行执行：连续 parallelSafe 段并发 + 源序回注（P1-2）（2026-09-08）

| 属性 | 值 |
| --- | --- |
| 类型 | feat（pi harness 差距方案 §4，P1-2） |
| 模块 | `main/coding/agent-loop.ts`、`main/coding/agent-tools.ts`、api-spec §12.13 |

### 变更内容

- `AgentLoopTool` 增声明 `parallelSafe?: boolean`：v1 白名单 true = `read_file` / `list_files` / `grep` / `web_fetch` / `web_research`（agent-tools.ts 五处标注）；写类/测试/预览/委派/问答工具默认 false（状态序依赖：test_failed 旗标、修复预算计数、预览地址、委派状态机）。
- 执行段抽 `executeTurnToolCalls`（导出，单测友好）：按 assistant 源序切**连续** parallelSafe 段 → 段内 Promise.all（并发上限 `PARALLEL_CONCURRENCY_LIMIT=4` 小池），遇非 parallelSafe 先 join 再串行；`tool_result` 一律按源序打包进同一条 user 消息（「整批一条 user 消息、块序=源序」不变式逐字节保持）。**有 toolBudget 预算的工具即使 parallelSafe 也退串行**（防并行计数击穿静态预算；生产 web_research 恒串行）。
- 事件流：tool_call_started/completed 各自启动/完成时发；usage/toolCalls 记录调用点已按源序推进（零改动）。取消：串行位执行前检查同旧语义；并发段边界检查。
- 已知软风险（接受）：web_research 子代理与主 loop 并行写入交错读中间态——建议性调研 + writeFileSync 单次原子性兜底，不作权威输入。

### 影响评估

- 写轮（全非 parallelSafe）行为与现状逐字节一致（agent-tools / agent-loop / delegation 等 13 文件 183 例回归全过）；只读密集轮 wall-time 缩短（3×80ms 并发实测 ~89ms）。
- 测试：新文件 agent-loop-parallel.test.ts 7 例（wall-time 并发/源序回注/混合 join/预算退串行/abort 传播/写类串行回归/E2E 集成）。

## 运行中转向：steer 队列批间注入（P0-1）（2026-09-08）

| 属性 | 值 |
| --- | --- |
| 类型 | feat（pi harness 差距方案 §1，P0-1） |
| 模块 | `main/steer-queue.ts`（新）、`main/coding/agent-loop.ts`、`main/ipc.ts`、`preload/bridge.ts`、`renderer/agent-atoms.ts`、`renderer/components/App.tsx`、`shared/types.ts`、api-spec §5.7/§5.2 |

### 变更内容

- 新模块 `main/steer-queue.ts`：`steerQueues: Map<sessionId, SteerEntry[]>` + `loopActiveSessions` 注册表，enqueue / drain / clear / markLoopActive·Inactive / pendingSteerCount / wrapSteerContent（`【用户中途补充】`包裹）全套同步 API（纯内存，单测友好）。
- `runAgentLoop` 拆 wrapper + impl：depth 0 进入 markLoopActive、finally 先 drain 残余（未及注入的落 JSONL 保真；abort 后丢弃——取消语义优先）再 unmark；**批间注入点**在工具批 resultBlocks 落盘后、下一轮模型调用前（含压缩检查前）：逐条 JSONL → messages.push → publish `steer_injected`（content/message/at_turn/remaining）。委派等待期（wait_for_delegations 阻塞）注入照常下一批间生效，不打断等待。
- IPC 四层新通道 `agent:steer-message`：入参 `AgentSteerMessageInput = AgentSendMessageInput`（validateAgentSend 同一清洗）；有活跃主 loop 且不带图 → 入队返回 steered:true；否则主进程内部回退 `runAgent`（steered:false + fallback，与 send-message 语义逐字节一致——guide 单发/委派子会话/空闲全在此列）。子会话（depth≥1）不注册也不注入（enqueue 门直接拒绝）。
- `agent:cancel` 清空该会话 steer 队列（「停止后被注入」绝不允许；runAgentLoop finally 另兜竞态窗口）。
- Renderer：App.handleSendMessage 在 `hasActiveStream`（前台/后台生成的流式事件）且纯文本时改道 steer 通道，steered:false 时按 fallback 结果走既有 queued/BUSY 处理（抽出 handleSendOutcome 复用）；`steer_injected` 事件显式归约——系统气泡「已注入，将于下一轮生效」（对齐 queue_dropped 红泡模式）。
- api-spec §5.7 新通道 + §5.2 AgentEvent 增 `steer_injected`。

### 影响评估

- 行为变化只在活跃主 loop 期间的输入框消息：从「后台生成时 send-message 撞 PROJECT_BUSY 静默丢消息 / 前台忙则排队干等」变为「批间注入（最快下一轮生效）」；空闲/guide/排队路径零变化（回退语义逐字节一致）。
- 注入消息照常参与滑窗/竹节压缩（压缩时进交接输入、窗口自然滑出，无特判）。
- 测试：steer-queue 单测 6 例 + agent-loop steer 集成 6 例（批间注入/多保序/子会话门/收尾残余/压缩共存/JSONL 事件）；typecheck 0 错；全量 unit 1573/1574（1 例 platform-services 全量并发 flaky，单独跑 12/12 过，与本次无关）。

## keep-recent 三段式压缩：竹节压缩保留近期原文（P1-1）（2026-09-08）

| 属性 | 值 |
| --- | --- |
| 类型 | feat（pi harness 差距方案 §3，P1-1） |
| 模块 | `main/coding/agent-loop.ts`、api-spec §5.2 AgentEvent |

### 变更内容

- 竹节压缩重置从两段（`task + 【此前进度交接】`）改三段：`task + 交接文档 + 近期原文保留段`——此前压缩一发生窗口历史归零、正常对话细节全丢（pi 参照：摘要 + 保留近 20k tokens 原文；bloma 缺省 8k 保守起步）。
- 新纯函数 `keepRecentTurns(messages, budgetTokens)`：预算从尾向头累加（`estimateTokenCount`/`estimateBlocksText` 既有估算器），保留集恒为连续后缀；tool_use/tool_result 成对保留（切点永不在 tool_result，对齐 partitionWindow 配对保护先例）；装不下的整对丢弃（交接文档兜底）；head（task）不进保留段。
- 新配置 `BLOMA_LOOP_COMPACT_KEEP_RECENT_TOKENS`（缺省 8000，`'0'` = 旧行为完全回归，无效值回缺省）。交接 LLM 失败的确定性 fallback 路径同样带保留段（降级路径恰最需要细节，对齐审查 P1-2 先例）。保留段标记 `【近期原文保留】` 并入 head 文本（对齐 digest 并入 head 模式，不新增消息、零角色交替风险）。
- 钉轮索引口径修正（与保留段共存的必要修复）：`pinnedTestTurn` 赋值从「相对轮号 turn - pinBaseTurn」改为「tail 末位完整工具对的配对序号」（`tailLastPairOrdinal`），`pinnedFailureExcerpt` 同步按配对序号定位（`toolPairAtOrdinal`）。保留段的配对计入序号；无保留段且各轮皆工具轮时与旧口径等值（回归等价）；文本注入轮（退行反馈/steer）混排时不再错位（旧口径该场景钉定位会失配——partitionWindow 校验不过则静默不钉）。`pinBaseTurn` 变量移除。
- `loop_compaction` 事件 payload 追加 `keep_recent_turns`；JSONL `[loop-compaction]` 审计行追加 `keep_recent=N 轮`。

### 影响评估

- 触发面：仅压缩分支（默认阈值 100k，线上低频）；保留段 ≤8k token 远低于阈值，不会引发压缩风暴，封顶 2 次不变。
- 测试：agent-loop 新增 11 例（keepRecentTurns 纯函数 5 + 集成 6：缺省三段/预算不足回归/'0' 显式回归/钉轮共存/fallback 带保留段/事件与 JSONL 审计）；既有压缩 5 例与压缩×钉轮 3 例以 `KEEP_RECENT='0'` 锁定机制回归（断言零改动）全过；agent-loop 全量 53/53、相邻 5 文件 63/63、typecheck 0 错。

## 任务级模型降级选模落地：内审缺省 flash 级（2026-09-02）

| 属性 | 值 |
| --- | --- |
| 类型 | feat（组会决议 4/7「审查用 flash 级、顶配留给 MVP loop/spec 生成」） |
| 模块 | `main/model-resolution.ts` |

### 变更内容

- 落地 `capability` 三档选模（此前 `balanced`/`cheap` 为预留档、一律按 strongest）：`strongest` 取渠道 models 列表序首个 enabled（与改造前一致）；`balanced`/`cheap` 优先取名称匹配 `flash`/`lite`/`turbo` 的经济档快模型、无匹配回退 strongest——名称启发式过渡，能力元数据（tier 字段）落地前使用，单模型/多档渠道行为与改造前完全一致（不因缺元数据把渠道判死）。
- `audit`（内审 Attacker/Defender/复核轮）缺省 capability 由 `strongest` 改 `cheap`：决议 7「审查用 flash 级」落地；渠道无快模型时回退渠道首选，非强制，用户仍可按渠道选配 + 模型列表序覆盖。

### 影响评估

- 受影响调用点：`resolveChannelEnv`/`pickBackupChannelEnv`（runtime-fallback）、`resolvedAuditView`/`buildCategoryRoutingViews`（category-routing）——含 flash 级模型的 audit 渠道会命中快模型。
- 测试：model-resolution 新增 3 例（audit 缺省 cheap / flash 命中 / lite-turbo 命中 + strongest 不受名称影响）；既有 7 例全过。

## UX 累计池批量修改：PRD 确认弹窗「一步一问一改」改批量（2026-09-02）

| 属性 | 值 |
| --- | --- |
| 类型 | feat（组会决议 7 / 下周计划 5） |
| 模块 | `renderer/components/PrdConfirmDialog.tsx` |

### 变更内容

- 替换 `adjustText` 单字段为 `adjustPool: Array<{entryId, requirementId, text}>` 累计池：`openAdjustWith(id)` 入池（按 requirementId 去重）、`updatePoolEntry`/`removePoolEntry`/`addBlankPoolEntry`、`filledAdjustCount` 计数。
- `submitPoolAdjust()` 把池内文本以 `\n` 拼接后一次性 `sendMessage(text, 'prd_confirm_adjust', …, {typed:true})`——把「一步一问一改」收敛为「攒一起统一提交」，省 token（组会第 10 点）。
- `sendMessage` 增 `opts.typed`：失败时 `fail()` 内联错误 + `restoreAfterFailure` 恢复快照（与 F9a 混合契约一致），勾选/文本不丢。

### 影响评估

- 仅 PRD 确认弹窗交互路径；新增单测 10 例（prd-confirm-adjust-pool.test.tsx：P1–P7 池操作 + F1–F2 失败恢复 + S1 渲染同步）。

## 需求确认弹窗失败静默修复：F9a 混合契约 + r124 测试恢复（2026-09-02）

| 属性 | 值 |
| --- | --- |
| 类型 | fix（B 腿 r124 UX 走查 / 下周计划 6） |
| 模块 | `renderer/components/RequirementConfirmDialog.tsx` |

### 变更内容

- da737d5 半合并把 c9ab674「失败不关窗」回退成乐观关闭，四路失败（confirm/supplement 各 ok:false/throw）用户零反馈、勾选/文本清空、决定静默丢失。重兑现为混合契约：提交先隐藏弹窗（IPC 回传绑定 PRD 全程可达数十秒，滞留=盲等），失败时快照写回恢复弹窗 + 勾选/文本/灵感/参考链接全保留 + submitting 复位 + 内联错误条。
- `restoreAfterFailure` 走 `store.get(requirementConfirmFamily(sessionId))` 做竞态守卫：在途新卡不覆盖，落到全局错误通道；`seenStateRef` + `useEffect` 换新卡时清 submitError。
- 恢复 r124 测试（N1–N5 失败恢复翻转位 + M1 aria/文案基线 + D1 降级基线，共 7 例全过）。

### 影响评估

- 仅需求确认弹窗；无其它文件随 da737d5 丢失（已核）。

## 泳道图 + PRD 三形态实验 + P2 测试盲区收尾（2026-09-02）

| 属性 | 值 |
| --- | --- |
| 类型 | docs + test（组会决议 5/6、下周计划 3/4/6） |
| 模块 | `docs/03_ARCHITECTURE/agent-swimlane.md`、`docs/05_PROJECT_PLAN/prd-forms-experiment.*`、`tests/unit/*` |

### 变更内容

- 泳道图（决议 5）：`agent-swimlane.md` 7 泳道（user/harness/guide/内审/programming/委派/judge）+ 术语表，画出全流程 Agent 调用关系（含委派结构）。
- PRD 三形态对比实验（决议 6）：同需求（学习笔记）× 三形态（一句话/简单/完整）× 同渠道同模型（deepseek-v4-pro）各 3 轮，走生产 `generatePrdLlm`。结论：一句话→简单是决定性跃升（验收 78→367 字、EARS 1→5.3）；简单→完整不升反降（验收 367→258、EARS 5.3→3.7）但范围外 0→3 条；数据支持导师「一句话几乎必出 major」。
- P2 测试盲区（下周计划 6）：ideas 归约（5 例）、summary 渠道回退（3 例）、ipc 入参清洗（7 例）——锁定事件→atom 清洗、summary 非角色类别回退链、validateAgentSend/validateConfirmRequirements 非法入参 fail-closed。

### 影响评估

- 全量 unit 1171/1171 全过（119 文件）、typecheck 0 错；实验脚本 `BLOMA_EXPERIMENT=prd-forms` 显式开启、平时 skip。

## usage 阈值竹节压缩：Agent Loop 主动交接≤2 段（2026-08-29）

| 属性 | 值 |
| --- | --- |
| 类型 | feat（闭环与上下文治理 PR6） |
| 模块 | `main/agent-loop.ts`、`shared/types.ts`、api-spec §5.2 AgentEvent |

### 变更内容

- 每轮结束后（下一轮模型调用前）检查 usage：`input_tokens` ≥ 阈值（缺省 100k，`BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS` 可覆盖，`'0'` 关闭）且未达封顶 → 一次无 tools 交接小调用（复用同渠道 query/env，maxTokens 1024，携带窗口化消息含钉轮），把进展压缩成交接文档后重置 messages 为 `task + 【此前进度交接（第 N 段）】`；每 loop 至多 2 次（task+2 次交接=3 节，随感 38）。
- 交接 LLM 失败 → 确定性 fallback（轮次/工具统计/最近进展，零 LLM）；压缩后 `pinnedTestTurn` 清空（失败细节已进交接文档）。
- AgentEvent 新增 `loop_compaction`（at_turn / input_tokens / compactions）；渲染端归约 default 分支安全忽略（已核）。

### 影响评估

- 默认阈值 100k 的标定依据由 PR8 脚本回填（拍板项 B 首版值）；线上先观察 agent_loop_turn 埋点再定。
- JSONL 审计全量照落不受影响；新增单测 5 例（触发/封顶/fallback/关闭回归/abort 退出）。

## web_research 委派化查询工具 + toolBudget 首个生产接线（2026-08-29）

| 属性 | 值 |
| --- | --- |
| 类型 | feat（闭环与上下文治理 PR5） |
| 模块 | `main/agent-tools.ts`、`main/programming-orchestrator.ts`、api-spec §12.12 |

### 变更内容

- 新增 `web_research` 工具（仅 parent，子代理无此工具防递归委派）：派出 role=research 只读子代理联网调研，阻塞等待收敛（上限 90s，超时停止子代理）后回灌 ≤4000 字精干结论（剥「子代理状态」头行），主 loop 上下文不进原文大段；等待经 withAbort 接入主 loop 取消信号，用户点停止立即解除。
- `AgentLoopInput.toolBudget` 首个生产接线：`runMvpViaAgentLoop` 传 `{ web_research: 4 }`，超限走既有 budgetExhausted 软着陆。

### 影响评估

- parent 工具面 16→17，仅新增不改旧；api-spec 新增 §12.12。
- 新增单测 8 例（agent-collaboration 7 + agent-tools 工具面 1），角色裁剪断言同步。

## 收敛路径统一收口：点选/让渡接入 PRD 后置链（排查报告批次1，🔴1/🔴2）（2026-08-27）

| 属性 | 值 |
|------|-----|
| **状态** | 已确认 |

### 变更内容

- **背景**：线上首测（会话 b1b39b20）实测点选澄清卡后直达草图——8-22 澄清死循环修复时代的「点选即开工」捷径绕过了 8-26 全套确认体系（弹窗/市调/PRD/六维审查/PRD 确认卡），确认卡在主路径 0 触发；详见桌面《guide-agent-历史遗留冲突排查报告-2026-08-27》
- `[重构]` 抽公共链 `runPrdPipeline`（PRD 前移→六维审查→PRD 确认卡→草图），三条收敛入口统一：模型判定（弹窗确认）/点选澄清卡/让渡；固化不变式「**PRD 不过目不开工**」；无模型场景（规则路由）以 NO_QUERY_FALLBACK 走既有降级链（LLM 审查失败→规则门）
- `[修改]` 点选卡片答案不再直接 `runSketchTask`，改入 PRD 后置链；话术改为「整理成产品需求文档，请你过目确认后再画草图」
- `[修改]` 让渡统一（🔴2）：点选「你帮我决定」不再被 cardAnswer 截胡（预置文案偷换需求），统一走 `resolveAutoDelegation` 让渡流——决策留痕 source 区分 `card_auto`/`free_text_auto`，同样接 PRD 后置链（让渡场景「系统替你做的决定」最多，确认卡 assumptions 段价值最大）；`CARD_ANSWER_REQUIREMENTS.auto` 保留（让渡流需求源，daily/work 预置映射不变）
- `[修复]` 规则门降级话术如实（不自称「已通过裁判审查」）；同步 guide-agent-service 两处过时注释（D3 熔断已改弹窗化）与 prompt-config 头注释（五引擎+loop-system 全量接线）
- 市调（DDG）仍仅弹窗路径专属：市调摘要绑定弹窗 UI，点选/让渡路径无展示位（产品差异而非缺陷；后续若确认卡加市调段再评估）

### 影响评估

- 受影响模块：guide-agent-service（runPrdPipeline 新抽 + 三入口接线）/ prompt-config（注释）/ 测试×2 同步
- 测试：guide 系 45/45（同步 guide-agent-service 2 例至新语义：点选挂起+原文映射、点选 auto 让渡留痕+挂起）；全量 unit 579/581（2 失败=既有 flake blocked-decision/platform-services，单跑全过）；typecheck 0
- 线上待验证：同场景重跑「桌面轻松记→点选便签」应出现 PRD 确认卡；点选「你帮我决定」应见让渡话术+确认卡

---

## 活背板三件套：功能项状态回写 + PRD 用户确认门 + 执行经验沉淀（2026-08-26）

| 属性 | 值 |
|------|-----|
| **状态** | 已确认 |

### 变更内容

- **改造 1 功能项状态回写（ralph 式 passes）**：`[新增]` `SketchRequirement` 可选字段 `status`（implemented/partial/missing/deviated/unverified）+ `status_note`（裁判证据，≤160 字）；`[新增]` document-engine `updateRequirementStatus`——judge 语义审查的逐项判定回写进 prd.json（pass/fail 都回写，只改状态不碰需求语义，内部全 catch 不阻断裁决流）；接线在 evaluateOnce（semantic 非 skipped 即回写）；PRD 渲染勾选态（implemented→`[x]`，其余中文标签）；loop 项目锺带执行状态行（部分重生成/恢复终验路径下让 loop 知道哪些项是既成事实）。**语义自洽点：迭代全量重生成时 syncPrdCheckpoints 重写 prd.json，status 自然清除（新产物未判定）**
- **改造 3 PRD 用户确认门**：六维审查**通过**后、草图前，把背板以四段式确认卡摊给用户阅读确认——机器质量关（prd-review）与人语义关接力，确认的是「系统加工的理解细节」（story 化/断言/优先级/范围外/假设）而非用户已确认过的话。`[新增]` 新模块 `main/prd-confirm.ts`（发布/挂起/回传消费，复用 card_option 元数据零新 IPC）；`[新增]` 渲染端 `PrdConfirmDialog`（四段式：定位/功能清单 P0 断言展开、P1P2 折叠/明确不做的高亮/系统假设可推翻；完整视图 longterm 默认展开、quick 折叠；整体确认 + 逐项「这条不对」预填回向导）；`[新增]` PrdBackplane `user_confirmed_at` 落盘（markPrdUserConfirmed，迭代争议仲裁锚点）；DecisionType 新增 `prd_confirm`；BLOCKED_DECISION_IDS 同步两选项 id。审查 needs_revision 的 override 分支不再发卡（避免双重打断）；规则门降级话术如实（不自称「已通过裁判审查」）
- **改造 2 执行经验沉淀（ralph progress.txt 等价物）**：`[新增]` 新模块 `main/learnings-log.ts`（append-only JSONL `documents/{id}/learnings.jsonl`，只存执行过程经验——loop 完成总结/异常结局，不存需求/决策/约束防第二事实源，零 LLM 成本）；接线 runMvpViaAgentLoop 结束点（finalText 完成总结 + 轮次/工具元数据）；`buildLoopSystemWithOverride` 新增【历史经验】段注入最近 6 条（首轮无经验零开销，下轮 fresh loop 开场即知上轮踩坑）

### 影响评估

- 受影响模块：sketch-engine（类型）/ document-engine（回写/确认落盘/勾选渲染）/ programming-orchestrator（回写接线/learnings/状态行）/ guide-agent-service + prd-confirm（新）/ learnings-log（新）/ agent-atoms + PrdConfirmDialog（新）+ App / decision-log（DecisionType）
- 测试：新增 requirement-status 8 例、guide-prd-confirm 4 例、prd-confirm-dialog 4 例、learnings-log 5 例；同步既有 guide-prd-review 2 例与 guide-requirement-confirm 2 例至新语义（审查通过→确认卡挂起而非直接草图）；全量 unit 579/581（2 失败均为既有并行 flake：blocked-decision/platform-services，单跑全过）、acceptance sprint2 33/33 + sprint3 49/49、typecheck 0、docs:check 过
- 线上待验证：确认卡全链首跑（弹窗→确认→user_confirmed_at→草图；adjust 回向导修订闭环）；judge 回写后文档面板 prd.json 勾选态；迭代重生成 learnings 注入对 loop 行为的实际影响
- 方法论来源：snarktank/ralph（文档即状态：passes 回写/progress.txt/写给维护者的文档）；确认卡信息设计拍板：P0 断言展开 + 整体确认带逐项异议出口（用户 2026-08-26）

---

## 裁判审查委派化：协作过程可视化（2026-08-26）

| 属性 | 值 |
|------|-----|
| **状态** | 已确认 |

### 变更内容

- `[新增]` 新模块 `main/review-delegation.ts`：PRD 六维审查与 MVP 语义审查默认升级为**真·委派子 agent**（用户拍板：协作过程可视化）——经 agent-collaboration M1–M4 派 `role='research'`（物理只读工具面 read_file/list_files/grep/web_fetch，裁判铁律「只判定不修复」由工具面保证而非提示词），生命周期事件（delegation_started/completed/failed）流入 DelegationFeed/CollaborationPanel 实时可见，子会话 JSONL 可回放
- `[新增]` 合成父键（review-{uuid}）注册父上下文，与 MVP 主 loop 的真实注册完全隔离；finally 三件套清理（停残/注销/清状态，防孤儿子 agent）；120s 等待上限、8 轮子 agent 上限
- `[修改]` 语义审查委派版的实质升级：产物不再内联截断 24k，子 agent 用只读工具**自行翻代码找证据**；PRD 门委派与直连共用任务体构造
- `[修改]` 降级链：委派（默认）→ 直连 LLM（既有路径）→ 规则门；开关 BLOMA_DELEGATED_REVIEW（缺省开，='0' 回退直连）；PrdReviewOutcome/SemanticJudgeResult 增 via 字段（delegation/direct，入决策日志）
- `[修改]` 两调用点（resolveRequirementConfirm/evaluateOnce）透传 projectId/requestId/publish；三个既有测试文件关委派走直连；渲染端零改动（M4-C 事件基建直接消费）

### 影响评估

- 受影响模块：review-delegation（新）/ prd-review / judge-semantic / guide-agent-service / programming-orchestrator / 测试×4
- 测试：新增 review-delegation 5 例（接线/开关/超时/失败/拋错清理）；目标集 57/57、全量 unit 558/560 + acceptance 129/132（失败均为既有并行 flake 三件套，隔离 12/12 全过）；typecheck 0 错
- 线上待验证：委派审查首跑（DelegationFeed 可视化效果、子 agent 只读查证质量、耗时）

---

## MVP 终审语义审查腿（裁判域 LLM，非 AC）（2026-08-26）

| 属性 | 值 |
|------|-----|
| **状态** | 已确认 |

### 变更内容

- `[新增]` 新模块 `main/judge-semantic.ts`：MVP 终审的 LLM 语义审查腿，归裁判域（只判定不修复），与 prd-review（简化版 AC）刻意区分——审的是「产物是否忠实实现 PRD 每个功能项」，不使用 AC 方法论。逐功能项判定 implemented/partial/missing/deviated/unverified（不确定→unverified 不误杀 canvas/动画类）；证据必须引用产物代码；P0 missing/deviated→blocking、P0 partial/P1 missing/deviated→major，其余仅备注；代码级推导不信任模型自报结论；产物超长截断 24k 并如实标注
- `[修改]` runJudgeReview 合成裁决（evaluateOnce）：规则引擎先行（return 直接进退回流，省一次 LLM）；规则全绿且 query 可用→语义审查，失败合成 return 进同一退回计数/让渡流；LLM 失败/无渠道→跳过并留痕（judge_semantic），绝不阻断交付。渠道优先 M5 prd 类别路由（可指快模型）
- `[修改]` JudgeReviewInput/AgentLoopPostTestingInput 增 query/channel_id 透传（ipc/迭代/resume 五个调用点全部接线）；judge-engine 导出 readArtifactText 供语义审查复用；DecisionType 加 judge_semantic

### 影响评估

- 受影响模块：judge-semantic（新）/ programming-orchestrator / judge-engine / decision-log / ipc
- 测试：新增 judge-semantic 6 例（解析白名单/严重度推导/合成 return+让渡留痕/全绿维持/skip 降级/截断标注）；judge 系既有 19 例、loop 门禁验收 5 例、sprint2 验收 40 例全过；全量 unit 553/555（2 失败为既有 flake，隔离全过）；typecheck 0 错
- 线上待验证：真实渠道语义审查首跑（误杀率/命中质量）；每轮 MVP 终验增加一次 LLM 调用的耗时（建议 prd 类指快模型）

---

## PRD 裁判审查门：简化版 AC 对抗审计（2026-08-26）

| 属性 | 值 |
|------|-----|
| **状态** | 已确认 |

### 变更内容

- `[新增]` 新模块 `main/prd-review.ts`：PRD 落盘后、草图前的裁判审查门。方法论源自用户指定 skill「ac-audit」（~/.claude/skills/ac-audit）的流程精简版——保留六维攻击面 I-F-Z-U-L-G + PRD 权重（F30/U20/L15/G15/I10/Z10）、严重度分级（blocking/major→退回，minor/suggestion→放行）、证据引用/禁编造/禁提修复方案铁律、诚实降级标注 simplified_ac；砍掉多轮循环/Defender 修复/双 Arbiter/Prober/金丝雀/重叠度实测（单轮秒级）
- `[新增]` 独立一次模型请求（AC 铁律「审查者≠生成者」，不与 PRD 生成合并自查）；渠道优先 M5 prd 类别路由（可指快模型）、回退向导轮 env、再失败降级确定性规则门（只拦空定位/零功能项/描述过短/完全重复硬伤）——永不阻断主流程
- `[新增]` 审查未过 → 决策卡「忽略问题继续生成 / 我来补充说明」（复用 card_option 回传，零新 IPC）：override→按原需求开草图 + 日志 prd_review_overridden；supplement→提示打字补充回向导修订。代码级裁决不信任模型自报宽松结论（按 severity 推导）
- `[修改]` guide-agent-service：resolveRequirementConfirm 插审查门（PRD 失败时跳过审查保持原降级）；handleGuideMessage 顶部拦截审查卡回传（先于 resolveCardAnswer）；BLOCKED_DECISION_IDS 加审查卡选项 id；pending 补存 env
- `[修改]` decision-log：DecisionType 加 prd_review / prd_review_overridden

### 影响评估

- 受影响模块：prd-review（新）/ guide-agent-service / decision-log
- 测试：新增 guide-prd-review 6 例（pass 分流/卡片留痕/override+supplement/降级/解析白名单/规则门）；既有 guide 系 5 文件 26 例全过；全量 unit 546/549（3 失败为既有 flake 三件套，隔离 30/30 全过）；typecheck 0 错
- 线上待验证：真实渠道六维审查首跑（问题命中质量/误报率）、prd 类别路由指快模型的耗时

---

## 渠道存储独立化：bloma-channels.json（2026-08-26）

| 属性 | 值 |
|------|-----|
| **状态** | 已确认 |

### 变更内容

- `[修复]` 渠道存储从与 Proma 共用的 `~/.proma/channels.json` 迁至专属 `~/.proma/bloma-channels.json`（`config-paths.getBlomaChannelsPath`）：实测 Proma(v9) 写入共用文件时会整体丢弃本项目 snake_case 条目（2026-08-26 00:27 文件实锤，仅剩 camelCase 条目），导致双开场景下本项目渠道每次被清空、每次启动重配
- `[新增]` loadChannels 一次性迁移：新文件不存在时从旧共用文件提取 snake_case 条目写入（空迁移也落盘作完成标记），绝不回写旧共用文件；saveChannels 只写新文件
- `[修改]` seed-channel / diagnose-channels 脚本与 3 处测试落盘断言同步新文件名；渠道相关 6 文件 44 例全过
- `[运维]` 用户渠道已从 8-20 备份（channels.json.bak-20260820-012132）恢复 3 条（ds/kimi/glm，safeStorage 密钥随备份时点，若后换过 key 需重填一次）

### 影响评估

- 受影响模块：config-paths / channel-manager / scripts×2 / 测试×4
- 兼容性：旧共用文件不再读写（Proma 地盘）；isOursChannel 过滤语义不变；既有渠道经迁移/恢复保留

---

## 向导需求确认弹窗 + 市调 + PRD 前移（2026-08-26）

| 属性 | 值 |
|------|-----|
| **状态** | 已确认 |

### 变更内容

**向导新增 confirm_requirements 动作（需求确认弹窗）**
- `[新增]` 提示词三选一：需求基本成型 → 输出 confirm_requirements（requirements 清单 + research_queries 市调查询），平台执行市调后弹独立确认窗（RequirementConfirmDialog）：需求勾选清单 + 市调摘要折叠 + 三出口（确认勾选子集 / 继续补充说明→回向导 / 由向导决定），对齐「不得臆断，除非用户选择由向导决定」
- `[新增]` 新模块 `main/guide-research.ts`：DDG html 免 key 市调（15s 超时、结果块解析、uddg 跳转解码、广告位剔除、去重 top6、失败降级 available:false 不阻断弹窗）；SSRF 防护与文本提取抽取为共享层 `main/net-guard.ts`（web_fetch 同源复用，行内标签剥除不再插入多余空格）
- `[修改]` D3 轮次熔断语义修订：连续 2 轮不收敛由「强制 auto 开工」改为「转入需求确认弹窗」（弹窗内保留让渡出口），决策类型新增 clarification_forced_confirm/requirement_confirm_card/requirement_confirmed
- `[新增]` PRD 前移：确认/让渡后立即 resolvePrdBackplane + syncDocuments 新检查点 requirement_confirmed（写 requirement_confirmed.md + prd.json，早于草图；失败不阻断草图）；DocumentSyncInput.checkpoint 联合类型同步
- `[新增]` IPC 四层新通道 `agent:confirm-requirements`（confirm/delegate + requirement_ids；supplement 走既有 send-message）：shared/types → ipc.ts（含 decision 校验）→ preload/bridge → renderer；ipc-contract expectedChannels 同步
- `[新增]` 渲染端 requirementConfirmFamily atom（事件归约 kind=requirement_confirm，extractDecisionCards 天然不弹内联卡）+ RequirementConfirmDialog 组件常驻挂载（App 根，同 PermissionDialog）

### 影响评估

- 受影响模块：guide-agent-service / guide-research（新）/ net-guard（新）/ document-engine / decision-log / ipc / preload-bridge / agent-atoms / RequirementConfirmDialog（新）/ App / shared-types / api-spec
- 测试：新增 unit 15 例（guide-research 4 / guide-requirement-confirm 5 / requirement-confirm-dialog 5 含事件归约）；修订 guide-clarification-round-limit 1 例与 acceptance sprint2 guide-clarification-fixes ③（D3 新语义）；ipc-contract 同步 3 例全过；typecheck 0 错、docs:check 过
- 线上待验证：DDG 市调真实链路（免 key 端点稳定性）、confirm 全链（市调→弹窗→确认→PRD→草图）真实渠道首跑

---

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
