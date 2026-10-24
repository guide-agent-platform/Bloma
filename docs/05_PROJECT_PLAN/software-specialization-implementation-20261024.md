# 软件专精四项能力：实施记录

2026-10-24，用户授权执行四项方案。起点44175a5；原有production-workflow-v2文档两行用户改动保留，不纳入提交。不push，不重启用户实例，不调用付费模型或重跑冻结实验。方案范围与验收条件见software-specialization-four-priorities-20261024.md。

| 批次 | 状态 | 结果与边界 |
| --- | --- | --- |
| A1/A2 持续调试/错误观察 | 已实现并定向验证 | 正常Electron/浏览器入口、跨调用状态、受管理进程、日志与版本绑定；见下文 |
| A3 文件交互 | 待实施 | 上传、下载、键盘/拖拽及冻结文件fixture |
| B 增量修改/恢复 | 待实施 | 稳定发布目录、已有行为及迁移恢复 |
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

## 后续验证原则

每批同时接上schema、运行校验、权限、日志/反馈、进展和呈现；真实坏输入与恢复路径纳入回归。固定SDK回放用于机制验证，真实模型质量和成本另行受控测量。当前开发机、隔离数据和本机HTTP成功不能冒充新机器安装或付费供应商效果。
