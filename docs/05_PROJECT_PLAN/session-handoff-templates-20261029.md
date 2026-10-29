# 会话交接：能力组件、通用AI服务与模板计划

日期：2026-10-29（Asia/Shanghai）。这是当前会话的接手入口；历史Harness交接和旧记忆只作为导航/证据，不替代当前源码及下表状态。

## 1. 接手时先确认这些事实

| 项目 | 当前核对结果 |
| --- | --- |
| 仓库 | `C:\Users\17359\OneDrive\Desktop\guide-agent-platform-sprint0` |
| 分支 | `sprint2` |
| 交接编写前HEAD | `0b6728d8e12db1d388b4e04ad045d769d0ae49e0`，仅增加完整计划文档 |
| 最新工程基线 | `531fda1`；其后计划及本交接均为文档改动 |
| 当前工作阶段 | 能力组件与AI后台已实现；完整产品模板计划已写好；**尚未开始B0/B1后续实施** |
| 用户最新要求 | “准备一下会话交接”。本轮仅整理交接、检查文档、本地提交，不继续实现或开新测试单 |
| 推送/付费 | 本会话未push；能力扩展与验证未新增付费模型请求。未来真实测试需重新核对当时路由、费率、余额/配额、累计责任和明确预算 |
| 唯一原有工作区改动 | `docs/05_PROJECT_PLAN/production-workflow-v2-20261020.md` 的原用户两行添加，保持未暂存；不要纳入本批、还原或覆盖 |
| 原用户文件保护核对 | 交接文档整理前后 `git hash-object` 均为 `53c7abb3aef8497d8b0522b8aab806c82b2ec164` |
| 运行中的Bloma | 本会话未代用户重启。磁盘构建不证明现有进程已加载新代码，使用新工具说明前需正常重启核对 |

交接本身会再生成一个文档提交，因此接手时用 `git log -1` 获取当时HEAD；不要把上面的交接前HEAD当作固定不变值。持久记忆仍可能出现 `9206cda` 等历史基线，应按当前Git、总计划与本交接核对。此轮不回写记忆，不宣称Proma/Codex记忆已经同步。

## 2. 用户已确定的方向

1. 目标是提高Bloma的实际生成能力和效率，优先复用成熟组件、改善故障诊断和开发期选测。
2. 能力优先级为**模型多模态与外部系统集成**；外部集成首批明确选择**通用HTTP API／Webhook**。
3. 用户指出当前制作模型已有视觉能力。优先利用已有附件/看图/开发截图链路，OCR保留为本机文字提取，不把OCR包装成完整图片理解。
4. 用户认可通用AI服务模板：Agent填写公开协议、地址、模型及业务调用；真实Key由生成产品的用户设置/自有密钥存储在运行时提供，不复制Bloma渠道Key或写进模板。
5. 模板应可组合并适配已确认设计，不强制套整页界面；组件目录不自动扩大产品需求。
6. 用户最后明确“先落实完整的计划表”，随后要求交接。下一轮实施入口已规划，但**交接请求本身不等于启动B0/B1、真实账号操作、付费测试或推送**。

## 3. 已完成提交与证据入口

以下测试结果来自各提交的实施记录，不是本次交接重新执行，也不能跨批累加为一次全仓通过或模型成功率。

| 提交 | 已完成内容 | 对应验证范围/限制 | 记录 |
| --- | --- | --- | --- |
| `a02524a` | 产品文档解析/字面检索/精确引用、六类反例参考、导入工程差异；修复Node依赖快照丢失node_modules查找层 | 9文件55项相关检查；真实解析/候选CLI及浏览器/重开；无真实生成率结论 | [第一轮能力扩展](capability-expansion-20261029.md) |
| `a0f4f8d` | Windows本机OCR、JSON HTTP客户端、HMAC Webhook与持久收件箱 | 8文件57项；真实OCR及本地受控API组合；实际有OCR错字；无真实账号/OAuth/公网托管结论 | [多模态与HTTP首批](multimodal-http-first-20261029.md) |
| `ac2b62e` | 按所属会话读取工程外调试截图、视觉请求链路验证、产品视觉客户端及换图探针 | 11文件65项；两种兼容线协议、真实图片字节、Pi续跑；回复为受控文本，不证明视觉理解质量 | [视觉链路完善](vision-workflow-20261029.md) |
| `531fda1` | 通用AIService、可编辑公开路由、Key适配、诊断汇总、静态关联测试候选 | 10文件40项；两协议×文本/图片、本机探针、设置CAS及测试AES-GCM codec；真实OS keyring及完整产品设置UI尚未验 | [AI服务与效率支持](ai-service-efficiency-20261029.md) |
| `0b6728d` | 8类产品模板、13项工作、7里程碑、3场景的完整总计划 | 文档/本地链接检查；未实施后续模板，未重跑产品测试 | [完整计划表](product-template-roadmap-20261029.md) |

其中的错误、修正和复跑范围详见对应记录。不要只摘取最后一次绿色结果推导一轮自主成功或速度收益。

本机原始证据位于被Git忽略的目录：

- `run-artifacts/capability-expansion-20261029-*.log` 及 `capability-expansion-20261029-ui/`；首次文档扩展日志是带该前缀的文件，非同名日志目录。
- `run-artifacts/multimodal-http-20261029/`：`closure.log`、`workflow.json`、`real-ocr.json`、`prototype-ocr.json`。
- `run-artifacts/vision-workflow-20261029/`：`closure.log`、`wire-recheck.log`、类型/构建/索引日志。
- `run-artifacts/ai-service-efficiency-20261029/`：`closure.log`、`types-last.log`、`build-last.log`、`docs.log`、`source-verify.log`。
- `run-artifacts/capability-quick-try-20261029/report.json`：独立新输入的小试用，真实准备/安装、PDF/DOCX/中文TXT、引用拒绝和进程重开，浏览器14条操作/检查通过；固定手写样例，非模型从零生成。

这些原始文件通常不随普通Git提交分发。换机器后缺文件应注明不可取得，不补造证据。临时测试工程可能已按测试清理逻辑删除；保留报告不代表对应进程仍存在。本次交接不重新检查用户正在运行的实例。

## 4. 已有代码接线地图

| 用途 | 实际入口 | 关键边界 |
| --- | --- | --- |
| 组件发现/准备 | `main/software/capability-tools.ts`、`integration-capabilities.ts`、`context-catalog.ts` | 选择器已有speech/documents/ocr/http/ai/vision；准备不等于业务PASS；已存在代码冲突不静默覆盖 |
| 通用AI模板 | `main/templates/tools/ai_service.cjs`、`AI_SERVICE.template.json`、`ai_routes.cjs`、`ai_secrets.cjs` | Node、非流式、openai-chat / anthropic-messages；公开配置与Key分开，默认地址/模型为空 |
| AI调用/设置 | `AIService.generate/analyze/settings/saveSettings`；Key通过resolveKey或产品自身APP_*注入 | configured只表示公开路由已填；无可信codec不落盘Key；后台get不向renderer暴露；Bloma不自动透传宿主环境 |
| 旧视觉入口 | `vision_client.cjs` 是AIService薄兼容入口 | 不维护第二份图片HTTP实现；已生成旧产物不自动迁移 |
| 模型协议检查 | `main/desktop/llm-verification.ts`、`main/templates/tools/llm_entry_probe.cjs` | Node可登记protocol和input:vision；文本5请求/6项，视觉6请求/7项；本机HTTP不是供应商实测 |
| 制作模型看图 | `image-tool.ts`、`inspect-tool.ts`、`main/agent/loop/pi-messages.ts` / `pi-transport.ts`、既有图片水合 | 工程图片用path；宿主截图用本会话debug_session_id；旧源码/其他会话拒绝；附图不表示已审阅 |
| 外部系统底座 | `http_connector.cjs`、`webhook_inbox.cjs` | 固定来源/方法、有界JSON/超时/取消；不自动重试写入；pending须核对，非跨系统恰好一次 |
| 文档/OCR/语音 | `document_runtime.cjs`、`ocr_runtime.cjs` / `ocr_worker.ps1`、现有speech桥与资源绑定 | 文本解析/字面检索/OCR/视觉理解分开；OCR有错字，音频文件验证不认证麦克风 |
| 已有工程与影响 | `import-project.ts`、`repository-context.ts`、`change-impact.ts` | 原目录不写回；changes从导入字节比较；impact仅JS/TS静态相对导入候选，partial不裁剪正式检查 |
| 诊断 | `diagnostic-context.ts`，公开topic diagnostics | 当前执行/截图与历史验收分层；历史未重验；未知不强行分类；脱敏、无计量重置 |

Agent说明均在原 `read_production_context` 中，已有topics：components、ai-service、diagnostics、vision、documents、multimodal、http-integration等。它们是内部按需协议；普通产品界面不应堆这些实现名或测试信息。

## 5. 明确尚未完成的工作

- **没有完整产品设置模板UI。** AI后台、公开配置保存和Key adapter已有；T01的实际表单/后台桥/状态体验与真实OS加密适配仍在计划中。
- **没有完整产品业务任务队列模板。** 已有宿主命令监管不能作为T02已完成的依据。
- HTTP/Webhook现为产品后台底座，分页、字段映射、游标提交、业务状态UI和真实厂商专用适配仍待T03。
- 数据存储、文件批处理、多模态产品流程、查询列表与打包模板须按总计划逐项实施；当前局部组件和固定样例不替代完整模板。
- 未做真实供应商视觉质量、真实外部账号/OAuth/公网Webhook、干净机器安装包资格或同任务提速对照。当前不能发布提速百分比或通用可靠性结论。
- 历史学习助手的业务缺陷没有被本轮平台组件自动修复或重新签发PASS，旧实验/旧付费测试也没有因此续跑。

## 6. 下一轮若获指令继续实施，从哪里开始

先读[完整计划表](product-template-roadmap-20261029.md)，按以下顺序推进，不从旧记忆的pending列表直接开工：

1. **B0 / F00**：核对既有AI、HTTP、文档组件的描述、版本/摘要、公开schema、运行时/依赖及验证入口。扩展当前目录和prepare/inspect，不先重建插件或Agent框架；组件已存在，先识别契约缺口。
2. **B1 / T01**：在已有AI后台上实现产品设置的首个可运行UI适配与后台桥；覆盖路由/Key输入、保存/取消、陈旧表单、Key不可回读、加密不可用和真实重开。“已配置”与“已连接/实际效果”分别显示。
3. 后续按 **B2最小数据底座 → B3业务任务 → B4a外部集成 → B4b多模态流程 → B5/B6通用交互 → B7固定场景复核 → B8包与新环境 → B9效率对照**。S01/S02随相关批次完善。

总计划的C1图片记录同步、C2资料归档、C3 API事件跟进场景须先固定独立业务预期，再实现相应样例。真实服务条件未明确时可完成本机工程；真实效果保持待验证，不把本地替身换个名字当真实验收。

最新用户当前只要求交接；不要在完成这份文档后自动执行上述步骤。用户下轮若说“继续B0/B1”，再把相应批次作为实施范围。

## 7. 接手检查与验证建议

```powershell
git status --short
git log -7 --oneline
git diff -- docs/05_PROJECT_PLAN/production-workflow-v2-20261020.md
```

确认原用户改动仍保留，再读取本交接和总计划。本次交接仅运行文档/本地链接/空白检查；没有为了交接重新跑付费生成、构建或整仓测试。

实施B0/B1后按修改选择相关验证；当前可复用的定向起点：

```powershell
npx vitest run tests/unit/software/ai-service.test.ts tests/unit/software/efficiency-context.test.ts tests/unit/software/vision-client.test.ts tests/unit/software/http-connector.test.ts --maxWorkers=2 --minWorkers=1
```

这条命令不替代后续新增UI、实际IPC、可信OS密钥适配和新批次反例的验证；也不证明整个仓库或真实供应商已通过。源码变化后再做对应类型检查/构建和必要原生验证；文档轮只做相关检查。

付费前须核对**当时**生效渠道、余额/配额、费率、已有账本/责任及请求前保护，取得完整预算条件；旧记忆中的金额和额度是历史快照，不能作为本次可用预算。命令策略不是OS沙箱；不搬宿主Junction，不清理或重置真实账本来绕过失败。

## 8. 可复制到下一会话的说明

> 请接手 `C:\Users\17359\OneDrive\Desktop\guide-agent-platform-sprint0` 的Bloma模板工作。先读 `docs/05_PROJECT_PLAN/session-handoff-templates-20261029.md` 和 `product-template-roadmap-20261029.md`，核对git状态。最新工程基线531fda1，计划提交0b6728d，此后交接为文档提交；工作区有用户原有生产流程文档改动，保持不动。当前停在总计划完成、尚未开始B0/B1。用户优先模型多模态和通用HTTP/Webhook，已有AIService/视觉/文档/OCR/HTTP底座及诊断/影响辅助。下一项实施入口是B0组件契约和B1产品设置UI，以用户下一条安排确定本轮范围；不要自动续跑历史项目/实验或付费调用，不push。已有本机测试不等于真实模型、账号效果或提速结论。
