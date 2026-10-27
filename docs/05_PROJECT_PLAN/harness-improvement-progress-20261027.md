# Harness 改进实施记录

日期：2026-10-27，Asia/Shanghai。接手基线 `sprint2 / 2fd73e3`。按 [执行交接](harness-improvement-handoff-20261027.md) 继续；用户原有 `production-workflow-v2-20261020.md` 两行改动不纳入提交。不 push，不发付费模型请求，不修改真实 home 的项目、账本或进程。

## 批次 1：验收证据隔离与诊断

- 原生测试和开发脚本上下文增加宿主提供的工程外 `evidenceDir`；`page.screenshot` 和 locator 截图的相对路径自动落入该目录，越界绝对路径拒绝。正式验收、开发观察及 initial/reopened 证据分开，关闭重开共享本次隔离数据。平台截图也写工程外；旧动作观察器默认截图改用其隔离临时目录。
- 保留候选、源码、依赖和外部运行时的字节保护。候选或源码改变返回最多 24 条新增/删除/改变的相对路径、类别和期望/实际哈希，附省略数；没有增加 shots 忽略规则。疑似测试输出提示改用 evidenceDir，不让成品退出时清理验收痕迹。
- 失败反馈提供 product_assertion / test_adapter / environment / harness、步骤、期望/实际、路径、允许修改范围和下一工具。原生 reporter 在可获得时保留实际断言的 expected/actual；无法获得时保留实际错误，不伪造业务值。
- 适配更新仍经 `verify_app(script)`：仅静态定位字面量、有界等待（100–30000ms）和导航等待选项可变；导航目标、等待状态、输入、断言和共享业务逻辑冻结。选择器中的动态属性、计算键和调用不能被归一化隐藏。已接受适配记录前后 digest、contract、scope 与规则版本。
- 取消、异常或写盘失败仍须废弃旧 PASS；旧缺能力/坏规则门不放宽。

验证与证据：

- 首轮串行 3 文件 / 18 项通过：原生 GUI 11、凭据 4、发布/SQLite 更新 3；包括真实浏览器关闭重开、真实 Electron 正常窗口启动与 100 条隔离 SQLite 记录。`run-artifacts/harness-batch1-tests-20261027.log`。
- 随后细化分阶段截图路径、locator 截图和断言详情；原生针对性复验 3 项通过，见 `run-artifacts/harness-batch1-final-native-20261027.log`。取消/损坏凭据/写盘失败、缺能力和缓存保护针对性 3 文件 / 12 项通过，见 `run-artifacts/harness-batch1-guards-20261027.log`。复跑不与首轮重叠计数。
- 类型检查、构建和文档检查通过。旧动作截图使用持久工程外证据目录，避免其临时数据清理一并删除截图；原生及旧动作结果提供 evidence_dir。
- 最终旧观察器/ASAR 回归 2 文件 / 5 项通过，涵盖真实 Electron/浏览器重开和错误预期拒绝、物理 ASAR 哈希不变，见 `run-artifacts/harness-batch1-observer-asar-20261027.log`。
- 本轮仅固定应用、模型替身与隔离进程；没有重新验收真实用户成品，没有模型质量、成功率或付费对照结论。

## 后续批次

依次推进独立持续试用、制作中/交付后可选建议、第二模型验收设计的离线工程路径、固定任务对照工具。真实付费样本待用户给出明确新预算并完成渠道、余额、费率、账本和请求前金额保护核对。
