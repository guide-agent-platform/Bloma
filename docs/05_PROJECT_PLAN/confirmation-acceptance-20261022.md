# PRD/UX恢复、独立GUI验收与真实试跑

基线：`20875f8`。保留原有流程文档两行未提交补充；不push，不改历史科研样本。

## 本轮计划

1. 把PRD/UX候选、等待调整、未应用意见和已花费轮次持久化到宿主home。每次消息绑定当前query/env/signal/publisher，凭据和函数不落盘；旧版本和损坏记录不能绕过确认。
2. 在普通制作中加入独立验收规则准备：依据已确认PRD/UX生成并冻结固定业务预期，与实现者隔离；生成失败明确保留unverified，不伪造测试。接入已有宿主GUI执行器及交付门。
3. 选择记录管理、文件操作等代表性任务检查需求→设计→制作→业务验证闭环。真实模型调用前核对当前渠道、费率、既有预算窗口与任务金额上限；预算不可核实时先完成本地工程和不付费机制验证，明确记录真实效果待验。
4. 每批验证后commit，最后完成正式回归、构建、隔离Electron及记忆增量。

## 实施结果

| 提交 | 行为与边界 |
| --- | --- |
| `3ce2a43` | 宿主 `pending-confirmations/` 保存PRD/UX候选、等待调整状态、未应用意见和累计轮次。显式DTO排除query/env/signal/publisher及凭据；恢复时绑定当前运行上下文。“继续”重发同一候选，不花费模型调用重做。损坏或范围过期记录保留原始字节归档；会话不符不消费其他会话的候选。 |
| `024cab2` | 在PRD/UX确认后、实现前准备独立GUI固定业务预期；planner只见确认意图，不可读取实现源码。宿主冻结suite、控件约定传给实现者，核心交付门实际执行。生成或验证失败保持unverified并保留原因，产品自测不能替代宿主验收。 |
| `15c61fb` | 保存planner原始候选、校验失败及预算；具体校验错误回传重试。扩展存储故障、输入fixture、多节点文本及整体执行时限，避免泛化为“JSON错误”或无界重试。 |
| `53a8db6` | 真实渠道会把完整guide_decide对象作为文本返回；严格验证完整、未截断的JSON后按同一决策合同处理，记录transport=structured_text，不伪造tool调用。普通文本仍按对话流处理。 |
| `5d77e37` | 确认时原子落盘，并核对用户过目的PRD scope仍与磁盘一致；意见采纳回调恢复后使用当前query/env/signal，不把旧闭包写入记录。 |
| `ed91ded` | 狗粮驾驶器只选择实际提供且启用的内审委托；耗尽后的内审卡停住留证。后端实测识别global_options，未知卡停止，不猜测“继续”。 |
| `70233a6` | 桌面形态转换须驾驶策略显式允许，并且卡实际提供该选项；不把网页请求自动改成桌面。 |
| `fa9ee76` | 实测发现UX确认后首次制作中断被外层success覆盖；现在将桌面收口结果传回guide，并使外层完成事件与消息接收状态保留incomplete。 |
| `1634abf` | 自动准备的suite绑定宿主签发的design_hash；PRD不变但UX变更时，旧控件绑定/执行证据拒绝复用，重新准备仍计入原scope累计额度。手工suite保持兼容，验证缓存同时绑定可信UX确认字段。 |
| `bdd0143` | 本地请求数、金额或执行策略阻止调用时不计作渠道连续故障；显示预算/策略原因，避免错误建议换API key。 |
| `895c178` | pywebview顶层import会延迟加载本机桥；Windows安装后补验CLR与System.Windows.Forms，原生依赖/DLL加载失败不能再报依赖检查全绿。 |

### 开关、预算与协议

自动准备采用显式开关：仅 `BLOMA_AUTO_GUI_ACCEPTANCE=1` 创建的新项目标记独立GUI准备要求，**默认关闭**。现有手工安装、scope匹配的宿主suite继续复用。缺少完整自动交付正例前不扩大默认启用范围。

每次准备最多3个物理请求、8192输出tokens、1元，每个相同PRD scope累计最多2次准备额度，重启不重置。实际scope/UX改变则旧suite失效；suite中的AC引用必须指向真正expect观测，click/restart附注不算正确性证据。空洞或未覆盖义务不能封存。控制绑定只传有意义的正向控件，不把“计数为0”的缺失元素当成实现锚点。

执行器上限调整为96步骤、8进程段、总计5分钟；各进程段仍有180秒上限。fill/click实际触发DOM事件和原生桥，expect实际读取text/value/count，可用equals、contains或nonempty三选一。最多16个UTF-8输入fixture，各4KiB，只写隔离数据目录的input子目录。

存储故障覆盖Windows独占文件锁、ENOSPC注入、JSON损坏与删除；范围限本次隔离APP_DATA_DIR。ENOSPC是运行时写入错误注入，**不是物理磁盘填满**。锁必须成对释放且不能跨重启，JSON故障前后保留摘要。宿主指纹与文件范围约束不等于操作系统沙箱。

### 验证证据

证据均位于忽略目录 `run-artifacts/`，历史样本未重评分。

- 2026-10-22上一阶段正式Vitest四目录全量：**309文件/2758项通过**，`recovery2-20261022-final-all.log`。最后PRD确认改动另跑4文件/51项通过，`recovery2-20261022-final-scope.log`；两集合重叠，不能相加。
- 2026-10-23源码`895c178`类型检查、完整构建、隔离Electron S0-UI-007通过：`recovery3-20261023-native-final-types.log`、`recovery3-20261023-build-closure.log`、`recovery3-20261023-electron-closure.log`。
- 最后源码`895c178`正式四目录低并发全量：**310文件/2773项全部通过，无未处理错误**，`recovery3-20261023-full-light.log`。此前并行构建/实测期间的全量有2文件3项超时及1次Vitest worker通信超时，原日志`recovery3-20261023-full.log`保留；停止其他重任务后以2 workers重新执行整个正式集合通过，未改断言或放宽超时阈值。
- 本次定向：guide/UX中断结果4文件30项、GUI设计版本4文件60项、本地预算归因2文件65项、延迟CLR依赖1文件13项通过。集合重叠，不能相加；证据分别为`recovery3-20261023-{outcome,design,limits-route-final,native-dependency-final}.log`。
- Python独立测试27项此前通过，其源码本次未改；脚本独立测试本次21项通过，`recovery3-20261023-final-scripts.log`。恢复/持久化回归包括凭据排除、意见保留、UX轮次、错误会话、过期/损坏、写失败、PRD确认竞争和回调重新绑定。
- 原生pywebview测试应用在4次启动中完成26个观测步骤，覆盖保存、重启、空输入、锁定写失败保留输入、ENOSPC和损坏/缺失存储；错误预期999反例确实失败。证据 `recovery2-native-gui.json`。这验证平台执行机制，不代表模型生成产品已通过。
- 独立GUI准备替身回归包括源码隔离、具体错误反馈、有界重试、scope变化、取消及空洞suite拒绝。没有用替身planner通过代替真实生成效果。

## 真实模型试跑

现有渠道为实际DeepSeek Flash，使用原共享金额策略，未修改额度、重置账本、豁免未知请求或调用GLM。任务总上限5元沿各次续跑累计；按核对的[官方价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)取高峰费率保守核算，不冒称供应商账单。

2026-10-22前三项代表任务与续跑累计109次物理请求、操作金额上界2.941392元，包含1次未完整返回usage的保守占额。scope已用完的GUI准备额度没有清零重试。

| 任务/探针 | 实际观察 | 可以得出的结论 |
| --- | --- | --- |
| 离线记录保存/列表/持久化/空输入/保存失败 | 未交付，GUI准备保持unverified；候选中有AC仅标记到动作，未形成expect证明 | 发现独立规则生成的真实不足，未静默补PASS |
| 本地文件批量加前缀重命名 | 未交付，在实现前触及请求限额 | 本次无法判断产品业务质量 |
| 离线两数相加 | 未交付，向导完整JSON被旧实现当作free_chat；驾驶器亦漏识别内审卡 | 需要修平台传输兼容与驾驶器，不能全部归因为模型能力 |
| 修复后的真实guide组件探针 | 1次请求返回confirm_requirements，transport=structured_text，未向用户流出原始JSON | 该传输组件已实证；不代表完整需求→交付成功 |

前三项采用隔离的真实主进程处理器驾驶，**不是完整renderer/UI自动验收**。驾驶器存在混杂因素，禁止据此计算平台或模型的成功率、Time-to-MVP或科研Q。截至2026-10-22这一阶段尚无生成产品业务GUI证据。原始事件、对话、planner候选、账本与各失败都保留；历史汇总为 `recovery2-20261022-outcomes.json`。

### 2026-10-23同一计算器接续

修复驾驶器后，通过PRD内审复核、PRD确认、显式桌面形态转换和UX确认，成功冻结71步骤（含1次restart）的独立GUI候选并进入实现。依次使用原任务剩余额度，保留每次请求守卫停止现场；累计达到190次物理请求、操作金额上界**4.074176元**，然后停止新增模型请求。总上限仍为原5元；保留此前1次未完整返回usage的保守占额，没有重置金额/项目尝试次数，也没有因失败修改原样本或验收预期。

产物最终仍在`generating_mvp / desktop-implement`，停止原因`REQUEST_BUDGET_EXHAUSTED`，没有LAUNCH.json/CORE_CHECK.json完整交付登记。最后一次中断事件已正确为incomplete，并明确说明本地预算，未再提示渠道故障。原始报告：`recovery3-calculator-20261023`、`recovery3-calculator-desktop-20261023`、`recovery3-calculator-implement-20261023`、`recovery3-calculator-final-20261023`下的report.json。

不再调用模型，对既有源码补做了独立诊断：

- 产物自写Logic自测12项通过，单独记录为产品自测，不冒充宿主独立证据。
- 项目原`.venv`启动原生探针失败；直接import CLR进一步读到`_cffi_backend`的DLL加载错误“文件名或扩展名太长”。原安装工具仅import webview曾误报依赖通过，因此补上895c178的Windows原生桥探测。原失败保留在`recovery3-generated-product-gui-20261023/report.json`，直接对照日志为`recovery3-20261023-clr-{deep,short}.log`；两边pywebview/pythonnet/clr_loader/cffi四个包版本相同。
- 使用已有短路径`workflow-gui-runtime`作运行时对照，在**相同产品源码和冻结suite**上通过两个原生启动段共70个实际动作/观测；故意预期999时确实失败并读到空值。前后源码及suite摘要完全相同。证据`recovery3-generated-product-gui-short-runtime-20261023/report.json`。
- 对照直接指定已知app.py入口，没有补造LAUNCH或CORE_CHECK登记，且用了替代解释器；它是生成产品的原生GUI诊断，不是正常交付链或原项目环境资格通过。项目仍未交付。

suite的AC引用存在不等于全部语义已证明：例如清空DOM结果不能证明没有文件写入，显示计算结果不能证明没有网络请求；某些复杂AC只验证了部分观察。宿主执行器可信与模型编写的预期充分性须分开评估。自动规则准备仍保持实验开关，后续需补足无法从DOM观察的独立判据与语义覆盖审阅，不能据本次70步通过宣称完整科研Q或所有业务义务通过。

最终观测汇总：`run-artifacts/recovery3-20261023-outcomes.json`，关联历史汇总、当前项目终态、累计账、原环境失败、替代运行时GUI结果及最终验证日志。

## 尚待完善与操作遗留

仍需真实任务证明从确认意图、冻结独立预期、生成、GUI业务操作到交付的完整链路；在此前保持自动准备默认关闭。PRD内审未决卡与普通需求清单尚未获得本批PRD/UX候选相同的完整重启恢复；不同UI框架/启动参数、逐步骤截图、更强进程隔离和宿主记录回收也仍待适配，不标记完成。

后续实测将home放在短临时路径，日志单独归档到run-artifacts，避免把深层证据路径继续叠到项目venv/DLL路径。此次环境错误及驾驶器缺项属于已记录的混杂因素，不计作模型业务失败。独立规则的语义充分性和非DOM义务应优先补证，不能靠扩大请求数或放松确认/验收门换取“成功”。

测试user-data目录递归清理及随后单文件清理被工具策略拒绝，返回原因仅为 `blocked by policy`，未绕过。运行时加密渠道文件副本已移除；加密Local State和缓存仍保留于受忽略的测试目录。没有写出明文API key。

所有源码与文档分批commit，未push。原有 `production-workflow-v2-20261020.md` 两行未提交补充继续保持原样。
