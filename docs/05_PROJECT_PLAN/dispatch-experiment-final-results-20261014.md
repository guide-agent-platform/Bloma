# 2026-10-14 quick 六条件执行记录

原生交付成功为 S1/S2；G11/G12/G22 独立功能验收均 6/6，但原生流程失败。G21 在 HTTP 前被预算守卫拒绝且未评。当前没有完整有效配对，D/R/G 不可计算，longterm 与追加重复未执行。

本轮尝试六个条件；G21 首次物理请求前被预算守卫拒绝，因此不是完成了六个付费样本，顺序为 S1、S2、G11、G22、G12、G21，条件并发度为 1。同一条件的全部原生阶段尝试都保留；没有人为修补产物、替换失败行或挑选旧批次的成功行。G22 包含两次原生阶段尝试，其余条件各一次，不能宣称六个条件实际经历了同样数量的阶段重试。代码版本 da2ae396ca9e64c391029a82808f9a37d3dff435，用量和预算按每模型累计 50 元守卫。

| 组 | 原生流程 / 终止 | 独立 GUI | Q | 制作耗时(分) | DS 峰值估算(元) | GLM 峰值估算(元) | 用量记录 |
|---|---|---:|---:|---:|---:|---:|---|
| G11 | failed / EXPERIMENT_TASKS_NOT_COMPLETED | 6/6 | 1 | 5.31 | 0.8007 | 0.0000 | 缺失 6 |
| G12 | failed / EXPERIMENT_TASKS_NOT_COMPLETED | 6/6 | 1 | 14.05 | 0.2684 | 9.3312 | 缺失 1 |
| G21 | failed / MONETARY_BUDGET_EXHAUSTED | 未评（pending） | 未评 | 0.00 | 0.0000 | 0.0000 | 缺失 1 |
| G22 | failed / EXPERIMENT_TASKS_NOT_COMPLETED | 6/6 | 1 | 6.75 | 0.0000 | 4.6572 | 完整 |
| S1 | ready / delivered | 6/6 | 1 | 6.96 | 0.6574 | 0.0000 | 完整 |
| S2 | ready / delivered | 6/6 | 1 | 4.53 | 0.0000 | 2.7497 | 完整 |

## 指标及解释边界

一个任务、一轮六条件尝试；五组形成可评分产物，原生交付成功仅 S1/S2 两组。独立 GUI 六项覆盖新增去空格、空白拒绝、完成状态隔离、筛选、删除隔离及重启持久化。表中原生成功和业务评分是两个结果维度。D=null；R(S2|S1失败)=null（分母 0）；R(S1|S2失败)=null（分母 0）；G12−G11=null，G21−G22=null，G12−最佳同质组=null，G21−最佳同质组=null。null 表示不能估计，不能写成 0。

G11 有平台历史消息组装故障：执行者一次 HTTP 200 响应只有思考输出，输出 token 达到 8192；循环将空 assistant 内容存入历史，续接原样携带后被 DeepSeek 六次 HTTP 400 拒绝（messages.31: all messages must have non-empty content）。这不是余额不足或渠道认证失败，不能解释为模型完成任务的能力差异。原生失败及缺失用量都保留。相同代码和评估条件仅支持本轮工程描述，不能据此作因果能力排名或统计显著性判断；后续正式比较需修复后冻结新版本重新运行完整六组。旧并行 quick-r1 已在独立有效性审计中排除，不能与此轮拼接成重复。

G21 的唯一逻辑请求没有物理 HTTP，首次请求前就触发 MONETARY_BUDGET_EXHAUSTED；其 six GUI 检查保留 pending，Q=null，不能当作六项失败。G12 的 107 次逻辑请求只有 106 次物理 HTTP，其中一次也在预算预留前被拦截。由于 G21 未评，完整配对数为 0，D/R/G 全部为 null；不会用另外五行计算不完整配对。GLM 结束时剩余守卫额度为 8.514756 元，低于共同条件下一次 8192 输出上限、完整上下文预留 8.617984 元，不提高 50 元上限，也不改变输出限制来拼接本轮。

G22 原生失败有计划范围证据：锁定图未授权 core_check.py 与 CORE_CHECK.json，续接补写触发 write_rejected；试图重建锁定图、新派已有 owner 的任务也被拒绝。G12 原生终止仍保留 EXPERIMENT_TASKS_NOT_COMPLETED，并单独披露中途预算拒绝。

空 assistant 历史的修复已提交为 caf682d：只在发送请求时过滤空 assistant 字符串/数组，保留原始 JSONL 和非空工具配对。新增回归先得到 2 例失败，修复后 4 文件/110 例相关测试与 typecheck 通过；六组终止后才重建新 bundle，没有付费重跑验证该修复，也没有改写本轮旧版本失败。构建证据见 empty-history-build.log。

## 费用

本轮已报告峰值费率估算：DeepSeek 1.726496 元，GLM 16.738048 元。未知用量的请求仍有 6 笔，保留上界预留，并非实际收费。每模型守卫仍为累计 50 元，准备、预检、旧批次和固定 DeepSeek 验证器都计入；最终预算详见 budget-at-finish.json。GLM 的历史余额核销使用用户确认的起始 50 元、此前余额约 38 元、期间无其他变动，仅覆盖旧批次开始之前 150 笔请求，不修改那些请求的原始用量。峰值估算不是供应商账单，DS 非高峰实际费用可能较低。

本轮 GLM 成本拆分为未缓存输入约 2.1533 元、缓存输入约 12.6259 元、输出约 1.9588 元，缓存输入约占 75.4%。G12 尤其明显：76 次实际 GLM 请求，缓存输入累计 3,728,640 token，缓存输入费用约 7.4573 元，占该组 GLM 9.3312 元估算的约 79.9%。费用主要来自反复携带历史上下文；缓存命中也有费用，不能当作免费。逐组组成见 summary.json。

## 数据及复现

summary.json 记录角色请求数、用量、缓存、缺失计数、请求级错误、图与文件范围、费用、预算等待和终止；results.csv 为宽表，aggregate-results.csv 为 CLI 原始导出，final-aggregate.json 包含配对指标与全报告。每组 quick-r2/<组>/ 下保留原生日志、终屏和 GUI 原始证据。archive/<组>/ 保存原始事件、请求账本、会话历史、PRD/UX 和产品源文件，archive-manifest.json 给出 SHA256 与原路径映射，不依赖临时目录长期存留。依赖版本及冻结输入见 requirements-pinned.txt、environments.json、snapshot-quick/manifest.json。复制不包括加密渠道凭据或虚拟环境。

此次 longterm 和追加重复没有执行，不能写作完成。所有结果及报告已保存后才允许按用户要求正常关机；关机不强制结束含未保存内容的应用。

完整本机报告：[final-report.md](../../run-artifacts/formal-dispatch-20261014-serial/final-report.md)。数据表：[results.csv](../../run-artifacts/formal-dispatch-20261014-serial/results.csv)。原始数据在本机 run-artifacts，未提交渠道凭据及实验产物到 Git。
