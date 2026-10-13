# Bloma 原生调度实验基础设施

本批将原生 Implement 前暂停、冻结、隔离恢复和单／双实现者约束接入 Bloma。普通项目不加载实验配置；内部通路要求显式开关与独立实验 home。尚未执行真实模型 A/B，也未证明并行收益。

## 接线与模式

`BLOMA_DESKTOP_DISPATCH=1` 开启桌面线，另设 `BLOMA_DISPATCH_EXPERIMENT=1` 才加载 `PROMA_HOME/dispatch-experiments/<project_id>.json`。实验配置位于产物根之外，必须有隔离 home 标记；默认真实 `~/.proma` 拒绝参与。

quick：按原生 PRD、UX 门进入 Implement 前停点，零 Implement 模型请求。longterm：按原生 Arch、Scaffold 自动推进，到同一停点。恢复后仍走各模式原生核心验证、Verify、安全、冒烟、MVP 确认，不互相替换流程。

`single_worker` 使用一名实现者完成两个冻结任务；`parallel_workers` 最多两名，每名固定对应一个任务。宿主固定 implement 角色与继承模型，拦截未知任务、跨渠道/角色覆盖、依赖未完成与重叠写入的同时执行。重入/修复复用记录中的实现者，不能通过连续创建绕过累计人数上限；已取消实现者要求另开实验运行。

调度员和子会话采用实验专用阶段副本，替换原有“一次性委派”和“同一委派线”的冲突措辞，不改变全局阶段表。若模型直接输出推进但没有结束冻结任务，宿主拒绝本段收口。任务执行结束仍不等于产品验收通过。

写入限制覆盖 `write_file` / `edit_file` 的任务路径。脚本运行、依赖安装等原生工具仍受原本边界与预算约束；这不是独立 OS 文件沙箱。正式实验需检查实际文件差分，并将脚本引起的跨任务修改记为协议偏离。v0 不承诺从任意不受控脚本获得强隔离。

## 冻结和恢复

首版只接受一个实验项目的隔离 home；会话索引不能混入其他项目。按白名单保存产物、项目文档、会话、材料索引/快照、图片、提示词/模板覆盖及模型路由。排除渠道凭据、旧请求账本、venv、Git 目录和缓存，拒绝链接；源数据只读。

按文件和完整冻结配置计算 input_hash。恢复前验证文件及任务、交接元数据；目标 home 必须不存在。A/B 位于独立 home 内，保留冻结的项目/会话/材料标识，因此既有 PRD／UX 指纹和材料归属不被新 UUID 破坏。项目根、会话文件路径重定位；运行请求 ID 新建，实验 run_id 不同。不可将两个 home 合并进同一生产索引或让两个运行共用同一 app 进程。

longterm 冻结必须显式选择属于同一项目、同一父会话、已 completed 的骨架委派。恢复后按持久交接重建 finished 记录，再用现有 `continue_delegation` / `replayTurnsFrom` 重放历史。第一名沿用骨架交接，B 的第二名从相同冻结架构/契约材料出发。骨架结束不等于第一项业务任务已经执行，不会提前放行依赖它的任务。

恢复后需要重建或核对运行环境，并通过原生界面在各隔离 home 配置相同渠道。凭据不会自动复制。冻结时若本地构建存在，将锁定主 bundle 哈希；重新构建后需重新冻结，防止 A/B 使用不同平台代码。脚本应从本仓库运行，应用也从本仓库启动。

## 内部 CLI

以下操作只处理文件与元数据，不调用模型，不自动过确认门、不自动启动 Electron。

先在独立 home 启动 Bloma、创建一个项目，在提交初始需求之前登记 prepare 配置。`<...>` 为实际参数，不要原样执行：

```powershell
node scripts/dispatch-experiment.mjs prepare --home <准备home> --project <项目ID> --experiment pilot
```

沿原生确认流程推进，界面出现“已停在 Implement 前”后，创建两个固定任务的 JSON。文件分工必须覆盖原生交付所需的集成、LAUNCH 和 DELIVERY；两组共用。示例 `tests/fixtures/dispatch-experiment/tasks.example.json` 需要根据真实冻结 PRD 调整，不自动替代用户需求。

```powershell
node scripts/dispatch-experiment.mjs freeze --home <准备home> --project <项目ID> --tasks <任务JSON> --out <新快照目录>
# longterm 增加 --seed-worker <骨架委派ID>
node scripts/dispatch-experiment.mjs restore --snapshot <快照目录> --home <不存在的A-home> --policy single_worker --run T1-A-r1
node scripts/dispatch-experiment.mjs restore --snapshot <快照目录> --home <不存在的B-home> --policy parallel_workers --run T1-B-r1
node scripts/dispatch-experiment.mjs inspect --home <A-home> --project <项目ID>
```

以各自 PROMA_HOME 和独立 Electron user-data 启动应用，打开 inspect 返回的父会话，配置相同渠道、检查环境后发送继续。两组按预定顺序运行；不要同时让 A/B 争用本机。

在 PowerShell 设置该实例环境时使用：

```powershell
$env:PROMA_HOME = '<A或B的绝对home路径>'
$env:BLOMA_DESKTOP_DISPATCH = '1'
$env:BLOMA_DISPATCH_EXPERIMENT = '1'
& .\node_modules\.bin\electron.cmd . --user-data-dir='<该home内独立electron-user-data路径>'
```

关闭实验实例后清除或还原这三个环境变量，再启动普通实例。不要指向默认 .proma。

## 记录与验证边界

独立 JSONL 记录 prepare_started、prepared、frozen、restored、implement_started、implement_loop_finished、委派/拒绝、stage_finished、mvp_ready、delivered；同时关联 request_id、会话与 worker。长期型 mvp_ready 与 delivered 分开，可测确认等待。

模型用量继续以请求账本为准。旧准备用量不复制到 A/B；准备 cost 需从准备 home 另行归档。v0 尚未提供完整费用聚合、整个原生尾链的统一墙钟截止、统计分析及外部功能评分器；单段原生轮数/工具预算仍生效。真实试跑前由实验监督器规定总时间与外部验收，不应把这批接线验证写成科研效果。

本地上游参考：Proma `agent-fork-workspace-copy.ts` 的环境/缓存排除方式，以及 Bloma 既有会话前缀复制、委派交接重放。适配为严格拒绝链接、完整哈希清单、每 home 一个项目、实体标识保留；未整体复制上游模块。

测试包含双模式原生暂停、实际 Node CLI、源数据不变与两个 home 的独立性、材料保留与凭据/旧用量排除、文件/配置篡改、链接拒绝、长期型历史重放、真实子工具写入、角色/模型/依赖/路径拒绝、跳过任务的提前推进拒收；新增通路测试使用替身 SDK，无真实模型调用。

2026-10-13 本次执行：全量单测 258 文件/2350 例通过（`run-artifacts/dispatch-experiment-full-unit.log`）；定向回归 5 文件/136 例通过（`dispatch-experiment-targeted.log`，属于全量覆盖，数量不相加）；集成 2 文件/8 例通过（`dispatch-experiment-integration.log`）；typecheck 与主/渲染/桥构建通过（`dispatch-experiment-typecheck.log`、`dispatch-experiment-build.log`）。新通路的实际文件写入、CLI 和历史重放验证通过，不代表已有真实模型生成质量或并行收益数据。
