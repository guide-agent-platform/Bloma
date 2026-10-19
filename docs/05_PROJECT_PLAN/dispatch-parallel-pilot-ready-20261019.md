# 多实现者预实验起跑记录（2026-10-19）

## 当前结论

本轮采用用户确认的 quick 条件，从全新 L2 用户请求重新走完 Bloma 的需求澄清、需求确认、PRD 内审与确认、草图生成、审阅与确认，再停在 Implement 之前。未沿用历史 PRD/UX。v2 六组相同起点与环境已准备完毕，G11 实际跑出两执行者物理并行，但状态保存的 Windows EPERM 中断子 agent，因此监督者停止并保留本组，尚无业务质量结论。下述 v2 起跑证据是历史资格，修复后须重新冻结六组。

用户明确取消本轮金额上限；运行使用显式 `--no-monetary-limit`。请求、回合、输出与运行时间等运行保护仍单独记录，不属于金额控制。历史预算责任不清零，凭据只从本机 DPAPI 存储读取，未进入快照与本文。

## 新共同起点

- 项目：`255dbbdf-6621-43b9-9b96-6de37efc6446`；父会话：`5e5297bf-bddf-4b89-9eb5-7114a3903937`。
- 原生新准备目录：`C:\Users\17359\AppData\Local\Bloma\parallel-native-quick-20261018\source-home`。
- 最终 PRD：11 个功能、23 条业务规则、41 条场景；已校正真实筛选计数、完整功能界面、项目英文名称大小写判重、缺失项目引用的备份整份拒绝。没有要求项目改名。
- 草图采用最终原生探索 `37d8809f-2fcc-488f-8821-444056399056` 的 refined；1100/820 宽度均已实际渲染检查。筛选结果按数据计算，错误反馈按状态出现，窄窗口可到达编辑区域。
- 源准备产生的真实模型消耗与失败尝试独立保留。起跑时的“0 次调用”仅指六个新实验臂的执行阶段。
- 准备用量独立核算：155 次开始/155 次收尾，152 完成、3 取消；152 次完整 usage，3 次缺失。已报告输入 1,232,251、输出 687,539、缓存读取 3,273,206，均为 Flash。缺失部分未知，不作现金账单；独立摘要写入后原账本 SHA256 未变。
- quick 不增加长期流程的架构/骨架交接阶段；使用平台既有桌面骨架，未提前实现业务。

## 封存与隔离

v2 cohort：`C:\Users\17359\bex-q18\pilot-v2`，现已因平台故障退役；G11/G12/G21/G22/S1/S2 分别独立 home。共同快照 177 文件逐字节校验通过（恢复路径所需项目与会话索引元数据除外）。`00_ENV/common-environment.json` 与 `requirements.lock` 进入受保护输入。

| 项目 | 已核验值 |
| --- | --- |
| 输入 SHA256 | `95c2c06038779fcb7600bf23b8547d50259fd0932a42e5cef0ece8df3f715079` |
| 执行主包 SHA256 | `8f634a98ad5f8eca1932353a52d2072a6895e9dc64247fb80bac8cbb9bcdd40e` |
| 外部验收 SHA256 | `ed92ad56a86dca68652509e282ccc7429bfa367b4d00d25e1fa5c22700df2d2a` |
| Python 解释器 SHA256 | `d932e5e2f324d57f392e8fd063dcf6d0185be8a664c57c6d24e7762ed02c28ca` |
| 安装清单 SHA256 | `2eeb7eb5b0b1290db1642002d39a88ebe3593beb451988e9dc20692c4d3121dc` |
| 隔离运行时提交 | `b0e3e3d3083f2e5c11c7872484f3ff8887f00ca6` |

运行时固定在 `C:\Users\17359\.codex\worktrees\parallel-pilot-runtime\guide-agent-platform-sprint0`，校验 94 个运行文件、4 个驱动文件以及依赖锁文件。主工作目录中其他 UI 开发不改变本轮运行包。依赖目录使用 junction；启动器核验安装锁哈希，仍应避免测量期间修改共享依赖。

六组均使用短路径，Python 3.13.7 AMD64、10 项同版本依赖、独立 .venv，真实 WebView2 页面 DOM 冒烟均通过。原生 Bloma 页面六组均可进入项目并发送消息，父会话未改变。界面冒烟填入再清空的未发送草稿只改变 revision；恢复前将六组原内容留档到 `ui-qualification-draft-changes.json`，然后恢复快照空草稿，未删改历史消息。

## 链路资格与本轮方法

DeepSeek Flash 与 GLM 5.3 Coding Plan 都完成三路实际 HTTP 重叠调用及工具往返，两家物理峰值均为 3，合计 12 次物理请求成功。这只证明父编排器加两子执行者的服务通路容量，不证明实际调度或产品质量。GLM 使用 `zhipu-coding`、`https://open.bigmodel.cn/api/anthropic`，没有切到普通按量 API；未取得 Coding Plan 剩余额度的精确数值。

G 组上限两名实现者，任务拆分、依赖与写范围由真实 D 自主决定；S 组直接 Implement。共同 V=DeepSeek Flash；M1=DeepSeek Flash，M2=GLM 5.3。跨实验组顺序运行，以区分组内并行与跨组并发。调度60回合、实现100回合、逻辑请求256、主机输出上限640000、墙钟3600000ms，脚本64次/安装8次；提供方实际输出上限另行记录。所有组 temperature=0.1、thinking=high、首响应超时120000ms。

外部业务验收预先封存14项；native 完成、内部自测、传输成功与独立业务 Q 分开记录。未完成独立验收时 Q=null。真实并行以任务/worker 事件配合传输账本的物理时间重叠判定，不能只凭“两个 worker 已创建”。

## 已消除的起跑问题与保留样本

1. GLM 普通通路与 Coding Plan 区分；明确无限金额模式，旧负债保留。
2. 修复高输出需求被旧16384上限截断、UX 标记修复反馈与条件控件表达；真实失败准备记录保留。
3. 长目录 WebView2 运行故障通过短 home 与真实 GUI 冒烟查明并排除。
4. 恢复中的 prepared 实验被启动清理误认作崩溃：恢复阶段保持等待，实际绑定 Implement 时才转入生成中。新增回归证明启动前父会话不变，真实崩溃恢复用例继续通过。
5. 旧 PRD/UX cohort 因范围不符停用；第一版全新 cohort 因上述启动恢复问题在0模型调用时停用。均保留，不混入有效 v2。
6. v2 G11 的 worker-1 在 `2026-10-18T16:39:14.737Z` 因 dispatch-experiments 状态 JSON 的原子 rename EPERM 进入 failed。D 自行续派，但该运行已受到基础设施污染；监督者于 `16:41:07.928Z` 取消终止。150 个逻辑请求/150 个物理请求全部收尾、150 次 usage 完整：已报告 input 443805、output 180229、cache_read 8975616，Q=null，其余五组未启动。`infrastructure-incident-v2.json` 保留原始异常；operator-stopped/cancelled 不是模型自然交付失败。

冻结运行时相关单元检查11文件149例通过；当前隔离运行时类型检查通过。此前集成2文件8例、UX35例及 native 选择9例检查通过。数字为相应批次，不能相加宣称完整项目测试覆盖。

## 证据与启动

证据根：`C:\Users\17359\AppData\Local\Bloma\parallel-native-quick-20261018`。

- `readiness-v2.json`、`pilot-v2\readiness-release.json`：六组起跑前核验通过，0次执行调用。
- `env-v2\{group}\report.json`、`platform-v2-ready.json`：环境与真实原生 UI 资格。
- `transport-parent-plus-two\preflight.json`：三路物理 HTTP 资格。
- `prd-final-review.json`、`ux-final-review.json`：原生准备审阅与最终材料。
- `pilot-v2-runs\G11\launch-receipt.json`：当前真实启动收据；终态与质量结果另记。
- `source-preparation-usage-summary.json`：准备消耗与缺失分母；`pilot-v2-runs\G11\observation.json`：执行观测（随进度更新）。G11 已观测到两个执行会话的完整物理 HTTP 区间重叠，峰值为 2，首次发生于 `2026-10-18T16:32:22.954Z`；这仍不构成完整交付或业务 Q 通过。

本机 `C:\Users\17359\bex-q18\pilot-v2\run-one.mjs GROUP` 在调用原生 UI 驱动之前重验运行包、封存结果、继续指令哈希、未开始条件，并拒绝覆盖已有报告。后续组沿用同一起点；发现平台故障先保留失败样本并修复，另立修订 cohort，不修补正在测量的样本。
