# 不同模型与自主调度实验基础设施

本批在原生暂停/快照/恢复上增加角色模型绑定、自主规划、独立实现、矩阵生成和运行报告。代码验证采用假 SDK 与临时文件，尚无真实模型效果数据。主问题是给定相同需求与初始产物，调度模型与实现模型怎样影响任务分解、协作和交付。

## 主实验和辅助对照

| 条件 | 实现阶段调度模型 | 实现模型 | 任务分解 |
|---|---|---|---|
| G11 | M1 | M1 | M1 自行产生 |
| G12 | M1 | M2 | M1 自行产生 |
| G21 | M2 | M1 | M2 自行产生 |
| G22 | M2 | M2 | M2 自行产生 |
| S1 | 无 | M1 | M1 直接实现，自行规划 |
| S2 | 无 | M2 | M2 直接实现，自行规划 |

S1/S2 在 Implement 内没有委派或规划登记工具，直接获得真实实现工具；不能把原先“一名调度者＋一名实现者”写成独立基线。后续原生验证仍按共同流程执行，验证阶段的协作不属于独立实现者派遣。

quick 与 longterm 分层分析，每一层有六个条件。准备模型和来源固定；Verify 的模型 V 固定。首轮 matrix 默认实现者上限为 1，先测模型搭配；另建 worker-limit=2 的矩阵才能研究增加资源的作用，上限不代表调度者一定创建两名。

旧 single_worker / parallel_workers 及两项固定任务图继续支持，作为排除规划差异的辅助实验。自主实验不共用预先写好的分解答案：同一个输入快照的任务图为空，在运行时记录各调度模型的计划。

## 自主规划的接口与边界

autonomous 调度者自行调用 experiment_plan 登记任意数量（预算范围内）的任务、依赖和写入范围。登记格式是工具协议，不提供“两项任务/某种模块拆分/收益阈值”答案。它决定任务分组、启动时机、等待、集成和修复；宿主固定候选执行模型、预算和权限。

派遣后计划锁定；已登记但未执行的任务可续接给同一实现者，修复也沿原会话。初版研究初始规划与执行策略，不支持派遣后的全图动态重规划。调度者仍是只读编排角色，不能直接接管实现；是否完全不使用调度者通过 S1/S2 单独对照，不把 autonomous 误称为“可任意转入直接实现”。

宿主拦截跨任务重复归属、依赖未结束、并行写入范围重叠、角色/模型覆盖及累计实现者超限。结束的会话不等于任务的行为正确；最终质量由验收决定。

## 模型与恢复

每个 run 配置独立的 dispatcher/executor/verifier 选择器，只存通道和模型 ID 或无歧义完整名称，不存 Key。复用 Bloma 现有委派渠道解析及 SDK env 适配，参考本地 Proma bf3e98c 持久化角色/通道模型标识的机制；不迁移全套上游运行时。

实现请求强制进入 E，调度请求进入 D，Verify 及其 SDK 子调用进入 V。骨架会话恢复先读取持久交接，再重新解析当前实验的 E 绑定，不能因为跨进程丢失 channelOverride 而偷偷继承 D。修改已封存的模型/预算条件或运行中更换模型目录身份会拒绝执行。

模型事件保存请求角色、实际解析的通道 ID、请求模型名、宿主、有效输出上限、温度与思考档位。SDK 账本使用实验 run_id 与 experiment_dispatcher/executor/verifier 角色。只证明请求路由，不证明服务端隐藏权重版本；使用可辨识的固定模型版本名。

请求参数默认统一 temperature=0.1、thinking_level=low、max_output_tokens=8192；通道上限更低或收尾轮进一步缩小时按有效上限记录，不假称完全相同计算量。供应商对思考参数的拒绝/降级仍须从实际渠道日志核对。

## 冻结与条件哈希

prepare 默认 planning=autonomous。freeze 不接受预先给定的任务图，自主任务图在各 run 的事件与配置中生成。longterm 仍需已结束的骨架实现者交接；S1/S2 重放交接进入直接实现模型，G 组将其作为首名实现者恢复。

input_hash 标识共享初始输入；condition_hash 标识 policy、模型、预算、采样、平台及冻结输入保护规则。不同模型条件应共享前者并分别封存后者。PRD、已确认 UX、架构声明、契约、冻结需求场景及提示词覆盖在运行前后核对哈希；代码与运行日志允许正常变化。

两组使用独立 home，保留冻结实体标识和材料归属，运行请求重新创建。环境和渠道仍须在每个隔离 home 配置；不会自动复制凭据。必须修正该 home 的原生模型路由并重启到本次构建，再运行实验。

## 内部操作

先 npm run build，再在独立 home 创建一个原生项目；初始需求提交前执行 prepare。按原生 PRD/UX、长期型 Arch/Scaffold 准备，直到 Implement 前停点。

```powershell
node scripts/dispatch-experiment.mjs prepare --home <准备home> --project <项目ID> --experiment model-pilot
node scripts/dispatch-experiment.mjs freeze --home <准备home> --project <项目ID> --out <新快照目录>
# longterm 另加 --seed-worker <骨架委派ID>
node scripts/dispatch-experiment.mjs matrix --snapshot <快照目录> --home <不存在的矩阵目录> --models <模型对JSON> --run-prefix T1-r1 --worker-limit 1
```

模型对格式见 `tests/fixtures/dispatch-experiment/model-pair.example.json`，先替换实际选择器；验证模型可以与 M1/M2 相同，但在全部条件中保持一致。matrix 只创建六份隔离配置与 matrix.json，不调用模型、不自动开始应用。

手动选择一个条件也可以：

```powershell
node scripts/dispatch-experiment.mjs restore --snapshot <快照目录> --home <新home> --policy autonomous --run G12-r1 --models <角色模型JSON>
# 独立实现用 --policy standalone
# 可追加 --limits <预算JSON> --settings <采样JSON>
node scripts/dispatch-experiment.mjs inspect --home <该home> --project <项目ID>
node scripts/dispatch-experiment.mjs report --home <该home> --project <项目ID> --out <不存在的报告JSON>
```

角色模型格式见 `model-profiles.example.json`。应用启动的 PROMA_HOME、独立 user-data、两个桌面/实验开关与上一批相同。打开冻结父会话后继续，每个条件分别运行。

## 预算与报告边界

默认限额：最多 2 名实现者、16 项任务、调度/Verify 每段 40 轮、实现者每段 32 轮、128 次被包装的逻辑 SDK 请求、30 分钟共享运行期限。复用会话不会重置累计请求数和期限。机器循环及其 SDK 请求携带共享取消信号；native 宿主尾链仍有各自工具超时，不承诺所有进程在同一毫秒结束。

资格探针与不经过该 SDK 包装的辅助工具请求仍从项目账本另行观察，不把 128 次限制写成全部物理 HTTP/网络请求上限。实际费用需结合账本完整性和模型费率，不以跨模型 Token 总量冒充费用。

report 输出角色请求数/模型、实现者数、重叠执行请求峰值、机器就绪时间、MVP 确认等待、原生终态、请求账本和协议拒绝。代码测试专门验证两个执行 SDK 请求在时间上重叠，超过“只创建了两个会话”的证据。

product_quality 保留 null，直到独立冻结的产品验收提供评分；loop completed、mvp_ready 或 delivered 不直接冒充研究质量 Q。能力差距 D、配对互补挽救率 R、混合协作增益 G 需真实匹配任务和最终评分后计算。无失败样本时 R 为不可估计，不写成 0。

先完成通路和数据对账，再跑小样本真实模型预检；本批不训练路由器，不提供论文式效果结论。

## 本次验证

2026-10-13 执行：全量单测 259 文件/2365 例通过（`run-artifacts/model-experiment-full-unit.log`）；此前定向 6 文件/124 例通过；最后补齐独立实现者的环境探测工具后，2 文件/35 例补充回归通过（`model-experiment-final-regressions.log`，属于同套用例，不相加）。集成 2 文件/8 例、typecheck、主/渲染/桥构建通过（`model-experiment-integration.log`、`model-experiment-typecheck.log`、`model-experiment-build.log`）。

已验证 G11/G12/G21/G22 的实际 SDK 参数、独立实现通路的写入工具与零子会话、六组配置矩阵、V 固定、骨架交接重放后的 E 绑定、实际执行请求重叠、矩阵 CLI、条件/目录/冻结需求篡改拒绝、请求期限与限额、采样与输出边界。模型调用均为测试替身；未请求真实模型端点、未形成费用或效果结论。
