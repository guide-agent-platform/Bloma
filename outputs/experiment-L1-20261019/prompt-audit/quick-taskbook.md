快速做一个能用的应用（快速模式：平台已物化骨架 v2 到项目根——app.py 三层 + ui/ 组件库 + requirements.txt；无工程契约/驱动断言要求）：
1. 按 PRD 背板功能清单实现完整可用的 Windows 桌面程序——全部业务功能真实可用，程序能跑起来；
2. 三层纪律：小工具可扩展 Logic；复杂业务按职责拆 core/、storage/ 等模块，app.py 保留 Logic 导入/门面（from app import Logic 可用）及现有启动/验证模式；业务模块不 import UI。Api 桥转调真实业务层，ui/ 只渲染与收集输入，经 window.App.call 调桥；架构说明与实际模块/持久化方案一致；
3. UI 按已确认设计实现：先 read 00_UX/confirmed.html（如有）与 ui/PATTERNS.md；布局、组件外观和 CSS 可按设计定制，颜色/间距/字阶由项目 tokens.css 统一管理并以 var(--*) 复用，骨架仅作行为示例；**禁 npm/CDN/外链字体/构建步骤——界面资产离线可用；已确认的联网业务按 PRD/产品形状实现**；
4. 状态反馈唯一呈现位 App.show（running→成功给数量/部分成功分别计数/失败带下一步）；耗时>1s 操作 Python 侧线程+evaluate_js 推送（照抄 app.py push_update 注释样例），禁止 Api 桥里同步长计算；执行中禁用触发按钮防重复提交；输入失败恢复原值（index.html onSend 即标准形态：失败分支 input.value = text）；
5. 按你自行产生的任务分解组织实现（依赖与解释器路径如实装配，不编造运行结果）：子会话有 run_project_script（真实运行项目根内 .py，每次≤90s、至多 12 次）——任务书里要求它写无头自测脚本（import app 测 Logic 层）并当场跑到绿、附真实红绿结果，不要只写不跑；子会话还有 install_packages（声明制 .venv 安装：requirements 声明→安装→import 回读；装后 LAUNCH command 用 .venv\Scripts\python.exe；venv 统一用 .venv 这一个名字，不要自建 .venv-probe 之类异名 venv——快照/安全扫描/交付清单靠标记识别，异名会漏）；
6. 可用组件速查（声明安装，坑与降级详卡见 install_packages 工具）：
- openai（import openai）：LLM API 调用（OpenAI 兼容端点——AI 对话/生成/总结类产品核心；任何 openai 兼容服务均可配）｜坑：错误四态必须各自处理并给用户可读反馈：401 key 无效/404 模型不存在/429 限流/超时——不允许任何错误静默或崩溃；key 从本地配置文件读（禁硬编码进代码/文档）；端点与模型名做成设置界面可配；长响应放后台线程防阻塞 UI；内置 mock 模式（环境变量 LLM_PROVIDER=mock 切固定响应——自测与驱动验证用，断言分层：请求合法性/错误处理严格断言，生成内容断言质量指标）｜降级：LLM_PROVIDER=mock 仅用于本地测试；不能代替真实模型功能交付。内置 llm_client.py 提供实际 HTTP 客户端。｜[实证]
- pywebview（import webview）：桌面 GUI 渲染壳（HTML 渲染层，骨架 v2 标配：pywebview+系统 WebView2，Win10+ 自带零安装）｜坑：import 名是 webview 不是 pywebview（探测/断言勿写错）；api 桥调用到达非主线程——Python 端不得直接摸 UI，一律 evaluate_js 推送（骨架 push_update 样例）；evaluate_js 不 await Promise，异步桥调用走骨架 --drive-port 的 /call 通道 [实证]｜降级：无（骨架 v2 标配渲染壳；缺它 ui/ 无法呈现）｜[实证]
- pynput（import pynput）：全局热键监听与键鼠注入｜坑：监听回调在独立线程，操作 GUI 状态需回主线程调度 [推断]；管理员权限程序内注入受限 [文证]｜降级：keyboard 库（同类线程模型）｜[文证]
- pystray（import pystray）：系统托盘图标与菜单（配 Pillow 画图标）｜坑：托盘菜单回调在独立线程，直接操作 GUI 需线程间通信 [文证]；icon.run() 阻塞主线程，业务线程 daemon 化｜降级：无托盘：主窗口最小化 + 热键唤起｜[文证]
- Pillow（import PIL）：图像处理/图标生成（pystray 配套）｜坑：import 名是 PIL 不是 Pillow（探测/断言勿写错）｜降级：无（图像刚需）｜[实证]
- sounddevice（import sounddevice）：录音/播放（numpy 数组直出，便于接 ASR）｜坑：portaudio 随 pip wheel 自带（Windows 免装系统库，与 Linux 不同）；无麦克风设备时 query_devices 可能为空 [文证]｜降级：winsound 标准库（纯播放提示音）｜[文证]
- pyperclip（import pyperclip）：剪贴板读写｜坑：Windows 侧无 Linux xclip 的 fork-daemon 挂死问题 [文证]｜降级：tkinter clipboard（需窗口与消息循环）｜[文证]
- winotify（import winotify）：Windows 原生 Toast 通知｜坑：通知需应用有 AUMID 上下文，脚本进程下用默认注册即可 [文证]｜降级：plyer（跨平台但依赖更重）｜[文证]
- sherpa-onnx（import sherpa_onnx）：本地离线语音识别（SenseVoice，中/英/粤/日/韩；录音用 sounddevice）｜坑：复用平台 speech_runtime.py：SpeechEngine 适配一维/录音列数组/多声道与采样率，StreamingRecorder 回调仅入队、工作线程识别；on_text 给累计文字，UI 线程更新。模型准备放后台、失败可重试。资源目录可配置，下载有时限/取消/校验。实测 numpy 2.5.4 + sherpa-onnx 1.13.8 + sounddevice 0.5.6 的固定音频及模拟回调；真人采集需单独测试｜降级：文本输入可作辅助入口，不能当作语音核心能力验收通过｜[实证]
- 内置 file_plan_guard.py（随 pywebview 物化，不另装 pip）：前缀改名前用 validate_prefix_plan(folder,prefix,plan) 校验当前输入与快照、文件名和目录边界；输入/扫描变化立即失效旧预览，异步旧响应不能重新启用执行。固定反例与隔离 GUI 回放有证据，不保证操作期间的原子隔离。
- 内置 file_transactions.py：build_prefix_plan / execute_prefix_plan / undo_prefix_rename；源文件变化、目标冲突先拒绝，操作异常恢复原文件名并如实返回恢复路径，进度通知异常独立记录。ui/preview-state.js 的 createPreviewGuard 绑定输入/扫描版本，旧响应不能启用执行，take() 只消费一次。必须接入实际业务，不能只把组件放进目录。
- 内置 llm_client.py：LlmClient.generate({prompt,config:{endpoint,model,api_key,provider,timeout}}) 执行真实 HTTP 请求，区分未配置、鉴权、模型、限流、超时、网络与响应错误；真实功能不能只实现 mock。宿主本机 HTTP 探针不消耗模型额度。
7. 产出 DELIVERY.md 到项目根（不是子目录内——门禁按项目根检查）。面向不懂编程的用户，按四段写：①本版本已确认能做——每条注明验证方式（自测结果如实引用，没验证的明说）；②目前限制——做不完/做不到的如实列出；③给你的建议——怎么开始用、先试什么；④你的数据——数据存在哪、怎么备份、换电脑会不会丢（怎么带走）。不要求 contract.json 与驱动断言；
8. 产出 LAUNCH.json 到项目根（平台交付前会真实启动一次验证，这是快速模式的验收门）：{"schema_version":1,"command":["python","app.py"],"window_title":"<与 webview.create_window 第一参数完全一致的窗口标题>"}——command 相对项目根；GUI 程序 window_title 必填（平台联合判定与截窗都靠标题找窗）；--self-check 与 --drive-port 模式不得删除或改名（平台依赖）；
9. 体验纪律（UX 契约线，2026-10-06）：PRD「体验要求」（无则按通用九态）是交付契约——①核心操作成功/失败反馈可见（App.show），空态给引导不是空白；②禁 alert()/confirm()/prompt() 弹窗当正常流反馈（模态弹窗会卡死驱动与用户流）；③长任务不阻塞 UI（Python 线程+evaluate_js 推送）；④按已确认设计统一视觉，允许定制组件、布局与项目 tokens；保留 .w-banner 与 App.show 状态反馈。
10. 形状纪律（批9 2026-10-07）：产品形状已随 PRD 冻结——若实现中发现形状不成立，停下输出显式变更声明（当前形状/拟切换/原因/影响四要素）等待确认，禁止静默切换。
{{shape_brief}}
【调度实验运行协议】
需求、初始产物和验收已冻结。自行制定任务分解，使用 experiment_plan 登记任务、依赖与写入范围；不规定任务数量或具体拆分答案。
writes只接受具体文件路径或以 / 结尾的目录前缀，不支持 *、**、? 通配符；不合法范围会在锁定计划前拒绝。
宿主必需交付文件（项目根相对路径）：CORE_CHECK.json、DELIVERY.md、LAUNCH.json。计划写入范围必须覆盖这些文件；首次派遣前缺失会明确拒绝，可重新提交你自己的计划。测试脚本名称与业务分解仍由你决定。
实现者最多 2 名，任务登记最多 16 项。delegate_agent 用 task_ids 分配任务；continue_delegation 可分配尚未执行的已登记任务或发送修复反馈。
一次委派或续接分配的一批任务，须等该实现者整轮成功结束后才释放给其他实现者的依赖；运行中不会提前发布其中单个任务已完成的事件。请据此安排你自己的依赖与并行派发。
CORE_CHECK.json 的 scenarios 最多 64 条，场景名须唯一；合并重复场景时仍须覆盖全部已确认需求。
角色、模型由宿主实验配置绑定，不自行修改。规划登记只定义执行协议，不表示任务或产物已验收；是否启动、分配、等待、集成和修复由你决定。历史证据不是当前版本已通过证明。
