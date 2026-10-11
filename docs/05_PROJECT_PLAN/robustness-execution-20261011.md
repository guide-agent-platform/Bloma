# 稳健性计划执行结果

## 批 0：基线与固定矩阵

2026-10-11，执行基线 `0375a2e`。固定用户任务、正例期望、负例与恢复序列已保存到 `tests/fixtures/robustness/cases.json`，中文音频样本为本机 TTS 生成，不是用户录音。任务分语音、记账、文件处理，每类 quick/longterm，确定性业务回放 3 次；这些新生成任务尚未执行。

只读基线：`run-artifacts/robustness-baseline.json`，包含源码、依赖锁、有效本机覆盖提示词和原语音产物哈希；不保存密钥或覆盖提示词正文。每次实际运行另记解析后的渠道，不把磁盘配置存在视为渠道实测通过。

在原产物 Python 环境和缓存 SenseVoice 模型上重新执行接口探针：二维 `(6400,1)` float32 仍抛 TypeError，连续一维输入可解码；固定中文 WAV 输出「我们下周四下午3点开会。」。零波形会产生「嗯。」等文本，说明静音不能仅靠“输出非空”判通过。证据：`run-artifacts/robustness-baseline-voice.log`、`voice-shape-probe.json`。原产物未变；未打开 GUI、麦克风或下载模型。

实际收口核对：quick 的安全/冒烟 null 可继续交付，longterm 冒烟 null 可进入成品确认；verify 安全扫描异常返回 null；PQ 旧 qualified 在重新读声明前返回；checkpoint 按阶段复用。以下批次会分别修复并测试，不把源码核对写成运行复现。

本地上游核对版本 `bf3e98ca61dd8365eceaef876c0f7473700878a6`。参考 `apps/electron/src/main/lib/agent-session-usage.ts` 的坏行容错和 cache token 口径；该模块解决会话上下文占用，不能直接代替项目累计账本。当前 Bloma 的桌面核心证据与共享 PQ 缓存没有可直接移植的上游等价实现，采用现有模块局部适配。

基线捕获首次遇到沙箱内 Node 子进程启动 git 的 EPERM；改为调用端传入已经核对的 Git ID 后完成。该失败是捕获工具的权限问题，不计入生成产物失败。

## 批 1：核心收口和旧证据失效

quick 交付、longterm 成品过目与最终确认接入同一个核心检查。最小 `CORE_CHECK.json` 注册项目脚本和 P0 映射，平台复用现有受限驱动执行器真实执行，记录 PASS/FAIL/环境阻塞/未验证；缺入口、空回读、mock 覆盖或关键 GUI 场景缺失不能交付。产物声明的 audio/microphone 标签不能证明真实语音能力，暂时仍记待验证，宿主音频探针将在批 3 接入。普通业务断言仍由产物驱动编写，独立验证其充分性属于批 5；当前并不证明所有自写断言都正确。

PQ 复用绑定代码、调用声明、渠道端点/协议/模型/凭据摘要；checkpoint 绑定代码与需求摘要，旧无指纹记录不复用。验证输入无法读取或含链接时禁用复用。指纹忽略报告、业务数据和 venv，不保存密钥。必要冒烟/安全检查返回 null 不再通向交付，verify 安全检查异常返回环境阻塞。

本次针对性测试 8 文件/123 例通过，含核心判定、quick 缺证据、PQ 代码/声明/渠道变化、旧 checkpoint、既有路由/调度员、提示词装配和架构约束。类型检查通过。证据 `run-artifacts/robustness-batch1-tests.log`、`robustness-typecheck.log`。测试启动需允许本地编译子进程；未启动用户应用。首次核心正例暴露带空格场景名读回不匹配，已按完整锚点修复并复验。
