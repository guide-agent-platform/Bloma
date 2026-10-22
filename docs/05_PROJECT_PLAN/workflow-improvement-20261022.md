# 全流程完善计划与实施记录

## 探查结论与架构地图

基线：`sprint2 / 08dd34f`。起始已有 `production-workflow-v2-20261020.md` 两行未提交补充，保持原样。当前实现沿用上批已验证的取消、原子持久化和版本门。

| 环节 | 当前权威接线 | 本次完善点 |
| --- | --- | --- |
| 输入/材料/消息身份 | `platform/attachments`、`orchestration/stages` | 保留 generation、幂等接收、累计预算，不另建消息通道 |
| 需求/UX确认 | `guide/prd-confirm.ts`、`guide/ux-confirm.ts`、`project/ux-binding.ts` | 复用当前确认与重入纪律，恢复不能代替用户确认 |
| 制作/委派 | `desktop/dispatcher-loop.ts`、`agent/delegation` | 父上下文已隔离工具和预算，不改既有任务分解或模型策略 |
| 核心/专项验证 | `desktop/core-verification.ts`、专项宿主probe | 提取能力注册表，统一逐项结果合并；宿主独立GUI规则与产品测试分离 |
| 收口/交付 | `desktop/desktop-route.ts`、`mvp-confirm.ts` | 提取模式策略；持久化MVP确认，确认时复核版本 |
| 证据/重启 | `verification-receipts.ts`、`project/recovery-service.ts` | 宿主凭据按源码、需求、环境、输入版本复用；中断不重置预算 |
| 科研评分 | `dispatch-experiment-evaluator.ts`、外部suite | 继续独立计算Q，平台GUI执行不自动修改历史评分 |

上游参考：本地 `proma-upstream / bf3e98c` 的原子文件和持久化会话恢复惯例；Bloma保留自身JSON/JSONL、PRD版本和确认语义，不整体迁移上游编排。

## 分批计划与验收

1. **统一规则。** 增加纯交付策略，集中quick/longterm/v2选择；以可注册的能力验证器承接语音、文件、模型检查。验收：模式矩阵、原有覆盖规则和失败优先级保持；未知能力不能自动PASS。
2. **持久恢复。** MVP待确认记录持久化到宿主home，重启后按项目/会话/源码/需求版本恢复；失效时重新验证，消费记录与交付状态不因写盘失败丢失；不自动发起模型任务。验收：模拟新进程、记录损坏、版本变化、消费失败与累计预算保留。
3. **独立GUI业务验收。** 增加宿主侧声明式GUI suite和执行器，使用固定预期、DOM实际操作/读回、重启与隔离数据；suite不由生成目录中的自报PASS取代。接入现有宿主核心结果，保留独立scope与原生启动检查。验收：真实操作、重启持久化、负向断言、取消/超时清理、规则或产品变化失效。
4. **验证去重。** 只复用完整、持久、未过期的宿主结果；键绑定需求/源码/注册规则、解释器/依赖/环境。新尝试先使旧PASS失效；失败/未知/中断不能复用，硬件证据仍单独检查。验收：不变输入减少执行次数；每类输入变动重跑；落盘失败旧PASS不能复活。
5. **闭环验证与维护。** 对改动运行定向回归，再运行正式测试目录、类型、构建、文档和隔离Electron检查；执行可获得本机运行时的GUI实测。每批验证后单独commit，最终更新本文件与允许的记忆增量。

本次不调用付费模型、不采集麦克风、不改历史实验样本、不push。没有本机GUI运行条件时记录明确阻塞，不把替身测试计作真实业务验收。不会在缺少正确性证据时直接删除门禁。

## 实施结果

### 已完成的接线

- `aa5eda6`：`delivery-policy.ts` 集中模式/协议选择；`capability-verifiers.ts` 提取宿主能力验证注册表，保留现有能力推断、逐项覆盖与失败优先级。扩展项返回unknown时，整体不能签发PASS；重复身份和悬空功能拒绝接入。
- `b075501`：MVP pending 从内存Map迁到宿主home的 `pending-confirmations/`。pending→consuming→consumed 原子存储；中断在consuming可再次确认，项目写盘失败不丢确认对象；会话、源码或PRD scope不符拒绝交付，损坏记录不会当作“没有确认门”。
- `e72d25d`：宿主原生GUI执行器、内部CLI、核心验证入口与版本化验证凭据共同接线。GUI与凭据复用共用核心入口，因此一并固化。普通桌面任务开始时也落generating_mvp/testing，MVP挂起时落blocked_for_user_decision，启动对账能够保留原阶段、源码、数据和累计尝试。
- `9c3c5fe`：交付最终状态由 `delivery-state.ts` 单一入口提交，quick/longterm/MVP确认一致设置completed并清理阻塞；各门的当前版本证据仍在提交前核对，未用状态提交替代门禁。

### 独立GUI验收的使用方式

这是宿主/研究者工具，未暴露为实现者可调用的Agent工具。规则保存在 `PROMA_HOME/gui-acceptance/<project>.json`，生成目录中的CORE_CHECK和自报PASS不能替代它。

```text
node scripts/gui-acceptance.mjs scope PROJECT_ID
node scripts/gui-acceptance.mjs install PROJECT_ID SUITE_JSON
node scripts/gui-acceptance.mjs run PROJECT_ID
```

scope返回当前需求版本和功能编号；独立审阅者根据已确认需求编写固定预期与实际控件选择器。suite示例：

```json
{
  "version": 1,
  "scope_hash": "scope命令返回的64位指纹",
  "covers": ["F-001"],
  "steps": [
    {"id":"empty","kind":"expect","selector":"#count","equals":"0"},
    {"id":"input","kind":"fill","selector":"#name","value":"验收记录"},
    {"id":"save","kind":"click","selector":"#save"},
    {"id":"added","kind":"expect","selector":"#count","equals":"1"},
    {"id":"restart","kind":"restart"},
    {"id":"persisted","kind":"expect","selector":"#items","equals":"验收记录"}
  ]
}
```

执行器以原生pywebview桥运行登记的Python入口，不使用dport/业务API直调来代替点击；fill/click是实际DOM事件，expect读取实际DOM文本或value。最多60步、4个进程段，每段必须有断言；重启保留同一隔离APP_DATA_DIR，结束/取消清理受控进程与临时数据。规则文件、需求或源码变化会使旧结果失效。

已安装suite会进入核心交付门：失败阻断交付，证据不完整保持unverified。没有安装suite的旧项目维持原检查协议，不补造外部GUI通过；科研Q仍由独立冻结evaluator计算，不因宿主GUI通过而回写旧样本。

当前适配范围明确限于 `LAUNCH.json` 的两个命令段（Python解释器、项目内.py入口），支持原生pywebview。带额外启动参数或其他UI框架返回unverified，后续通过适配器扩展。当前证据为DOM与实际动作读回，尚未自动生成业务步骤截图。

### 验证复用的边界

只有宿主home中完整的passed凭据可在5分钟内复用。复用键包含完整PRD scope、源码/CORE_CHECK声明、实际venv解释器和依赖元数据、环境、安装计数、宿主实现/探针版本及独立GUI suite。每轮逻辑/GUI脚本使用新的空测试数据目录。

新执行必须先原子写running标记，再运行真实检查，最后写完整结果与校验摘要。执行失败、取消、结果落盘失败不会让旧PASS复活；同项目已有验证在途时返回环境阻塞，不另开一条失去取消所有权的验证。未知PATH解释器、语音/硬件能力和自定义注入执行器不参与生产复用。

实现者自测入口与交付门均接入此凭据；源码或需求变化重跑。longterm工程契约driver与CORE_CHECK的场景注册尚未合并，本轮未删这两类独立判据，也没有承诺所有重复工作已消失。

### 实际验证

证据前缀：`run-artifacts/workflow-20261022-*`。

- 首批规则回归：5文件/98项通过；持久恢复回归：3文件/76项通过。
- GUI和模型实验回归：3文件/85项通过；桌面与启动对账回归：69文件/752项通过。集合重叠，不能相加计覆盖。
- 真实原生GUI fixture：8个实际动作/断言通过，包含保存、重启留存、空输入错误与数据未增；故意把预期改成999时确实失败并读到实际值0。证据 `workflow-20261022-native-gui.json`。这是原生测试应用的机制验收，不是新一轮LLM生成产品质量结论。
- 实际CLI scope→install→run：5个动作/断言通过，源码未变，证据 `workflow-20261022-cli-gui.json`。
- 真实Python验证复用：相同输入连续检查两次只执行一次脚本；修改源码后计数变成2。缓存回归12项通过，日志 `workflow-20261022-reuse-native.log`。
- 最终收口状态回归2文件/67项通过；Python独立测试25项、脚本独立测试13项通过。
- 正式Vitest四个目录合并执行：**306文件/2734项全部通过**，日志 `workflow-20261022-full.log`。全量运行期间最后将相同交付字段提取为单一写入口，额外对该最终收口执行2文件/67项通过（`workflow-20261022-delivery-state.log`）；集合重叠，不能相加或称在最后源码上另跑了全量。
- 最后工程源码 `9c3c5fe`：typecheck、完整renderer/main/preload构建、隔离Electron S0-UI-007启动全部通过，日志 `workflow-20261022-types-delivery.log`、`workflow-20261022-build-final.log`、`workflow-20261022-electron-final.log`。文档检查通过（`workflow-20261022-docs.log`）。
- 本轮源码共四个提交，计划/实施文档与README最后单独提交；均未push。原有流程文档两行改动仍保留未提交。

### 保留的后续方向

PRD/UX仍沿用现有内存确认和归档重入机制，本轮持久化重点为交付前MVP确认；完整的跨重启候选设计/调整等待状态序列化尚未引入。统一交付写入口已落地，但longterm契约与核心场景的统一注册、更多UI框架、逐步骤截图及更强进程隔离仍需各自的适配与验收。宿主规则、指纹和文件白名单不是操作系统安全沙箱。

这些边界不会被标作已完成的新能力；本次没有付费模型、麦克风采集或历史实验重评分。
