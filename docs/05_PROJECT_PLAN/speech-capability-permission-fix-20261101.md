# 语音能力准备入口权限修复

日期：2026-11-01（Asia/Shanghai）。工程基线 `48f72c5`，分支 `sprint2`。用户在监看“桌面语音球”测试、查询原因后授权修复。本批只修平台准备入口，不续跑真实模型任务、不调整预算、不覆盖现有项目代码、不 push。

## 已定位的问题

`prepare_software_capability(capability:"speech")` 已先通过 `policy.assertCommand` 校验主会话、工程、取消、审阅冻结和活动写入协作者，却又把 `.venv/pyvenv.cfg` 交给普通 `assertFileWrite` 检查。普通文件规则有意禁止整个 `.venv`，导致合法的宿主准备也报 `DELEGATION_WRITE_PATH_OUTSIDE_PROJECT`，尚未进入 Python、资源和绑定流程。

这不是实际路径越界。此前监看项目 `7423ba76-9a0f-445d-b6b8-658f65c41390` 的运行记录中，有 13 次语音准备被这条规则拒绝，另 5 次为参数无效；最终额度耗尽，ASR 验证仍被环境条件阻塞。旧测试直接调用 `prepareSpeechCapability`，覆盖不到公开工具的这条错误检查。问题早于 Q1–Q4，本批不归因于独立审阅链。

## 修复行为

- 公开工具仍先通过现有主会话命令授权，并对四个语音源码组件执行文件归属检查；固定 venv/pip 准备走宿主命令流程，不再把 `.venv` 当作普通源码文件写入。
- 普通 `write_file`、`edit_file` 和协作者写入范围继续禁止 `.venv`，没有修改共享策略或开放子会话命令权限。
- 固定环境目录在每个准备命令执行前后检查，拒绝 `.venv`、Scripts/bin、Lib/lib 等目录的链接/重定向；Windows 另检查 site-packages、解释器及配置链接。保留 POSIX venv 解释器的常规链接方式。这是固定准备路径检查，不是任意子进程的操作系统沙箱。
- 异步探测返回后检查取消，取消后不再启动后续安装、复制组件或写入能力绑定。
- 已有自写语音文件仍返回 `CAPABILITY_EXISTING_FILES_PRESERVED`，不以本次权限修复覆盖；准备结果仍区分固定音频、麦克风和产品验收。

## 本次验证

先添加实际 `buildSoftwareAgentTools` → `prepare_software_capability.execute` 的回归测试，在未修复源码上运行初始 6 项，5 项失败、1 项通过，成功复现同一错误。修复后扩展为 10 项入口测试，覆盖准备/复用、创建 venv、固定依赖安装、禁止安装选项、自写文件保护、主子会话权限、活动写入任务、审阅冻结、目录链接、异步返回后目录变化和取消。

最终定向测试 **10 文件 / 62 项通过**：新增入口测试及既有能力准备、协作、Q1 审阅、Q4 风险选择、运行时准备、语音桥、宿主语音验证、能力验证和预算测试。新增语音入口测试只替换子进程、解码器与小型资源字节，使用隔离临时 PROMA_HOME；不运行真实 Python 安装/音频识别、网络下载或麦克风。

`npm run typecheck`、`npm run build` 通过。构建后的隔离 Electron 启动检查 `S0-UI-007` 通过，测试进程已清理；主 bundle 的 `__require(` 数量为 0。类型检查首轮发现新增测试把命令的 `unknown` 类型直接索引，已加数组校验并重跑通过。构建保留既有依赖指令和分块大小提示。

本机未跟踪证据目录：`run-artifacts/speech-capability-fix-20261101/`，含 `tests.log`、`typecheck.log`、`build.log`、`electron-smoke.log`。

## 当前项目与后续边界

“桌面语音球”此前记录的自写 `speech_runtime.py` 与平台组件冲突、缺失组件和缺失绑定，不能靠权限修复自动闭合。本批未修改其文件、运行记录、额度或验证结论，也未重启用户实例。需要加载新构建后，再在另行安排的项目修复范围内处理现有实现接入及真实语音复测；不能把本机入口测试或启动通过当成产品验收、麦克风通过或真实生成质量提升。

用户原有 `production-workflow-v2-20261020.md` 两行修改继续未暂存，保护值 `53c7abb3aef8497d8b0522b8aab806c82b2ec164`。
