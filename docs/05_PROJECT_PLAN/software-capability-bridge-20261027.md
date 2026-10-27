# 批次 B：新流程复杂能力发现、准备与语音复用

日期：2026-10-27，Asia/Shanghai。接手基线 `sprint2 / e380fee`。对应 [近期计划](workflow-retirement-modes-capabilities-20261027.md) 批次 B；保留旧能力实现和验收器，不恢复旧 dispatcher，不修改真实用户项目、账本或进程，不发付费模型请求。

## 已实现的接线

- 新执行器增加 inspect_software_capabilities：读取项目选定 Python、依赖实际 import/版本/位置、可复用组件状态和模型文件的真实字节/哈希状态。检查不下载、不安装、不打开麦克风；读到组件或缓存不等于业务通过。
- 父负责人增加 prepare_software_capability，首个 provider 为 speech / python-sensevoice-v1；子任务只有只读发现。准备遵守现有命令/文件所有权、取消和忙碌约束，不接受未知能力、未知参数或麦克风开关。
- 创建/复用项目 .venv，核对项目 Python 约束；缺依赖时在项目环境安装现有固定基线并 import 回读。已有可用依赖以实测版本为准，不覆盖用户实现。依赖准备失败或资源未就绪时明确报错，不改需求或伪造已实现。
- 受控物化 speech_runtime.py、speech_locator.py、speech_worker.py、speech_bridge.cjs。已有字节相同的平台组件复用；不同内容、符号链接或不支持的 venv 路径拒绝并保留原文件。安装普通 pip 包不再被误当作组件已经落位。
- download_models 默认 false；明确 true 时才由宿主按固定公开清单下载/校验资源，有取消和总时限，已有正确缓存复用。正式执行的环境强制离线，产品/验收不能以隐式下载替代准备步骤。
- 准备完成前实际调用固定音频探针；prepared 与 product_verification 分开。后者仍为 unverified，需要产品 GUI/数据/正常启动等原有验收。真实麦克风另需授权，任何本批检查都不录音。

## Node/Electron 怎样复用

Python 产品使用 SpeechEngine。Node/Electron 产品可调用项目内 `speech_bridge.cjs` 的 `transcribeWav(file,{signal,timeoutMs})`，通过自己的 Python worker 完成转写，不借 Bloma 的语音 IPC 或渠道密钥。

接口只接受放进 APP_DATA_DIR 的 PCM16 WAV。worker 限制文件大小、时长、采样率/声道，路径解析后仍须位于该数据目录；不打开麦克风。Python 使用隔离模式和显式 UTF-8，真实依赖先于产品模块导入。Node 端限制并发、输出和时限，取消/超时仅回收该次拥有的进程树，分段 UTF-8 输出不损坏中文/非 BMP 字符。

这条路径支持“Node 产品复用 Python provider”；没有把它宣称为原生 Node ASR 引擎或通用语音插件平台。OCR、其他 ASR 引擎等仍须自己的真实适配与验证。

## 环境、资源与候选版本

- 平台资源根统一为显式绝对 BLOMA_SPEECH_MODEL_DIR，或当前 getPromaHome 下的 speech-models/sensevoice-int8；相对覆盖拒绝，避免随 cwd/HOME 漂移。没有向产品透传平台 PROMA_HOME、渠道凭据或任意宿主环境。
- 准备记录保存 provider、固定清单哈希、规范化模型根、组件哈希和实际依赖事实。开发命令、正式 GUI、ASR 探针、正常启动和用户启动共用资源绑定；Node 的 BLOMA_SPEECH_PYTHON 指向当前工程/候选自己的 .venv。
- 发布候选写入工程根的宿主 capability capsule，纳入完整字节校验；固定模型缓存位于工程外，另保存并校验资源身份/哈希。后续准备操作改变项目绑定，不会替换旧候选的资源根；损坏或改变资源拒绝启动/发布。
- 软件 ASR 验证要求 provider 已准备并绑定；不支持的 runtime 明确拒绝，不能将 Node 声明默默交给 Python 后声称支持。GUI 绿色、安装成功或固定文字都不能单独认证 ASR。
- 模型资源仍是本机缓存依赖；源码导出、便携包和干净机器可用性继续分别报告，没有制造独立安装通过证据。

任务整理支持内部已知 capability 标签，未知标签拒绝，空标签不能取消明确的音频转写承诺；扩展了音频文件转写的兼容识别。标签用于宿主验收，不把内部技术选择抛给用户。

## 验证事实与原始失败

- 针对性首次收敛为 5 文件 / 37 项通过：新能力工具 6、旧 ASR 验证 3、资源发现 4、平台语音内核 20、lean guide 4（capability-b-final-tests 日志）。原始首轮的缓存根断言仍硬编码 ~/.proma，被新的隔离 PROMA_HOME 策略检出；按新契约修正并增加绝对覆盖/相对路径拒绝检查，保留 capability-b-tests 失败日志。测试 mock 的类型签名错误也已修正。
- Node/Python 传输单独 3 项通过：逐字节 UTF-8、找不到解释器不泄漏槽位、并发与取消/超时回收。这里用合成 worker 验证传输，不认证 ASR 质量。
- 真实脚本 `scripts/verify-software-capability.mjs` 在新建短路径隔离 home 中运行。首轮因夹具 bundle 放置位置导致模板定位错误，未进入实际准备；日志 capability-b-real-20261027.log 保留。
- 第二轮完成真实依赖准备和固定音频解码，UI 断言误写为汉字“三”且无句号，而引擎实际 ITN 为“3”且带句号。保留该失败，使用新隔离工程按同一句含义的数字/标点等价格式重新冻结；没有修改真实用户产品或旧冻结规则。
- 第三轮及最终轮通过真实浏览器上传 → Node 桥 → Python ASR、无效音频不覆盖结果、关闭重开留存、进程超时，以及固定文字替身拒绝。替身虽匹配界面语义，宿主观察真实解码次数为 0，未通过；恢复源码也不复活旧 PASS。
- 真实准备使用固定版本依赖；后续夹具只复用本轮拥有的虚拟环境以避免重复下载，模型文件始终只读复用现有缓存。依赖安装和本地解码不计为付费模型请求，没有录音或调用供应商 API。

最终耦合回归 10 文件 / 63 项通过（capability-b-regression 日志），包括新增能力、传输、资源/语音、需求整理、验收凭据、实际进程执行、发布/SQLite 更新和制作上下文；前述复跑包含在其中，不叠加计数。类型检查和完整构建通过。实际截图独立查看确认可见文字完整，不把固定应用验证当作真实模型生成实验。

证据：`run-artifacts/capability-b-{tests,final-tests,bridge-tests,real,real2,real3,real-final,regression,typecheck,build,docs,source-verify}-20261027.log`；最终真实报告在 `run-artifacts/capability-native-20261027/report.json`，隔离工程/发布候选路径写在报告内。文档检查和最新依赖快照复核均通过。

退役 scope 已刷新为 version 2，最新机器清单覆盖 892 个源文件、105 个重点模块及 5 份显式 Python/音频资产。新 Node 桥通过受控物化进入产品，没有源码直接 import；这正是不能按零 import 自动删除模板的例子。A 的原始快照保留在 Git e380fee。

这是一组固定应用和本地真实模型的工程验证；不代表模型从零生成的成功率、真实麦克风识别体验、所有语言/硬件覆盖或干净机器交付。当前用户产品和原有两行生产流程文档改动均保持独立。
