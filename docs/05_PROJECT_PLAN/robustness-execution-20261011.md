# 稳健性计划执行结果

## 批 0：基线与固定矩阵

2026-10-11，执行基线 `0375a2e`。固定用户任务、正例期望、负例与恢复序列已保存到 `tests/fixtures/robustness/cases.json`，中文音频样本为本机 TTS 生成，不是用户录音。任务分语音、记账、文件处理，每类 quick/longterm，确定性业务回放 3 次；这些新生成任务尚未执行。

只读基线：`run-artifacts/robustness-baseline.json`，包含源码、依赖锁、有效本机覆盖提示词和原语音产物哈希；不保存密钥或覆盖提示词正文。每次实际运行另记解析后的渠道，不把磁盘配置存在视为渠道实测通过。

在原产物 Python 环境和缓存 SenseVoice 模型上重新执行接口探针：二维 `(6400,1)` float32 仍抛 TypeError，连续一维输入可解码；固定中文 WAV 输出「我们下周四下午3点开会。」。零波形会产生「嗯。」等文本，说明静音不能仅靠“输出非空”判通过。证据：`run-artifacts/robustness-baseline-voice.log`、`voice-shape-probe.json`。原产物未变；未打开 GUI、麦克风或下载模型。

实际收口核对：quick 的安全/冒烟 null 可继续交付，longterm 冒烟 null 可进入成品确认；verify 安全扫描异常返回 null；PQ 旧 qualified 在重新读声明前返回；checkpoint 按阶段复用。以下批次会分别修复并测试，不把源码核对写成运行复现。

本地上游核对版本 `bf3e98ca61dd8365eceaef876c0f7473700878a6`。参考 `apps/electron/src/main/lib/agent-session-usage.ts` 的坏行容错和 cache token 口径；该模块解决会话上下文占用，不能直接代替项目累计账本。当前 Bloma 的桌面核心证据与共享 PQ 缓存没有可直接移植的上游等价实现，采用现有模块局部适配。

基线捕获首次遇到沙箱内 Node 子进程启动 git 的 EPERM；改为调用端传入已经核对的 Git ID 后完成。该失败是捕获工具的权限问题，不计入生成产物失败。
