# 通知与声音设置修复

日期：2026-10-10。起点 `sprint2 / 374d529`。用户截图显示设置标题居中而声音内容贴左，并反馈试听与自动声音均无声。

## 原因与修复

声音页只有 maxWidth，没有居中容器。现与设置头部共用 720px border-box 宽度、20px 内边距与自动居中；窄屏试听操作可换行，使用现有 Play 图标，结果或失败原因直接显示。

主窗 CSP 原 default-src 为 none 且缺少 media-src，所有 MP3 都被阻断。Vite 将部分小文件内联为 data: 音频，因此新增 `media-src 'self' data:`，只允许现有本地与内联素材。主窗明确允许后台自动提示音。没有扩大外部音频来源，也没有改变隔离或 Node 集成。

实际 Electron 的浏览器 speechSynthesis.getVoices() 为空，本机 Windows 则有中文 System.Speech 嗓音。新增共享类型 → IPC handler → preload → renderer 的受限播报链：1–300 字文本、0–1 有限音量；PowerShell 执行固定编码脚本，文字经 UTF-8 JSON stdin 输入，不插入脚本；选择已启用中文嗓音、隐藏进程窗口、30 秒超时并清理进程。识别模型准备与转写接口保持原语义。无中文嗓音或启动失败返回可显示的原因。

历史设置校验声音包、布尔值与音量，避免损坏设置导致静默。手动试听绕过自动总开关和轻提醒开关，但仍尊重音量；音量为零显示调高音量提示。自动语音同样受总开关控制。提示音与人声分开试听。

## 触发时机

| 事件 | 行为 |
| --- | --- |
| user_decision_required | 需求/审查等选择卡出现时播放 checkpoint，播报需要确认 |
| UX/MVP 的 user_decision_required | 对应确认卡出现时播放 blocked 与人声 |
| permission_requested | 操作授权请求出现时播放 checkpoint 与人声 |
| ux_sketch_ready / mvp_review_ready | 不单独提醒，避免与随后确认卡重复 |
| stage_changed → delivered/completed | 完成交付提示音与人声，同项目两种完成阶段只报一次 |
| delegation_completed | 轻提醒，默认关闭；不播人声 |
| 普通 completed / ready | 普通对话结束或准备阶段，不冒充项目完成 |

按事件 ID 有界去重；项目完成状态有界去重，重新进入工作阶段可再次提醒完成。后台项目不再使用当前另一个项目的名字播报。

## 验证与边界

- typecheck、build 通过；全量单测 231 文件 / 2179 用例通过。
- 声音路由、损坏设置、开关语义、预览、播放失败、IPC 校验、本地脚本隔离、缺嗓音与超时针对性测试：4 文件 / 24 用例通过。
- 独立 PROMA_HOME/user-data 的真实 Electron：12 个 MP3 均由真实 HTMLMediaElement 播放至 ended，包含内联 data: 与 file:；没有模拟成功播放。
- 设置界面人声按钮经真实 preload/IPC/Windows System.Speech 返回 spoken:true；自动音效与自动人声均关闭时手动试听仍成功。非法音量经真实 IPC 返回 VALIDATION_ERROR。
- 真实事件桥注入合成事件，验证总开关、UX ready 静音、确认卡播放一次、事件重放与 delivered/completed 去重。此项不作为新一轮真实模型项目执行的证明。
- 1080、736、360 CSS px 下标题与内容的 x/width 相同，无横向溢出；截图已查看。
- 音效解码/播放结束与系统播报返回已验证；未通过外部录音或人工听辨验证物理扬声器输出。
- 已有 Google 字体 stylesheet 被 style-src 拦截的提示另行记录在 existing_warnings。本批未调整外部字体或其 CSP，音频无 CSP 错误。

证据：`run-artifacts/sound-fixed/report.json`、`settings-sound.png`、`run-artifacts/check-sound-fixed.mjs`、`sound-electron.log`、`sound-unit.log`、`sound-all-unit.log`、`sound-typecheck.log`、`sound-build.log`。这些运行产物按仓库约定不入 Git，源代码与针对性测试入 Git。

查看了本地 Proma 上游 `bf3e98c` 的通知声音设置校验方式作对照，没有复制新播报实现。既有音效素材继续遵循项目 AGPL 同源约定。旧运行实例需要重启加载本批 main/preload/renderer 构建。
