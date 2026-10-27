# 第二模型验收设计：受限首版

本说明对应 [Harness 改进计划](harness-improvement-plan-20261027.md) 批次 3。默认关闭；本轮仅替身与隔离真实浏览器验证，未调用真实模型，未创建真实 home 的启用配置、预算证明或账本。

## 真实接线

`runLeanProduction` 在需求/界面确认、现有预算准入之后、实现循环之前调用 `prepareIndependentDesign`。B 只有一次无工具 JSON 调用，输入是完整已确认需求、预期、行为断言、约束、范围外事项和确认界面 HTML；不提供实现文件、工程路径或读写工具。直接制作的界面委托以无 HTML 的明确状态传入。

B 只设计最多 12 个关键 GUI 案例，每项关联一个现有 F 编号；步骤仅支持逻辑控件 fill/control/value、click/control、expect/control/equals、restart。每项必须有操作和断言，未知功能、可执行步骤或模型自报 PASS 拒绝。编号关联不证明语义覆盖，也不替代原有全范围核心验收。

宿主将业务输入、预期、顺序及模型/范围/operation/界面身份冻结在工程外。A 用 `read_production_context({topic:"independent-design"})` 读取案例，只能写 `INDEPENDENT_ADAPTER.json`：

```json
{
  "version": 1,
  "design_digest": "宿主冻结设计的digest",
  "controls": {
    "name": "#name",
    "save": "#save",
    "result": "#result"
  }
}
```

映射只接受有界静态 CSS 字符串，未知控件、断言/输入覆盖字段和脚本拒绝。宿主从冻结业务步骤构造操作，实际执行应用并检查精确值；A 的 JS 与 B 的文字都没有 PASS 权限。适配和设计版本进入凭据输入；最终仍须安全、原有业务、独立业务、正常启动和源码/候选一致性共同通过。失败结果返回实际步骤、期望/实际与报告路径。

## 启用与费用边界

宿主配置位于真实 `PROMA_HOME/software-independent-design/policy.json`，字段为 `version:1`、`enabled`、`channel_id`、`model`、`monetary_policy_path`、`authorization_path`、`timeout_ms`（100–60000）、`max_tokens`（512–4096）。配置不是模型工具参数；项目内同名文件不生效。缺配置明确保持单模型，已启用后缺能力/丢配置/缺当前设计不会静默换 A 自审。

真实调用前需用户明确新预算并核对渠道、余额/配额、费率、累计账本和请求前金额保护。授权证明须来自用户确认，绑定 project、当前 operation、B 的 model/host、有限正数 `cap_rmb`、金额策略文件 SHA-256；既有金额 state 必须匹配策略，完整输入和响应预留可负担。不得从旧实验余额生成新授权，不重置账本或未结算预留。

独立模型须与 A 的模型名不同，只能使用配置中明确启用的渠道/模型，不附加备用渠道信息；实际每次物理请求仍核对 host/model。请求和输出使用同一 operation 的共享 harness 额度，另记 acceptance-design 阶段，usage ledger 的 role 为 acceptance_designer。实际传输仍走已有金额预留与结算保护。

一次设计最多一次物理请求，不隐式修复或换模型重试。调用开始前保存尝试身份；超时、中断、无效输出或宿主退出后，同授权不会自动重发。需要新的明确授权证明才能再尝试。缺能力、预算或超时明确 blocked。没有针对产品 API 的付费测试授权扩张。

## 当前验证与限制

替身覆盖默认关闭、无工具/不读取实现、显式模型路由、费用角色/共享额度、缺能力/同模型/缺预算/换路由、无法承担完整输入预留、超时且不重发、取消、损坏冻结资料。真实浏览器执行冻结业务案例，正确版本通过、产品错误失败，适配不能改预期。原有 PASS 复用/失效路径另做回归。

这是 GUI 关键场景的工程首版：CLI 独立设计当前明确缺能力；未添加视觉审阅或真实双模型质量实验。静态控件映射仍需结合真实画面检查，不能仅由测试绿色证明映射语义正确。B 的案例也可能错漏，须由后续固定任务对照记录漏检、误报、排障和用户介入，再决定是否启用。
