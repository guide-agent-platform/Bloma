# Sprint 0-1 测试设计与需求追踪审计

> 文档类型：测试设计审计与操作记录  
> 分支：`sprint1-A`  
> 审计基线：`9a7ad4d`  
> 日期：2026-07-25  
> 规范：DOC-6.2 `docs/06_TESTS/testing-standards.md`

## 审计摘要

| 项目 | 结论 |
|---|---|
| 审计范围 | Sprint 0 独立验收 19 项、Sprint 0 回归 4 项、Sprint 1 独立验收 17 项、Sprint 1 回归 11 项、Sprint 1 Electron E2E 8 项 |
| 总体结论 | `FAIL_TEST` 与 `REQUIREMENT_CONFLICT`；测试代码能够发现真实缺陷，但部分场景的 Sprint 归属、导航预期和行为断言没有对齐最高层产品要求 |
| 最严重错配 | Phase 3 的模式升级被当成 Sprint 1 阻塞项；“所有项目”入口被测试错误地禁止；启动恢复测试没有验证会话恢复；草图 E2E 没有执行真实交互 |
| 测试执行问题 | 并行运行两个真实沙箱套件造成一次端口竞争；Electron fixture 未隔离 `userData`，导致 `DevToolsActivePort` 拒绝访问并卡在 `firstWindow()` |
| 已确认有效 | 临时 `PROMA_HOME`、测试 ID、失败分类、埋点脱敏、沙箱越界、IPC/密钥/权限边界的主体方向正确 |
| 当前自动化结果 | `test:regression:sprint1` 11/11 PASS；`test:acceptance:sprint1` 17/17 PASS；`test:e2e:sprint1` 最终 8/8 PASS；`typecheck`、`docs:check`、`git diff --check` PASS。首次 E2E 复验的 1 项 `FAIL_TEST` 作为过程证据保留 |

本文件提供可复查的操作、输入、断言、需求来源和决策依据。它不导出模型隐藏的逐字思维链；“决策依据”是根据仓库文件、Git 记录、测试输出和用户确认重建的工程说明，可用于审查和纠错。

## 1. 操作时间线

| 时间/基线 | 操作 | 结果与判断 |
|---|---|---|
| 2026-07-19，`57d33c6` | 建立角色 C 的隔离测试夹具 | 测试写入切换到临时 `PROMA_HOME`，避免污染真实 `~/.proma/` |
| 2026-07-19，`7d81c4f` | 添加 Sprint 0 角色 C 验收套件 | 覆盖 IPC、存储、Agent、权限、密钥和 Renderer/Electron 边界 |
| 2026-07-25，`e457bc2` | 读取 Sprint 计划、PRD、API、GWT 和既有测试，建立 Sprint 0/1 独立验收 | 初始结果：Sprint 0 19/19 PASS；Sprint 1 11 PASS / 6 FAIL_PRODUCT |
| 2026-07-25，`87c83e7` | 固化测试规范、测试 ID、命令边界和报告格式 | 把回归、独立验收和结果分类固定到 DOC-6.2 |
| 2026-07-25，E2E 初版 | 新增 Playwright Electron fixture 和 8 条 Sprint 1 E2E | 初次把绝对项目路径放入 `args`，Windows 尾部反斜杠被错误引用，产生 `Unable to find Electron app at ...Bloma"`；分类为 `FAIL_TEST` |
| 2026-07-25，E2E 修正 | 改为 `cwd: projectRoot` 与 `args: ['.']` | Electron 可启动；8 条结果为 3 PASS / 5 FAIL_PRODUCT，验证了恢复、澄清、草图、等待和埋点问题 |
| 用户截图确认 | 用户明确说明卡片灰色小字只是选项解释，不应进入用户回答 | 新增 `S1-SKETCH-009`，并把该要求写入 GWT；该要求尚未同步回 PRD/interaction-spec，存在单一来源风险 |
| 2026-07-25，`9a7ad4d` | 拉取“修复 Sprint 1 阶段验收 7 个产品缺陷” | 远端实现按照测试修复了恢复、升级、澄清、草图和等待反馈 |
| 21:42 | 并行运行 `test:regression:sprint1` 与 `test:acceptance:sprint1` | 验收中 `S1-SANDBOX-001` 启动失败；定向重跑 PASS。两个命令都启动真实静态沙箱，竞争执行造成非产品失败，不应并行 |
| 21:43-21:44 | 分别运行回归与独立验收 | 回归 11/11 PASS；独立验收 17/17 PASS |
| 21:45-21:49 | 运行 `npm run test:e2e:sprint1` 和单条调试 | fixture 卡在 `firstWindow()`；trace 记录 `DevToolsActivePort` 写入用户目录被拒绝，GPU 子进程退出，分类为 `FAIL_TEST/FAIL_ENV`，不是产品断言失败 |
| 本次修正 | fixture 增加临时 Electron `userData`，并把 `start()` 放进 `try/finally` | 防止与手动启动实例共用 Chromium 用户目录，并保证 setup 失败时关闭 Electron、清理临时目录 |
| fixture 修正后首轮 E2E | 运行 8 条 Playwright Electron 用例 | 7 项 `PASS`；`S1-SKETCH-009` 在点击前超时。失败页面已经显示合法的新选项，但测试仍等待旧的 `card-option-goal`，分类为 `FAIL_TEST`，不是产品缺陷 |
| `S1-SKETCH-009` 测试修正 | 不再固定选项 ID 和示例文案；读取第一个实际选项的标题与灰色说明，点击后断言 JSONL 只持久化标题 | 将“选项标题与说明分离”作为稳定契约，允许合法文案迭代；同步把 GWT 中的“主要目标”改为任一澄清选项 |
| 22:51，最终 E2E 与质量门禁 | 重新运行完整 E2E，再执行 `typecheck`、`docs:check`、`git diff --check` | E2E 8/8 `PASS`；类型与文档检查 `PASS`；差异检查无空白错误，只有 LF/CRLF 转换提示 |

本轮实际使用的主要命令：

```text
npm run test:unit
npm run test:integration
npm run test:regression:sprint0
npm run test:regression:sprint1
npm run test:acceptance:sprint0
npm run test:acceptance:sprint1
npm run test:electron-smoke
npm run test:e2e:sprint1
npm run typecheck
npm run docs:check
git diff --check
```

## 2. 需求源采用方式

编写测试时实际参考了以下来源：

1. `docs/05_PROJECT_PLAN/sprint-plan.md`：确定当前 Sprint 目标与退出条件。
2. `docs/01_PRD/prd.md` 和 `user-stories.md`：确定用户价值、Phase 和验收骨架。
3. `docs/02_UX_DESIGN/interaction-spec.md`、`user-flows.md`、`sitemap.md`：确定可观察交互。
4. `docs/04_API_SPEC/api-spec.md`：确定 IPC、数据和错误契约。
5. `docs/06_TESTS/features/*.feature`：建立 GWT 场景和稳定 ID。
6. 实现与既有测试：判断测试层级、可用 fixture 和实际可观察入口，不应反向决定需求。

问题在于这些来源之间存在冲突，而当时没有先建立“冲突即停止”的门禁。测试倾向采用 `.feature` 中最具体的句子，因此 Feature 自身的阶段错误和过度细化被继续传递到了可执行测试。

## 3. Sprint 0 逐功能记录

### 3.1 IPC 契约

| 测试 ID | 实际操作与断言 | 决策依据 | 审计结论 |
|---|---|---|---|
| `S0-IPC-001` | 静态扫描 shared/main/preload 的 channel 对应 | Sprint 0 要求 IPC 四层不漂移 | 方向正确，但属于早期回归，覆盖弱于独立验收 |
| `S0-IPC-005` | 将 `IPC_CHANNELS` 与预期 Phase 1 channel 对象完全比较 | API 规范被视为 channel 单一真相源 | 精确但维护成本高；API 新增合法 channel 时必须同步测试 |
| `S0-IPC-006` | 用 TypeScript AST 收集 main/preload 的 `IPC_CHANNELS.*` 引用 | 避免字符串正则误判 | 只证明“被引用”，没有证明 payload 类型、Renderer consumer 和运行时行为，覆盖不完整 |
| `S0-IPC-007` | 通过 IPC harness 提交非法 mode，断言统一 `ApiResult`、request_id 和 P0 文案 | API 错误契约 | 可观察行为明确，匹配要求 |

### 3.2 Local-First 与 Agent 生命周期

| 测试 ID | 实际操作与断言 | 决策依据 | 审计结论 |
|---|---|---|---|
| `S0-STORE-003`、`S0-PROJECT-001` | 在临时 `PROMA_HOME` 创建项目并检查索引、项目、文档、快照目录 | Sprint 0 Local-First 目录契约 | 匹配要求，重复层级可接受但报告需分开统计 |
| `S0-STORE-004` | mock SDK 先输出 1 条 assistant message 再失败，检查用户消息、部分输出、终态 JSONL | Feature 要求部分失败仍持久化 | Feature 写“3 条 message_delta”，测试只产生 1 条 assistant message，证明了原则但没有完全对应场景数量与事件形态 |
| `S0-STORE-005` | 创建项目、运行一次 Agent，再扫描 `.sqlite/.db` 和少量数据库配置名 | 禁止运行时 SQLite/服务端数据库 | 代理断言偏弱；没有真正完成 Feature 所写的草图和 MVP 流程，也可能漏掉其他连接配置 |
| `S0-AGENT-004` | 修改 PATH/USERPROFILE，调用 `buildSdkEnv()`，验证继承和渠道覆盖 | SDK env 必须保留宿主环境 | 匹配要求 |
| `S0-AGENT-005` | 挂起首个 SDK query，再提交相同 session，断言 `AGENT_SESSION_BUSY` | activeSessions 并发守卫 | 匹配要求 |
| `S0-AGENT-006` | 启动可取消异步迭代器，调用 cancel，检查 iterator finally 和 activeSessions 清理 | 取消必须释放资源 | 匹配要求 |

### 3.3 权限、密钥与 Electron 边界

| 测试 ID | 实际操作与断言 | 决策依据 | 审计结论 |
|---|---|---|---|
| `S0-PERM-001`、`S0-PERM-002` | 创建 warning 请求，验证 publish、pending Map、session 隔离、resolve 和删除 | PermissionService 架构契约 | 匹配要求 |
| `S0-SECRET-001`、`S0-SECRET-003` | 使用可逆 safeStorage adapter，检查落盘无明文、公开接口返回 `***` | 密钥只在 main 解密 | 匹配主要要求 |
| `S0-SECRET-004` | safeStorage 不可用时验证加解密均失败 | Electron 安全存储边界 | 匹配要求 |
| `S0-SECRET-005` | 扫描 renderer/preload，禁止 `api_key`、`safeStorage` 和加解密 API | Renderer 不接触密钥 | 只覆盖源码边界；Feature 还要求会话与埋点 JSONL 无明文，需由独立隐私测试补齐 |
| `S0-SECRET-002`、`S0-UI-006` | 正则扫描 BrowserWindow 安全配置和窗口打开策略 | contextIsolation/sandbox/nodeIntegration 门禁 | 静态代理可作为架构门禁，但不等同于真实 Electron 运行验证 |
| `S0-UI-003` | 用 TypeScript AST 扫描 Renderer 禁止导入 Node/Electron 模块 | Renderer 隔离 | 匹配架构要求 |
| `S0-UI-001`、`S0-UI-004` | 人工触发全局监听器，验证不同 session 的 atom、阶段和权限队列 | 页面切换时监听器不丢事件 | 没有真的执行页面切换；证明了监听器状态逻辑，但没有完整对应 GWT 用户流程 |
| `S0-UI-005` | 比较 `main.tsx` 中 store、listener、render 的源码位置 | 监听器必须先于 App 挂载 | 是实现顺序代理，重构时容易误报；更稳妥的是运行时事件不丢失测试 |

## 4. Sprint 1 逐功能记录

### 4.1 两道门、项目创建和工作区

| 测试 ID | 实际操作与断言 | 决策依据 | 审计结论 |
|---|---|---|---|
| `S1-UI-001`、`S1-UI-007` | 渲染两道门，检查两种生活化入口和技术词不存在 | U-02、两道门 Feature | 方向正确；文档同时使用“快速试试看/长期认真做”和“快速尝鲜/精细打磨”，测试选择了后者，需统一文案源 |
| `S1-PROJECT-001`、`S1-UI-008` | mock 创建失败，检查不进入工作区和只显示 `user_visible_message` | P0 错误文案要求 | GWT 写固定“项目创建失败，请重试”，测试允许更具体的“本地保存失败…”，意图合理但逐字不一致 |
| `S1-PROJECT-002`、`S1-PROJECT-006`、`S1-PROJECT-011` | 点击 quick，检查 create mode、工作区、模式标签和无技术栈 | Sprint 1 两道门主链路 | E2E `PROJECT-011` 标题说“创建项目”，实际只检查 UI，没有读取 `projects.json`，存在假阳性 |
| `S1-PROJECT-007`、`S1-PROJECT-012`、`S1-UI-003` | 点击 longterm，检查模式标签和文档入口 | Sprint 1 Feature 要求入口可见；Phase 1 允许骨架 | 可接受，但不能据此宣称长期模式完整流程已实现 |
| `S1-PROJECT-010` | 长期模式 Header 不出现降级入口 | PRD 只允许 quick 升级 longterm | 匹配方向 |

### 4.2 模式锁定与项目导航

| 测试 ID | 实际操作与断言 | 决策依据 | 审计结论 |
|---|---|---|---|
| `S1-PROJECT-003`、`S1-PROJECT-008` | 进入工作区后禁止“返回模式/重新选择/所有项目” | 把“不能回到两道门”解释为不能离开工作区 | **测试设计错误**。interaction-spec R-MODE-04 禁止返回两道门，但同一文档明确要求可通过“所有项目”返回项目列表；测试错误地禁止了合法导航 |

修正方向：只禁止“重新选择模式/返回两道门”，并新增断言“所有项目”入口存在且进入项目列表；是否在 Sprint 1 实现项目列表需由计划确认。

### 4.3 启动恢复

| 测试 ID | 实际操作与断言 | 决策依据 | 审计结论 |
|---|---|---|---|
| `S1-STORE-001`、`S1-STORE-002`、`S1-STORE-003` | 本地存在项目时直接进入第一个项目工作区，重启后不显示两道门 | Sprint 计划写“项目和会话仍可恢复”，Feature 将其细化为“直接进入项目” | **需求冲突且覆盖不足**。user-flows/sitemap 要求有历史项目时先进入历史项目列表；测试没有验证会话消息恢复，却在标题中宣称恢复“项目与会话” |

修正前需要产品确认：回访用户是自动恢复最后活动项目，还是先显示项目列表。无论选择哪种，测试都必须验证对应会话 JSONL 被加载到 UI，而不是只看到项目名和输入框。

### 4.4 快消升级长期

| 测试 ID | 实际操作与断言 | 决策依据 | 审计结论 |
|---|---|---|---|
| `S1-PROJECT-004`、`S1-PROJECT-005`、`S1-PROJECT-009` | 检查完成项目升级入口、upgrade 快照和 mode 切换 | mode-selection Feature 中存在升级场景 | **Sprint 归属错误**。U-10 和 PRD 路线图明确把模式升级放在 Phase 3，sprint-plan 的 Sprint 3 才包含升级相关能力；不应作为 Sprint 1 阻塞缺陷 |

这些测试可以保留，但 ID 和门禁应归入首次实现该能力的阶段，或在当前阶段标成未来范围。`9a7ad4d` 为满足这些测试提前实现了一部分升级能力，但这不证明 Phase 3 的文档补全、确认弹窗和回滚链路已经完成。

### 4.5 澄清选项与灰色说明

| 测试 ID | 实际操作与断言 | 决策依据 | 审计结论 |
|---|---|---|---|
| `S1-SKETCH-001`、`S1-SKETCH-004`、`S1-SKETCH-007` | 发送模糊需求，检查 2-3 个生活化选项并包含“你帮我决定” | U-09、user-flows、用户截图确认 | 主体正确；design-system 写“建议 2-3、最多 4”，user-flows 写“不超过 3”，测试选择更严格的 3，需要统一上限 |
| `S1-SKETCH-005` | longterm 明确功能但缺少使用对象时继续澄清 | 长期模式需要明确目标用户 | 匹配要求 |
| `S1-SKETCH-009` | 读取任一实际选项的标题和灰色说明，点击后读取 session JSONL，断言只持久化标题且不包含说明 | 用户明确确认灰色小字仅作解释 | 首版硬编码旧 ID `goal` 和文案“主要目标”，实现合法改成生活化选项后产生 `FAIL_TEST`；修正后只锁定标题/说明分离契约。该规则目前只进入 Feature，尚未回写 interaction-spec，仍有文档漂移风险 |

### 4.6 可交互草图与 FIRT

| 测试 ID | 实际操作与断言 | 决策依据 | 审计结论 |
|---|---|---|---|
| `S1-SKETCH-002` | 一次本地确定性生成，检查小于 60 秒、URL、HTML、快照和埋点 | Sprint 1 FIRT 与闭环要求 | 这是工程 smoke，不是研究指标；无法证明连续 5 次真实草图的中位数 |
| `S1-SKETCH-003` | 报告中保留为人工/真实环境待验收 | research-plan 的 FIRT 中位数 | 正确地没有把单次自动化结果冒充研究结论 |
| `S1-SKETCH-006` | 静态检查单文件、`<style>`、`<script>`、事件监听字符串和 1-3 个 `data-page` | PA-01 明确要求内联 CSS+JS | 结构断言有效，但标题中的“可交互”没有被该测试真正操作验证 |
| `S1-SKETCH-008` | 从真实 webview 读取 outerHTML，只检查 `<script>` 和 `<button>` | 试图用 E2E 补足真实预览 | **断言代理过强且覆盖不足**。存在脚本和按钮不等于用户点击后有反馈；应在 webview 内点击并断言页面切换、状态变化或可见反馈 |

### 4.7 等待反馈

| 测试 ID | 实际操作与断言 | 决策依据 | 审计结论 |
|---|---|---|---|
| `S1-UI-002` | 直接渲染 WaitingFeedback，检查 10 秒安全文案和 120 秒按钮 | interaction-spec 的 5/10/120 秒三级规则 | 组件级回归合理 |
| `S1-UI-005` | fake timer：前 5 秒无卡片，6 秒后同时出现动作与安全文案 | U-05 写超过 5 秒包含安抚关键词 | **需求冲突**。interaction-spec R-WAIT-01/02 把动作提示放在 5 秒、安全说明放在 10 秒；测试选择了 user story 的 5 秒安全说明 |
| `S1-UI-006` | 点击独立组件按钮，再用源码正则确认 App 传入两个回调 | 120 秒必须可继续等待或看已有部分 | 只证明 props 和源码字符串存在，没有证明 App 中点击后的真实效果；应做 App 集成或 E2E fake-clock 测试 |
| `S1-UI-009` | 在 Electron 中替换 IPC 为永不结束 Promise，快进 5.1 秒，检查状态卡片 | 验证真实 Renderer 时序 | 时间行为正确，但断言文案是“生成可运行版本”，场景实际处于验证草图阶段，可能把错误阶段文案当成通过 |

### 4.8 Agent、快照、埋点与沙箱

| 测试 ID | 实际操作与断言 | 决策依据 | 审计结论 |
|---|---|---|---|
| `S1-AGENT-002` | IPC harness 收集事件，检查 generating_sketch → sketch_ready → completed 及相同 ID | Agent stream 顺序契约 | 主进程链路正确，但没有证明 Renderer 经真实 IPC 后的显示顺序 |
| `S1-SNAPSHOT-001` | 注入截图 provider，检查 PNG、摘要、时间和快照 JSON | Sprint 1 草图快照标准 | 结构正确；真实 Electron 截图质量仍需 E2E/人工验证 |
| `S1-ANALYTICS-001` | 解析 JSONL，检查三类事件、`research_safe` 和原始需求不出现 | Sprint 1 三类埋点与隐私 | 独立验收较完整 |
| `S1-ANALYTICS-002` | E2E 只做字符串包含/不包含 | 验证真实 Electron 落盘 | 覆盖弱于 acceptance；未解析 JSONL、未检查每行 privacy_level、字段白名单和 API Key 模式 |
| `S1-SANDBOX-001` | 启动真实静态预览，请求越界文件，检查非 200 且不泄露内容 | 沙箱目录边界 | 行为方向正确；启动失败断言只显示 `failed != running`，没有输出 error category，诊断性不足 |

## 5. 系统性原因

### 5.1 没有先冻结 Sprint 范围

Feature 文件按功能组织，不等于其中所有场景都属于当前 Sprint。模式升级位于 `mode-selection.feature`，当时按文件上下文分配了 `S1-*`，没有再次用 PRD Phase 和 sprint-plan 交叉校验，导致 Phase 3 功能成为 Sprint 1 缺陷。

### 5.2 文档冲突没有专用结果状态

当前规范只有 PASS、产品/测试/环境失败等状态，没有 `REQUIREMENT_CONFLICT` 的工作流。遇到“直接恢复 vs 历史列表”“5 秒安全说明 vs 10 秒安全说明”时，测试被迫选一份文档，选错后就会把实现误报为产品问题。

### 5.3 把源码特征当成用户行为

`<script>`、正则搜索 props、源码调用顺序等断言容易写且稳定，但只能证明结构存在。标题却使用“可交互”“操作可用”等用户行为词，造成测试名称比实际证据更强。

### 5.4 GWT 目前不是可执行真相源

仓库有 `.feature` 和相同稳定 ID，但没有 Cucumber/Playwright-BDD runner 直接读取 Feature。Playwright 测试是手工镜像 GWT，因此修改 Feature 不会自动使执行测试失败，二者仍可能漂移。

### 5.5 测试层重复但边界说明不足

回归、独立验收和 E2E 有意验证同一缺陷，但早期报告容易把多个失败 ID看成多个独立产品问题。当前报告已按缺陷 ID 去重，后续还应在测试代码旁标明该层独有的证据。

### 5.6 fixture 和执行方式也会制造假失败

- 绝对路径作为 Electron app 参数时，Windows 引号解析造成启动路径错误。
- 手动应用与 E2E 共用 Electron `userData`，trace 显示 `DevToolsActivePort` 拒绝访问，导致没有 window。
- 同时执行两个真实沙箱套件会发生端口/进程竞争。
- setup 失败时 `start()` 位于 `try` 外，Electron 进程不能保证清理。

这些都应归类为 `FAIL_TEST` 或 `FAIL_ENV`，不得登记为产品缺陷。

## 6. 建议的测试编写门禁

以后每个当前 Sprint 的验收测试在编码前先填写一行追踪记录：

```text
测试 ID | Sprint/Phase | 用户故事 | PRD | interaction rule | GWT | 可观察结果 | 不测内容
```

执行规则：

1. Sprint/Phase 任一来源冲突时停止编写，先登记需求冲突。
2. 当前阶段范围以已确认 sprint-plan 为入口，PRD/user story 决定用户价值，interaction-spec 决定交互细节；实现不能反向定义验收要求。
3. 测试标题写“可交互”时，必须真的执行点击、输入或导航并断言反馈。
4. 静态结构测试标题明确写“源码/结构应包含”，不要冒充 E2E 用户行为。
5. GWT 的每个 `@e2e` 场景由 runner 直接绑定或生成，禁止长期手工双写。
6. 真实沙箱和 Electron 命令串行执行；每个 Electron fixture 隔离 `PROMA_HOME`、`userData`、进程和端口。
7. 产品缺陷必须先证明需求无冲突；否则结果记为需求待确认，不要求开发按任意一份文档修复。
8. 用户在手测中确认的新规则必须同步到 PRD/interaction-spec，再进入 GWT 和测试。

## 7. 待确认事项

| 编号 | 需要产品确认的问题 | 影响测试 |
|---|---|---|
| `REQ-CONFLICT-001` | 有历史项目时自动恢复最后活动项目，还是先显示历史项目列表？ | `S1-STORE-001/002/003` |
| `REQ-CONFLICT-002` | 5 秒时是否立即显示安全说明，还是 10 秒才显示？ | `S1-UI-002/005/009` |
| `REQ-CONFLICT-003` | Sprint 1 是否明确提前实现模式升级；若没有，应恢复为 Phase 3 范围 | `S1-PROJECT-004/005/009` |
| `REQ-CONFLICT-004` | 澄清选项最大数量是 3 还是 4？ | `S1-SKETCH-001/004/007` |
| `REQ-CONFLICT-005` | 工作区是否必须提供“所有项目”入口？interaction-spec 当前回答为“是” | `S1-PROJECT-003/008` |

## 8. 审计结论

原测试不是全部“对应不上要求”。IPC、临时存储、密钥、权限、埋点、沙箱和大部分草图链路具备有效证据，也确实发现了多个真实缺陷。但 Sprint 1 测试设计存在三类需要纠正的问题：

- 把未来阶段能力纳入当前 Sprint；
- 在冲突文档中直接选边，没有先要求产品确认；
- 用源码结构代理真实用户行为，测试标题和证据强度不一致。

因此 `9a7ad4d` 后的“自动测试全通过”只能说明实现符合当前这些断言，不能单独证明实现已经符合所有真实产品要求。应先解决第 7 节的需求冲突，再调整 GWT、测试和实现。

## 9. 本轮可复现执行日志

### 9.1 Electron fixture 修正后的首次执行

```text
命令：npm run test:e2e:sprint1
构建：PASS
执行：8 条，7 PASS，1 FAIL_TEST
失败：S1-SKETCH-009
位置：locator('[data-ai-id="card-option-goal"]').click()
现象：等待旧选项 ID 30 秒后超时；页面实际显示 daily/work/auto 三个合法新选项
分类依据：产品已经进入澄清状态并正确显示标题与灰色说明，失败发生在断言前的过期定位器
```

### 9.2 测试修正

```text
旧契约：必须存在 ID=goal、文案=主要目标
真实要求：点击选项后只提交选项标题，灰色说明仅用于解释
修正：读取实际选项的 label 与 description，点击后断言最后一条用户 JSONL 等于 label 且不含 description
GWT：把固定示例“主要目标”改为“任一澄清选项/所选选项名称”
```

### 9.3 最终有效执行

```text
命令：npm run test:e2e:sprint1
结果：8/8 PASS，1 个 worker，24.3 秒

命令：npm run typecheck
结果：PASS

命令：npm run docs:check
结果：PASS（docs:check passed）

命令：git diff --check
结果：PASS；仅有 LF 将转换为 CRLF 的提示，无空白错误
```

首次失败没有从记录中删除，因为它直接说明了测试为何会与真实要求错位：测试绑定了某次实现的 ID 和示例文案，而不是用户可观察的稳定行为。
