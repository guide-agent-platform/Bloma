# 单模型与 A＋B 验收设计对照：项目级配置

起点 `sprint2 / 724b842`。本批把现有独立验收设计和固定任务评估接成可分别配置的实验路线，不引入新的 Agent 引擎。B 只基于确认需求与 UX 设计业务案例，A 实现并映射控件，宿主执行和裁决。没有加入失败会诊或视觉审阅。

## 解决的问题

- 原独立设计只有 home 全局开关，同一 home 下切换实验组会影响其它项目。现在项目配置优先，旧全局配置仅作未配置项目的兼容默认。
- 项目配置保存在 `PROMA_HOME/software-independent-design/PROJECT_ID/policy.json`，绑定项目及 operation；历史配置按 digest 保留。开始设计、制作或绑定研究记录后，配置命令拒绝换组。配置损坏、丢失或 operation 不匹配明确阻塞，不回退到全局设置。
- 所有消费点统一按项目读取：B 准备、独立执行、生产上下文、通过凭据版本和评估事件。
- 直接制作界面的确认哈希包含项目 ID，原配对器会误拒两个隔离项目。新评估绑定用经过确认校验的“界面委托方式＋交付形态”或实际确认 HTML 内容身份比较；产品本身的确认、来源和验收凭据仍绑定项目，不修改其安全含义。
- 评估绑定冻结生效的独立配置摘要，执行事件记录当前配置及界面身份；同样 enabled 但换了 B 配置也会使记录不可比较。配对要求不同项目和运行 ID，并继续核对同任务、协议、预算、设计和 A 的实际模型/渠道。
- `stage` 在确认前登记待运行的实验，正常生产入口在第一次模型调用之前校验已确认目标、界面、operation、配置和原付费证明，再绑定记录。目标不匹配时阻塞，不抢跑制作、不生成新确认；续跑复用原绑定，保留失败记录。
- 报告增加 `acceptance_models`、`acceptance_hosts`、`acceptance_physical_requests`，按实际 usage ledger 的 query/transport 身份统计，B 请求仍包含在原总数中。单模型组调用 B、A/B 实际同模型，或付费已交付 A＋B 样本缺 B 请求证据，都不能当作公平对照。
- CLI 的绑定和审计／费用注记不再被误算为执行宿主重启；真正的执行事件混用多个宿主身份仍使记录不可比较。

## 操作顺序

所有以下 CLI 命令只做本地配置、记录或报告，不发模型请求，也不生成用户付费授权证明。使用隔离 `PROMA_HOME` 和新项目，不能给历史失败样本换组。配置可在项目创建后、确认之前完成；运行时仍要求有效的需求及界面确认。

1. 用已有 `prepare` 命令封存固定任务协议；三项任务见 `tests/fixtures/harness-evaluation/tasks.v1.json`。
2. 在隔离 home 中创建两个新的 software-v1 项目，设置相同目标、预期、约束及使用形态。A 模型与渠道保持一致。
3. 在制作之前配置两组：

```powershell
node scripts/harness-evaluation.mjs configure-single SINGLE_PROJECT_ID
node scripts/harness-evaluation.mjs configure-independent INDEPENDENT_PROJECT_ID B_POLICY_JSON
node scripts/harness-evaluation.mjs independent-status INDEPENDENT_PROJECT_ID
```

`B_POLICY_JSON` 是宿主配置，沿用现有格式，例如：

```json
{
  "version": 1,
  "enabled": true,
  "channel_id": "明确选择的B渠道ID",
  "model": "明确选择的B模型名",
  "monetary_policy_path": "C:/isolated-experiment/b-money.json",
  "authorization_path": "C:/isolated-experiment/b-authorization.json",
  "timeout_ms": 60000,
  "max_tokens": 4096
}
```

路径示例不是已经创建的策略或授权。配置不存 API Key，拒绝额外字段。`independent-status` 只返回本地选择、B 的渠道/模型名称和设计状态；`admission: not_checked` 表示没有核实余额、渠道可用性或实际付费准入。

4. 在用户确认前，登记两组；示例 RUN_ID 必须分别唯一：

```powershell
node scripts/harness-evaluation.mjs stage PROTOCOL_JSON SINGLE_PROJECT_ID TASK_ID single SINGLE_RUN_ID
node scripts/harness-evaluation.mjs stage PROTOCOL_JSON INDEPENDENT_PROJECT_ID TASK_ID independent INDEPENDENT_RUN_ID
```

上面只适用于 offline 工程检查；paid 协议必须在最后提供真实用户确认的 `AUTHORIZATION_JSON`。登记后正常完成任务单／界面确认；平台进入制作时自动绑定。两组采用同一确认草图，或都明确授权直接制作界面。已有确认资料且能在制作前准备的自动测试客户端仍可用原 `bind`；CLI 不代替用户确认，也不自动启动生产。登记／绑定后不能通过配置命令换组。
5. 正常执行原生产入口。A＋B 组先运行一次受保护的 B 设计，冻结输入/断言，A 通过 `read_production_context(independent-design)` 获取案例，只写静态 CSS 映射；单模型组沿原流程执行。
6. 用原 `annotate` 附完整账本、实际费用及独立缺陷审计，再 `report`。保留中止和失败；缺少证据标为未知或不可比较。

## 费用与适用边界

真实试验仍需用户明确给出 A/B 模型、渠道及金额授权，并现场核对余额/配额、费率、已有责任和完整请求预留。现有金额策略按 host/model 控制；不能将 A、B 的两个独立上限都设成整个实验预算后声称已实现共享金额硬上限。开跑前需核对各生效策略及其额度分配，保证总授权没有被重复使用。研究协议与事后费用校验不替代请求前保护。

本批不写真实 home 配置、不迁移真实项目、不创建预算证明、不重置账本、不调用供应商。独立设计仍仅支持关键 GUI 案例，B 自己也可能错漏；编号关联和实际执行通过不证明语义覆盖完整。旧记录继续可读，不从缺失的新增字段倒推历史实际路线。新代码需主进程正常重启后加载，不自动关闭用户进程。

与旧实现的关系及原费用协议见 [独立验收设计首版](independent-acceptance-design-20261027.md)、[固定任务对照](harness-evaluation-20261027.md)。核对本地 Proma 上游 `bf3e98c` 的会话计量入口，继续使用 Bloma 既有 Pi、宿主策略及 request ledger；没有复制另一套运行框架。

## 本批验证

- 首轮设计／评估 2 文件 / 25 项通过，`run-artifacts/independent-project-20261028-tests.log`。
- 扩大回归 5 文件 / 42 项通过，涵盖真实 Electron／浏览器交互与重开、错误预期拒绝、Pi 超过旧轮数／阶段请求限制的连续执行及预算耗尽后宿主检查；`independent-project-20261028-regression.log`。
- 加入确认前登记／生产自动绑定后，受影响的设计、评估、连续执行 3 文件 / 34 项通过；`independent-project-20261028-closure.log`。另两文件 / 10 项未受后续变更影响，已在扩大回归通过。当前相关范围为 **5 文件 / 44 个不同测试项，分批通过**，不是一次全仓全绿，重叠复跑不相加。
- 损坏运行状态拒绝换组的最后补充复验 1 项通过，其余 18 项未重复执行；`independent-project-20261028-policy-closure.log`。修正 CLI 审计注记宿主身份判断后，整个评估文件 10 项通过，包括执行宿主真正变化仍拒绝；`independent-project-20261028-report-closure.log`。这些均与上述范围重叠。
- 类型检查、完整构建通过，日志为 `independent-project-20261028-typecheck-closure.log`、`independent-project-20261028-build.log`；评估报告最后修改后补 main 构建和文档／类型检查，见 `independent-project-20261028-final-checks.log`。diff 空白检查通过。

所有证据在本机忽略的 `run-artifacts/`。模型响应均为替身，真实浏览器使用本机固定应用；没有付费请求、真实用户数据迁移或重启用户 Bloma。工程样例不能作为真实模型质量、A＋B 收益、完整产品验收或干净机器交付的证据。本批仅本地提交，不 push；用户原有生产流程文档两行改动保留且不纳入提交。
