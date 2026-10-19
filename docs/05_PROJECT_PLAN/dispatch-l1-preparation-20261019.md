# L1 quick 并行预实验准备

用户于2026-10-19选择：先准备 L1，等当前 L2 首组收尾后再启动 L1，避免两个执行组争用同一 Coding Plan 通道。L1 的原生需求、PRD、草图和六组环境准备已完成，当前等待 L2。准备与执行分开计量；封存时 L1 六组执行调用均为0。

L1 原始需求：

> 我需要一个离线待办清单。可以新增任务，标题去掉首尾空格，空白标题不能保存；可以勾选完成或取消完成，查看全部、未完成、已完成的任务，删除指定任务。允许同名任务，操作一条不能影响另一条。关闭程序再打开，任务和完成状态仍然保留。暂时不需要账号和联网功能。

外部验收为6项：新增标题去空格、空白拒绝、同名任务完成切换互不影响、三种筛选、指定删除与同名隔离、真实关闭重开后的持久化。源需求 SHA256=`3c5d93821644ba3bc04ea405ef84edc3b77f7093bdc60bc2071d27608294465a`；验收 SHA256=`08dbe9b458009c4cc22c8f7f8e2136975bcb943c70509c186e0ebe80f8a49fff`，未使用 L2 的14项验收。

独立源目录 `C:\Users\17359\bex-l1q19\source-home`，新项目 `42487b23-f6c0-47e5-b46b-f607b105ae7b`。从新的 L1 请求走原生需求确认、PRD 内审/确认及草图确认；不复用 L2 PRD、UX 或业务代码。基础列表顺序与可见标题/完成状态纳入需求；未勾选编辑、计数、动效等额外灵感建议。无项目管理、优先级、日期、备份、账号或联网功能。

模型条件：M1=`glm-5.3-flash`，M2=`glm-5.3`，共同 V=`deepseek-flash`；D/E 固定 high、temperature=0.1。G11/G12/G21/G22 为两名实现者的交叉配对，S1/S2 为直接实现。共同准备通道沿用 DeepSeek Flash，与正在测量的 GLM 执行通道分开，准备调用及失败尝试单独记录。金额上限沿用用户明确取消的设置，运行保护与用量计量继续保留。

准备中发现向导操作指令污染产品约束：原生修订删掉后，项目历史约束又被平台强制并回，导致内审循环。修复在独立 L1 运行副本完成，过滤明确给向导的输出/工具指令，保留真实产品约束；22项相关检查、完整类型检查通过。不删除历史消息或失败尝试，不在模型产物上手工改 PRD。

L1 运行副本：`C:\Users\17359\.codex\worktrees\l1-preparation-runtime\guide-agent-platform-sprint0`，提交 `13d73e285bf225940a3f0394e810895e78cbb200`。当前 L2 仍固定自己的 `48fcef0` 运行包，主包 SHA256 仍为 `108e342d8158b1e458a352212b9a9b5bf54935aedb876b2f054fa60dee9d0194`，未在运行中混入该修复；不同版本不作跨难度的因果基线。

证据根：`C:\Users\17359\AppData\Local\Bloma\parallel-L1-quick-20261019`；`native-prepare-r1/r2/r3` 保留各次原生准备及监督者暂停原因；`source-ui-actions.jsonl` 记录原生修订与逐题作答；`C:\Users\17359\bex-l1q19\preparation-registry.json` 为初始预登记。

原生 PRD 确认完成：6功能、10规则、32场景；外部业务验收仍为原定6项，没有以内部场景数扩大验收分母。运行期间保持所选视图；重开默认全部；在已完成视图新增时保存为未完成，当前视图保持不变。制作禁令、向导 JSON 提示及强制禁止二次确认已从业务模型排除。剩余一条离线约束带有对话前缀，实质仍是离线/无需账号，不影响业务语义。

草图探索 `72e96648-d9f8-4a4c-9221-8a565655f305` 完成，选B；11次真实请求中5次初始修复失败保留。B 的6行示例与4未完成/2完成统计一致，同名任务分行展示各自状态；1100/820窗口实测无溢出。32/32场景关联、6/6功能覆盖、29/29 HTML交互标记、新功能声明为空，完成原生 UX 确认后暂停在 Implement 之前。这是静态 UX 审阅，未执行产品业务。

六组 G11/G12/G21/G22/S1/S2 的依赖、加密渠道、本地 WebView2 DOM 和 Bloma 原生界面均通过；84份冻结文件无内容漂移（恢复路径所需项目/会话索引元数据除外），94个运行文件及4个原生驱动文件封存。各组独立 .venv，Python 3.13.7、10项精确依赖一致。`00_ENV`、确认后的 PRD/UX 与草图提示词受保护，没有提前实现业务代码。

| 封存项 | 值 |
| --- | --- |
| L1 cohort | `C:\Users\17359\bex-l1q19\pilot-r1` |
| 执行输入 SHA256 | `cb444d027aedfcbd512e393daef2a27be48dfb6b5f5c2344d09e8bd208a559d7` |
| L1 主包 SHA256 | `1f213594972a8f8bdaf20565f7a2afa85cb55392bc1f6d1ecfe60cf2040f3f2f` |
| 依赖清单 SHA256 | `2eeb7eb5b0b1290db1642002d39a88ebe3593beb451988e9dc20692c4d3121dc` |
| 来源环境与资格 | 证据根下 `source-environment.json`、`env-r1/{group}/report.json`、`readiness-r1.json` |
| 准备审阅 | `prd-final-review.json`、`ux-final-review.json` |

源准备86次逻辑请求与物理传输均已收尾，全部completed，input/output usage完整；guide12、orchestrator6、research57、ux_visual11，均DeepSeek Flash。已报告 input524977、output211960、cache-read1157248；cache-creation 84次显式报告0，另2次未报告该可选字段，不补造。数据来源是 Bloma provider ledger，不是现金账单，也不包含监督者模型用量。事件窗口27分55秒含工程修复、暂停与审阅，不作模型延迟；单请求 duration 合计660.204秒单列，不与墙钟混用。原账本前后 SHA256 相同，详见 `source-preparation-usage-summary.json`。

已建立一次性的当前任务衔接流程，等待指定 L2 run=`glm-pair-parallel-L2-quick-20261019-v4-G11` 同时具备终态事件、原生启动器退出以及全部查询/传输收尾，再重验 L1 封存指纹并启动 G11。不会中止或重试 L2，不自动越过首次 L1 结果去启动其他组。衔接状态位于证据根 `start-after-l2/{intent,waiting,launch-claim,exit}.json`；启动后原生报告位于 `pilot-r1-runs/G11`。L2 若以失败/超时终止也保留原样，不伪造质量结果。

版本化的起跑摘要与草图预览见 [起跑摘要](../../outputs/experiment-L1-20261019/pre-execution-readiness.json)、[宽窗口草图](../../outputs/experiment-L1-20261019/ux-confirmed-1100.png)、[窄窗口草图](../../outputs/experiment-L1-20261019/ux-confirmed-820.png)。传输容量、文档审阅与独立产品业务 Q 分开，尚无 L1 产品交付或 Q 结果。
