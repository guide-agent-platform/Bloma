# 软件专精四项能力：实施记录

2026-10-24，用户授权执行四项方案。起点44175a5；原有production-workflow-v2文档两行用户改动保留，不纳入提交。不push，不重启用户实例，不调用付费模型或重跑冻结实验。方案范围与验收条件见software-specialization-four-priorities-20261024.md。

| 批次 | 状态 | 结果与边界 |
| --- | --- | --- |
| A1/A2 持续调试/错误观察 | 已实现并定向验证 | 正常Electron/浏览器入口、跨调用状态、受管理进程、日志与版本绑定；见下文 |
| A3 文件交互 | 已实现并定向验证 | 真实上传/原生Open、下载、键盘/滚动/拖拽；冻结二进制fixture，PDF/Word真实提取与损坏文件反馈 |
| B 增量修改/恢复 | 已实现并定向验证 | 候选实际验证、稳定目录、既有断言保留、数据副本迁移/恢复与上一可用版本入口 |
| C 环境/独立交付 | 待实施 | 运行时/依赖与成品资格；干净机器验证需真实环境 |
| D 工程接入/长期任务 | 待实施 | 接入已有工程、检索与可继续现场 |

## A1/A2 实施

参考本地Proma bf3e98ca61dd8365eceaef876c0f7473700878a6的browser-observation-policy/browser-profile-policy：有界观察、工作区归属和profile隔离。Bloma不照搬其主窗浏览器控制器；接入已有项目正常入口与Playwright DOM观察，仍由Pi负责模型循环。

inspect_app保留默认once，增加open/act/read/reload/close。open返回debug_session_id，后续操作复用同一实例和隔离数据；read可按since_seq取增量日志。共享GUI字段schema，开发动作可单独执行；正式验收仍要求实际断言与冻结目标。

Electron调试通过受管理进程启动正常程序，并连接本机CDP；该进程仍处于父管道监督的树内。浏览器调试可启动自身后端，也可连接本项目/本会话已有ready服务；不接管用户正式程序或重启后的持久PID。关闭借用的调试页面不关闭原服务，明确reload才重启Agent拥有的服务。

源码变化时观察标记stale；reload重启后端/桌面入口，保留隔离持久数据，再递增版本。仅刷新页面不足以证明后端代码已更新。旧日志保留原版本编号。

观察renderer异常、console、HTTP失败/状态和动作关联；不记录请求头/正文，URL去查询参数；通用日志脱敏覆盖Bearer、token、cookie和已知宿主秘密。完整有界日志留本机，工具返回近期窗口。窗口/服务/页面与截图不是最终交付凭据。

主制作结束或取消时先关闭调试资源再做宿主验收；活跃调试期间不派发共享目录写入者。退出Bloma会等待调试清理。对已关闭实例只读历史，不采用其磁盘PID。临时profile清理前验证其解析路径位于系统临时目录且带本批创建前缀；用户正式数据不在此目录。

初始测试发现Electron夹具全局const api与preload导出的同名属性冲突，同时发现空stack会掩盖错误message；已修正夹具并改进错误文本回退。保留失败specialize-a1-tests.log。

specialize-a1-managed-tests.log中3项实际Electron/浏览器测试通过：跨调用保留状态、错误捕获/脱敏、真正更新后端版本并保留数据、取消释放端口、借用服务关闭后继续可用。specialize-a1-commit-tests.log中3文件/13项通过，含协作所有权和进程后代回收；specialize-a1-final-tests.log中3文件/16项通过，含真实Pi契约和制作收口兼容。类型最终见specialize-a1-final-types3.log，构建见specialize-a1-release-build.log；集合重叠不相加。工具只返回近期有界日志和log_cursor，避免每轮重复发送完整诊断。

## A3 文件交互

统一GUI协议新增upload/native_upload/download/expect_file/press/scroll/drag。输入文件限制在项目及隔离input目录，输出限制在隔离outputs目录，拒绝链接越界。源文件冻结为宿主内容摘要与字节，登记后源文件变化不能替换输入；损坏宿主冻结字节返回unverified，不沿用旧PASS。持续调试可复用已登记输入，追加新输入不重新冻结旧源文件。单文件20MiB、总计64MiB，二进制不进入模型文本。

Windows原生Open适配器只操作本次创建的活进程树及其拥有的对话框，核对进程身份；不使用全局焦点、SendKeys或磁盘PID。真实Electron测试发现UIA原生窗口嵌套与ComboBox包装器差异；最终选择精确文件名控件与Open按钮，要求对话框实际关闭，并由产品读取文件内容的独立断言确认。失败日志保留，未弱化预期。

specialize-a3-final-tests.log：2文件6项实际Electron/浏览器交互通过。specialize-a3-persistent-final.log：追加文件后复用原冻结内容的3项持续会话测试通过，与前集合重叠。specialize-a3-contract-tests.log：2文件16项通过，含原Python原生GUI与Pi契约回放。类型specialize-a3-final-types.log、构建specialize-a3-final-build.log通过（最后的fixture追加修正另补类型和构建）。

specialize-a3-document-fixed.log：真实PDF.js与Mammoth文本提取、浏览器导入、导出读回和损坏PDF错误反馈1项通过，详情software-document-import-acceptance.json。可选依赖从本机已有学习工具读取，不新增旧版库到Bloma依赖。该证据仅覆盖文本提取，不证明PDF页面渲染、干净机器安装或真实模型成本质量。

## B 稳定发布与增量维护

software-v1宿主在验证前复制候选，实际核心/GUI/CLI与正常启动都从候选入口运行；安全扫描沿原工程，收口再次核对原工程、候选全量字节和当前目标/规则版本。通过且预算落盘后才发布稳定指针。用户启动使用最后通过的稳定目录；制作新版本时仍可启动已发布版本。历史completed工程首次启动只获得隔离快照，不补造新PASS。

成品摘要包含exe/asar/dll/资源和依赖，大文件按1MiB流式摘要；8GiB/25万文件是显式上限。根node_modules/.venv按完整内容复用独立缓存，源码编辑不会改到缓存；不是链接到可变开发依赖，也不使用硬链接。每次启动核对发布字节，缓存或二进制变化使旧证据不可用。工程源链接暂不支持，遇到时明确拒绝，不能声称已覆盖任意monorepo/可迁移Python环境。

已通过版本保存按功能语义绑定的回归基线。确认新增能力时，未改变的旧需求仍需原断言和输入；selector可以修复，用户明确改变或删除的预期不会被旧基线锁死。新候选实际执行登记的检查，旧PASS不充当新版本PASS。没有新增模型审查角色。

用户保存并停止已知实例后，在独立数据generation上迁移、读回和启动，成功才原子切换数据指针。DATA_UPDATE.json使用产品已有命令，提供schema、按旧schema的迁移和verify，不依赖旧server/routes结构。迁移失败、读回失败或启动失败不替换当前数据。SQLite关闭后的数据库与WAL等全部复制并摘要复核；仍在写入或带源链接的副本不能通过。重启后可能存活的旧PID只做保守存活判断，不能接管/终止或直接复制其数据。

交付面板提供备份选择与单独恢复确认，恢复前再备份当前数据；也提供上一可用程序入口。代码回退不自动回退数据，schema不兼容且无明确迁移时拒绝；用户可以显式组合旧程序和选定数据备份。点选预览读取当前数据generation的副本。

specialize-b-final-tests.log：6文件19项通过，包括真实Pi制作/构建后在候选验证并交付、编辑工作副本后仍启动旧成品、依赖缓存复用与篡改失效、真实SQLite的100条固定ID/内容迁移失败保留、升级搜索/标签、恢复读回及恢复前备份最新记录、原Electron点选兼容、恢复UI确认和旧行为基线。集合有重叠，不与之前日志相加。类型最初发现新增mock的零参数tuple错误，已修复；最终类型specialize-b-final-types-fixed.log和构建specialize-b-final-build.log通过。最后的恢复目标状态修复另有UI定向复验。

保留specialize-b-real-update.log（测试误读被UI截断的stdout）、specialize-b-candidate-acceptance.log（样例SQL升级后列数错误）失败证据。修复真实样例的INSERT字段后，specialize-b-fallback-acceptance.log中5项通过，含迁移失败后实际启动旧程序。该批仍是本机机制/固定SDK回放，未证明干净环境或在线模型成本收益。

## 后续验证原则

每批同时接上schema、运行校验、权限、日志/反馈、进展和呈现；真实坏输入与恢复路径纳入回归。固定SDK回放用于机制验证，真实模型质量和成本另行受控测量。当前开发机、隔离数据和本机HTTP成功不能冒充新机器安装或付费供应商效果。
