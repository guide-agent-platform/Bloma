协作子任务（role=implement）：
[t2_ui_design] 按已确认设计实现 UI（只写 ui/ 目录；不得改 app.py、core/、bridge.js、kit.css、preview-state.js、correction.js）。先 read：00_UX/confirmed.html（视觉权威，逐值落实）、00_UX/confirmed.json（交互与状态）、ui/PATTERNS.md、ui/kit.css、ui/bridge.js、ui/tokens.css、app.py（了解桥与窗口标题，勿改）。

写入：ui/tokens.css（重写/扩展）、ui/app.css（新建）、ui/index.html（重写）。

【Api 契约】（另一实现者正在并行实现，按此对接，勿自行改协议）App.call 全部返回 envelope：
- list_tasks(view) view∈{"all","open","done"} → {ok:true, view, tasks:[{id,title,done,seq}…按新增序], counts:{all,open,done}}
- add_task(title) → {ok:true,task,counts}；空白标题 → {ok:false,error:"标题不能为空"}
- toggle_task(id) → {ok:true,task,counts}；delete_task(id) → {ok:true,removed_id,counts}（不存在 {ok:false,error}）。
所有操作瞬时完成，直接 await，无需轮询后台。

【设计落实】把 confirmed.html 的设计值搬进 tokens.css 并以 var(--*) 复用：--desk:#eef1f4、--panel:#fff、--ink:#26313a、--ink-soft:#5b6a76、--ink-faint:#8b98a3、--line:#dde3e8、--amber:#d98324、--amber-soft:#fbf0e1、--amber-deep:#a9621a、--sage:#6b8f71、--sage-soft:#eef3ee、--navy:#2f3d49、--navy-soft:#e6eaee、--danger:#b4553f；圆角 8px、卡片 1px 描边 + 轻投影、等宽数字用 Consolas。kit.css 引用的既有变量名（--bg/--surface/--line/--text/--font/--fs-*/--s*/--r-*/--shadow-* 等）必须继续有定义且取值与设计一致（如 --bg→desk、--surface→panel、--text→ink、--primary 系→amber、--ok→sage）。全部界面样式走 var(--*)，禁外链字体/CDN。

【布局】（沿用 confirmed.html 结构，容器可保留 w-app/w-side/w-main 类名并在 app.css 覆写）左栏 212px：品牌（琥珀色标 + 「便签板/离线待办」）、「视图」标签 + 三个竖排视图按钮（全部/未完成/已完成，右侧计数，选中态 navy 填充白字，aria-pressed）；底部「本地保存 · 无需联网」徽标与说明文字。主区：标题行（按当前视图显示 全部任务/未完成任务/已完成任务 + meta「N 条 · X 未完成 / Y 已完成」等宽数字）；快速记录条 composer（输入框 + 琥珀「＋新增」按钮，:focus-within 琥珀描边光晕）三种视图下恒可见可用；列表头「按新增顺序排列」+「1 → N」；任务行 = 左侧 4px 色条（未完成 amber/已完成 sage）+ 20px 圆形勾选按钮（完成后 sage 填白勾，aria-pressed）+ 标题（完成后变淡加删除线）+ 状态标签（未完成 amber-soft/已完成 sage-soft）+ 行尾删除图标按钮（垃圾桶 SVG，悬停变红）。空态两套文案：全部空→「还没有任务/在上方输入一条待办，按回车或点「新增」即可保存到本机。」；筛选空→「这个视图里还没有任务/切换到其他视图查看，或在上方新增一条待办。」。≤760px：左栏折叠为顶部横条、composer 换行、新增按钮占满一行、隐藏状态标签。

【行为】currentView 初始 "all"，存 UI 内存（BR-009：切换后保持，不写盘；重启默认 all）。装载与每次增/勾/删后调 list_tasks(currentView) 重渲染列表、计数、标题行、1→N 序号；当前视图不变。提交（回车或按钮）：运行中禁用按钮防重复；成功 App.show("success","已新增 1 条任务") 且输入框清空；失败 App.show("failed", error, "请输入标题后重试")，输入框保留原值并给 composer 错误描边 + 行内提示「标题不能为空」（输入时自动清除；对应草图 UI-027）。空白校验以 Python 返回为准，UI 不得自行添加任务。勾选行内即时反映；删除成功 App.show("success","已删除 1 条任务，剩余 N 条")。加载失败 App.show("failed","加载失败…","请重启程序重试")。禁 alert/confirm/prompt。

【必须保留】<div class="w-banner"></div>；bridge.js、preview-state.js、correction.js 三个 <script>；data-bloma-id 与 data-interaction-id 稳定定位标记（对应草图 UI-001…UI-029）；GUI 自动化 DOM 契约：input#task-input[data-interaction-id="UI-002"]、按钮#btn-add[data-interaction-id="UI-006"]、.view-btn[data-view="all|open|done"]（内含 .count）、列表容器#task-list、行 article.task(.done) > button.check + .task-title + .task-state + button.del、空态 .empty>.empty-title+.empty-sub。<title>离线待办清单</title>（与窗口标题一致）。不复制草图纠正层脚本/样式与 6 条示例数据——列表数据一律来自 Python。

写完跑 `.venv\Scripts\python.exe app.py --self-check` 确认资产齐备（它不验证视觉）。视觉与交互正确性由本线后续 gui_check 任务端到端验证，届时按反馈修复。00_UX 设计是权威，不要自行重新设计。
依赖：
写入范围：ui/
调度反馈（保持已确认需求）：按已确认设计实现 UI（只写 ui/ 目录；不得改 app.py、core/、bridge.js、kit.css、preview-state.js、correction.js）。先 read：00_UX/confirmed.html（视觉权威，逐值落实）、00_UX/confirmed.json（交互与状态）、ui/PATTERNS.md、ui/kit.css、ui/bridge.js、ui/tokens.css、app.py（了解桥与窗口标题，勿改）。

写入：ui/tokens.css（重写/扩展）、ui/app.css（新建）、ui/index.html（重写）。

【Api 契约】（另一实现者正在并行实现，按此对接，勿自行改协议）App.call 全部返回 envelope：
- list_tasks(view) view∈{"all","open","done"} → {ok:true, view, tasks:[{id,title,done,seq}…按新增序], counts:{all,open,done}}
- add_task(title) → {ok:true,task,counts}；空白标题 → {ok:false,error:"标题不能为空"}
- toggle_task(id) → {ok:true,task,counts}；delete_task(id) → {ok:true,removed_id,counts}（不存在 {ok:false,error}）。
所有操作瞬时完成，直接 await，无需轮询后台。

【设计落实】把 confirmed.html 的设计值搬进 tokens.css 并以 var(--*) 复用：--desk:#eef1f4、--panel:#fff、--ink:#26313a、--ink-soft:#5b6a76、--ink-faint:#8b98a3、--line:#dde3e8、--amber:#d98324、--amber-soft:#fbf0e1、--amber-deep:#a9621a、--sage:#6b8f71、--sage-soft:#eef3ee、--navy:#2f3d49、--navy-soft:#e6eaee、--danger:#b4553f；圆角 8px、卡片 1px 描边 + 轻投影、等宽数字用 Consolas。kit.css 引用的既有变量名（--bg/--surface/--line/--text/--font/--fs-*/--s*/--r-*/--shadow-* 等）必须继续有定义且取值与设计一致（如 --bg→desk、--surface→panel、--text→ink、--primary 系→amber、--ok→sage）。全部界面样式走 var(--*)，禁外链字体/CDN。

【布局】（沿用 confirmed.html 结构，容器可保留 w-app/w-side/w-main 类名并在 app.css 覆写）左栏 212px：品牌（琥珀色标 + 「便签板/离线待办」）、「视图」标签 + 三个竖排视图按钮（全部/未完成/已完成，右侧计数，选中态 navy 填充白字，aria-pressed）；底部「本地保存 · 无需联网」徽标与说明文字。主区：标题行（按当前视图显示 全部任务/未完成任务/已完成任务 + meta「N 条 · X 未完成 / Y 已完成」等宽数字）；快速记录条 composer（输入框 + 琥珀「＋新增」按钮，:focus-within 琥珀描边光晕）三种视图下恒可见可用；列表头「按新增顺序排列」+「1 → N」；任务行 = 左侧 4px 色条（未完成 amber/已完成 sage）+ 20px 圆形勾选按钮（完成后 sage 填白勾，aria-pressed）+ 标题（完成后变淡加删除线）+ 状态标签（未完成 amber-soft/已完成 sage-soft）+ 行尾删除图标按钮（垃圾桶 SVG，悬停变红）。空态两套文案：全部空→「还没有任务/在上方输入一条待办，按回车或点「新增」即可保存到本机。」；筛选空→「这个视图里还没有任务/切换到其他视图查看，或在上方新增一条待办。」。≤760px：左栏折叠为顶部横条、composer 换行、新增按钮占满一行、隐藏状态标签。

【行为】currentView 初始 "all"，存 UI 内存（BR-009：切换后保持，不写盘；重启默认 all）。装载与每次增/勾/删后调 list_tasks(currentView) 重渲染列表、计数、标题行、1→N 序号；当前视图不变。提交（回车或按钮）：运行中禁用按钮防重复；成功 App.show("success","已新增 1 条任务") 且输入框清空；失败 App.show("failed", error, "请输入标题后重试")，输入框保留原值并给 composer 错误描边 + 行内提示「标题不能为空」（输入时自动清除；对应草图 UI-027）。空白校验以 Python 返回为准，UI 不得自行添加任务。勾选行内即时反映；删除成功 App.show("success","已删除 1 条任务，剩余 N 条")。加载失败 App.show("failed","加载失败…","请重启程序重试")。禁 alert/confirm/prompt。

【必须保留】<div class="w-banner"></div>；bridge.js、preview-state.js、correction.js 三个 <script>；data-bloma-id 与 data-interaction-id 稳定定位标记（对应草图 UI-001…UI-029）；GUI 自动化 DOM 契约：input#task-input[data-interaction-id="UI-002"]、按钮#btn-add[data-interaction-id="UI-006"]、.view-btn[data-view="all|open|done"]（内含 .count）、列表容器#task-list、行 article.task(.done) > button.check + .task-title + .task-state + button.del、空态 .empty>.empty-title+.empty-sub。<title>离线待办清单</title>（与窗口标题一致）。不复制草图纠正层脚本/样式与 6 条示例数据——列表数据一律来自 Python。

写完跑 `.venv\Scripts\python.exe app.py --self-check` 确认资产齐备（它不验证视觉）。视觉与交互正确性由后续 gui_check 任务端到端验证，届时按反馈修复。00_UX 设计是权威，不要自行重新设计。

完成后用简洁文本输出结果摘要（关键发现/完成清单/未完成项与原因）。最终回复以一行「结论:」开头的标记句总结（会被上下文压缩保留）。

【执行预算】本轮上限 100 轮，每轮为一次模型请求。沿用历史中的已读事实，避免重复通读；保留最后约 1/4 轮数用于真实验证与交付收口。未完成时明确列出未落盘/未验证项，不得声称工作已完成。
