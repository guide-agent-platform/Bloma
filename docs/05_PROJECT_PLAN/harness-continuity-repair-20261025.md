# 连续执行与暂停恢复修复

2026-10-25。依据真实会话256f1be0-24ac-4c13-8dc0-e08409ec138b的中断诊断实施，基线594e071。用户授权继续改造harness；本轮不代用户续跑真实任务、不新增付费请求，不修改其源码、历史账本或已用额度，不重启现有Bloma。

## 直接问题

原制作流程默认maxTurns=96；实际会话第96轮仍在操作GUI，被硬停。续跑后又在制作阶段160次请求处拒绝，尽管原全任务总上限256未到。原退出路径同时关闭窗口并删除临时数据，续跑先尝试旧窗口，再重建测试数据。即时事件虽发incomplete，持久会话却只写completed，具体停止说明主要在流式事件中，首次原因随后被新状态覆盖。

这些问题是Bloma新增限制、生命周期与记录方式产生的可复现缺陷；不能归因于DeepSeek Flash能力不足。环境下载、错误选择器和产物本身的AI语义质量是另外的缺口，本轮不将它们全部归到同一个原因。

## 本轮实现

- software-v1移除独立96轮截止；由共享总请求、输出、费用准入、活动时限和无进展保护决定停止。制作阶段不再叠加较小160次上限，沿用原任务256次总请求、262144输出token及每响应上限。同一operation、子任务、辅助压缩和继续仍共享原账本；不清零、不迁移用量，不产生新的付费授权。旧lean-v1等历史流程保留原规则。
- 无剩余模型额度时，模型调用前直接保存明确的未完成说明、累计用量及限制。如果已有验收规则，则可停止模型调用、执行实际宿主检查；真实正确才交付，错误和取消不能通过。没有规则时不调用模型反复碰壁。
- 开发状态保存在PROMA_HOME/software-debug-data下，按项目、会话和operation隔离。业务数据、冻结输入描述及Electron profile保留；浏览器localStorage/cookies另存实际storageState。易失进程仍关闭，临时目录仍清理，但不再用清理进程等同销毁开发状态。新operation选择新目录，正式验收继续使用全新隔离数据，不复用开发数据作为PASS。
- 默认inspect_app、显式act/reload拿到已关闭或旧宿主的合法会话ID时，用保留数据创建新实例，返回新ID、resumed_from和新版本。只读查看旧状态可识别interrupted；不会接管旧PID。显式reload不再仅因漏会话ID而拒绝，按本会话活动实例或保留现场解析。跨项目/会话归属校验保持。
- 连接借用服务时保留其数据和进程归属，不因关闭调试而删除服务数据或杀借用进程；自动恢复只信任本宿主开发目录及已知项目默认开发数据目录，不任意采用持久元数据里的外部路径。
- 未完成的终态正式落盘为status=incomplete，包含说明；blocked和外层异常也保存助手消息，不再只发流式文本。已耗尽的继续无需新模型请求即可解释原因。真实completed仍由原验证/交付边界授权。
- 多元素定位立即返回GUI_LOCATOR_AMBIGUOUS、匹配数量及最多4条候选文字，提示has_text/具体selector；数量断言继续允许多个元素。不自动选第一个，也不修改业务预期。
- 修复数量断言的假阳性：property=count、nonempty=true现在要求实际数量大于0，不能因字符串"0"非空而通过。浏览器/Electron及Python原生探针同步；保留真实文本"0"作为普通非空文字的合法性。真实浏览器修复前反例见harness-empty-count-reproduction.log，Python原生反例也加入实际运行。
- 环境探针明确区分持续inspect_app支持的Electron/浏览器与仅正式检查支持的Python/pywebview，减少先换栈再发现观察器不支持的绕路。软件说明明确：摘句只证明检索，mock只证明协议，不能当AI讲解与推导通过。

## 与Proma、Codex的对照

本机Proma上游bf3e98ca61dd8365eceaef876c0f7473700878a6的agent-orchestrator.ts:1475仅在用户设置agentMaxTurns>0时传轮数限制，默认undefined；agent-runtime-guards.ts分别报告error_max_turns/error_max_budget_usd及具体原因。Pi压缩控制也说明压缩后继续原任务。这些是本次实际读到的实现，未联网确认最新上游，也没有整体rebase。

按照[OpenAI官方Codex Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide)，长任务依赖上下文压缩、持续执行和适配模型的工具。该公开资料不能证明Codex没有失败或没有额度限制；用户之前的不同产物也不能当作同条件对照实验。能确定的是：Bloma应减少自己额外制造的截断与状态丢失，工具/模型配合和实际产品质量仍需分别验证，不能只复制提示词。

## 验证证据

首轮harness-continuity-tests.log中，固定SDK回放驱动真实Pi工具链，164次SDK调用及准入计数后实际CLI验收/启动并交付，已经越过原96轮和160请求门槛；没有实际供应商请求，不是新的付费成功样本。开发恢复测试暴露了恢复输入描述在open前校验时未加载的问题，补齐后重验；未关闭冻结输入检查。初次类型检查发现测试env推断缺少ELECTRON_RUN_AS_NODE键，显式标注NodeJS.ProcessEnv后重验。失败日志保留。

harness-continuity-fixed-tests.log：5文件14项通过。包括真实Electron/浏览器取消后数据恢复、原冻结输入再次上传、浏览器存储恢复、指定进程归属、错误输出/多元素定位、共享预算，以及真实Electron宿主强杀后的跨进程恢复。software-debug-crash-result.json记录不同宿主PID、新调试ID、相同数据目录和原端口释放。没有供应商请求；这不是模型质量、用户产物验收或OS沙箱证明。

扩大回归harness-continuity-final-tests.log：32文件177项，175项通过、2项失败。一个是5100文件用例的Windows清理hook超过默认10秒，只调整清理hook到60秒、不改功能断言，harness-continuity-repository-cleanup-tests.log中该文件3项重验通过；另一个旧断言要求预算损坏时不保存任何助手消息，本轮明确要求保存具体失败原因，已改为断言错误落盘且没有“目标已完成”声明，交接定向复验覆盖。原日志保留，不将这次大集合描述为一次全绿。

该集合覆盖software全套、核心GUI/CLI、旧制作、预算、Pi、编排/会话及两类真实宿主崩溃恢复。新增全任务额度用完但已登记规则时，0个新增模型请求下实际正确交付、实际错误拒绝；另用harness-continuity-data-boundary-tests.log验证跨operation/会话数据隔离、拒绝junction重定向且目标不被触碰（1项通过，3项按名称筛选跳过）。

最终交接定向回归4文件24项通过，见harness-continuity-handoff-tests.log，包含错误原因落盘与禁止交付、两种GUI的零数量反例、旧PASS失效与最终收口。类型检查harness-continuity-handoff-types.log、完整构建harness-continuity-handoff-build.log及独立profile实际启动harness-continuity-handoff-smoke.log均通过；首页导入入口、预加载方法和真实只读IPC正常，无捕获的renderer异常。各测试集合重叠，不相加。原用户实例未重启，新构建需要重启Bloma后加载。

## 保留的边界

- 原真实项目仍为未交付；原账本163请求/92481输出未改。运行新版后可在原总预算内继续，新的限制逻辑不再因制作160次单独拒绝。已被旧版本删除的临时测试数据不能凭本修复找回，源码和fixture仍在。
- 暂停可恢复开发数据不等于所有外部副作用恰好一次；崩溃时尚未完成的浏览器存储写入也不保证恢复。测试证明已落盘状态恢复与旧进程不接管。
- 当前持久开发目录按operation保留，尚无自动过期清理策略。正式用户数据、回滚/迁移和独立交付规则保持自己的边界。
- 未证明此次复杂AI学习软件在真实模型下一次即可成功；运行时下载、供应商配置、AI引用/推导语义与完整真实任务仍需实测。独立干净环境、Git增量发布、D4隔离子任务构建等原挂账未被本批自动完成。
