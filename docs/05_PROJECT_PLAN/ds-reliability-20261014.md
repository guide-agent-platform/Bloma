# DeepSeek 可靠性冒烟（2026-10-14）

用户恢复范围为“用ds渠道试一试”，随后“继续”允许继续定位与验证。正式比较和难度矩阵仍暂停；原失败样本不改写。

## 第一组结果

证据：`run-artifacts/ds-reliability-20261014/`。代码 `521afc5`（运行代码 `9b190bf`），runtime `12892876a1f8385441e2797bf8ee319d6970e34a7a736629e4b6294cb93d81d7`。

| 项目 | 实测 |
|---|---|
| 配置 | G11 quick，1 worker；D/E/V 配置全 DS Flash low |
| 真实调用 | D 17、E 64、V 未到达；81 次逻辑/物理请求全部 HTTP 200、low、完整 usage |
| 流程 | 462798ms；failed / EXPERIMENT_EXECUTION_BUDGET_EXHAUSTED |
| 产品质量 | 外部冻结 GUI 6/6，Q=1；模型最终自测逻辑 19/19、GUI 9/9 |
| 本次峰值价计账 | 1.164479 元；GLM 0、新增未知 0、活动请求/预留 0 |
| DS 累计保守计账 | 25.958873 元；原 50 元上限余 24.041127 元；旧未知费用保留 |
| 工具配对 | 103 调用/103 结果；100 结构化事实，plan/security_scan/find 三条旧式文字回执 |
| 归档 | 48 文件，SHA-256 校验，排除凭据和虚拟环境 |

产品验收不能替代平台完整交付成功。两次提前越权写入被拒绝，后续调度扩展写入范围。脚本计数跨续接累计至 12，未清零；实际预算拒绝后立即停止，终态后没有新请求。

## 异常与修复

第 12 次模型短复核代码使用 `subprocess.run(capture_output=True, text=True)`，未指定编码。宿主只有 `PYTHONIOENCODING=utf-8`，子 Python 输出 UTF-8 中文，但父 Python 文本管道按 Windows GBK 解码，触发 UnicodeDecodeError，随后 `r.stdout.strip()` 因 None 触发 AttributeError；同次逻辑自测子进程退出码 0。

反馈正确保留 `unverified / verification_harness / inspect`，没有据没有 FAIL 断言的异常认定业务失败。调度器仍要求续接复核，首次实际预算拒绝后终止。保守停止生效，验证成本和收口策略仍需观察；一次诊断不能评价模型优劣。

新增共用 `pythonEncodingEnv`：默认 PYTHONIOENCODING=utf-8 与 PYTHONUTF8=1，接入执行器、契约验证、实验命令验收；保留显式编码覆盖。依据 [Python UTF-8 模式](https://docs.python.org/3.13/using/cmdline.html#envvar-PYTHONUTF8) 和 [subprocess 文本管道](https://docs.python.org/3.13/library/subprocess.html#frequently-used-arguments)，标准输出编码变量不能独自改变父解释器默认解码。

`encoding-replay.json` 在独立产品/虚拟环境副本复放原短代码：UTF8=0 退出 1 且有解码异常；UTF8=1 退出 0、19/19 PASS。零 API，原 native 失败不改写。

相关 6 文件 86 测试通过（含真实嵌套 Python 中文管道），typecheck/build 通过。日志 `fix-tests.log / fix-typecheck.log / fix-build.log`。

## 修复后复验

独立新工作区、新 runtime 快照、新 run_id 再做一组 DS G11；证据 `run-artifacts/ds-reliability-20261014/after-encoding-fix/`。沿用 DS 原累计 50 元上限，不重置历史费用；不并入正式比较。

复验已完成，代码 `4df35aa`，runtime `adb1b56f2033f963e944f88f3d50292c513739874e6a27d9fd0dae8b2ebe2abb`。Implement 377160ms（6 分 17.160 秒），终态 **ready / delivered**。D 20、E 48，共 68 逻辑/物理请求全部 HTTP 200、low、完整 usage；V 配置为 DS，但 quick-direct 没有额外 V 模型调用。平台核心验收七项需求均 passed，GUI 注册六场景通过；独立冻结 GUI 6/6 通过。没有把退出 0 且无断言的自检升格为业务通过。

脚本累计使用 11/12 次，确实没有编码崩溃；调度追加多次已通过的复核，成本和收口仍有优化空间。90 工具调用全部配对；87 结构化事实，三条旧式回执保留；越权拒绝 0。52 个文件归档，终态后模型请求 0、活动预留 0。

复验峰值价计账 0.827205 元，两次合计 1.991684 元；DS 原累计保守计账 26.786078 元，50 元上限余 23.213922 元，GLM 无新增请求。原始 token/cache 明细、时间、模型路由、反馈与验收证据均留档。该结果只证明一个简单任务的真实闭环跑通，尚不足以证明稳定性，也不作为模型间效果比较。

## 同配置再次测试

用户追加“再测试一次”。本次直接复用上次成功样本的冻结快照 `537be47e-a243-403b-9311-2fa9435620d1`，恢复全新工作区；runtime/input/condition/models/settings/limits/execution_limits/required_writes/evaluator_hash 九项在运行后再次核对全部一致。证据：`run-artifacts/ds-reliability-20261014/repeat-02/`，代码 `b6c2a48`，运行代码仍为 `4df35aa`。首次准备尝试重新冻结时 input_hash 发生变化，启动前被一致性守卫拒绝；该准备记录单独归档，未调用模型，不计为真实失败样本。

| 指标 | 上次修复后 | 本次重复 |
|---|---:|---:|
| 流程终态 | ready / delivered | ready / delivered |
| 完成交付耗时 | 377160ms | 510099ms（8 分 30.099 秒） |
| D / E 请求 | 20 / 48 | 23 / 37 |
| 物理调用 / HTTP 200 | 68 / 68 | 60 / 60 |
| 平台需求验收 | 7/7 | 7/7 |
| 独立冻结 GUI | 6/6 | 6/6 |
| 脚本累计次数 | 11/12 | 12/12 |
| 峰值价计账 | 0.827205 元 | 0.843641 元 |

本次全部 low 思考、usage 完整，无新未知费用或 GLM 请求；81 次工具调用全部配对，79 条结构化事实、两条旧式文字回执。GUI 首轮两项红断言后，模型修正测试的勾选目标及异步等待条件，后续复测全绿；原红日志保留。尝试写任务范围外的 `00_SCAFFOLD/contract.json` 被拒绝一次，最终没有依赖该文件交付。未再出现编码崩溃。

本次 50 文件已归档并校验哈希，历史预算条目完全未改，终态后无模型请求，活动请求/预留为零。DS 累计保守计账 27.629719 元、50 元上限余 22.370281 元。本次与上次成功样本的 JSON/CSV 对照、核验结果在 `comparison.json / comparison.csv / verification.json`。修复后同配置已观察到连续两次闭环成功，但脚本额度紧、重复探测仍多；两个简单任务样本不足以推断总体稳定性。正式模型比较和难度矩阵未自动恢复。
