# 工具运行链对照上游与本批修复

核对日期：2026-10-12。Bloma 基线 7414ae5；本地 Proma 上游 `bf3e98ca61dd8365eceaef876c0f7473700878a6`。未 fetch，不声称该提交是远端最新版本。按件适配，未整体 rebase。

## 问题与控制边界

近期“工具调用笨”有具体宿主原因：错误参数进入执行器、安装的 import 失败未置 is_error、脚本退出 0 被叫作业务绿、SSE 心跳绕过空闲超时、收到结束标记仍等 EOF、工具内部预算与 loop 收口状态脱节，以及架构任务缺少平台已验组件信息。

上游 Agent 运行时通过 SDK/Pi 适配、主进程能力桥和权限校验组织工具执行。Bloma 采用自己的 loop 和受控领域工具；搬入上游聊天 SSE 构件不等同于搬入完整 Agent runtime。领域验收、PRD 映射、无 shell 工具与当前渠道传输仍需本地适配，不能直接复制上游的工具名或等待预算。

## 对照来源与适配

| 主题 | 上游源码与事实 | Bloma 本批处理 |
|---|---|---|
| 执行前参数校验 | `apps/electron/src/main/lib/agent-tool-input-validator.ts`，`agent-orchestrator.ts:1290`：SDK 工具必填参数在 canUseTool 前拒绝，返回具体缺失名 | 新增 `main/agent/loop/tool-input-validation.ts`，依据实际 input_schema 校验 required/type/enum/数组元素；不复制上游 Write/Edit/Bash 名称映射。空文件内容允许，工具自己的语义校验保持负责 |
| 工具错误回传 | `apps/electron/src/main/lib/chat-tool-executor.ts`：isError 保留至结果与事件；协作工具返回结果状态并强调 running/timeout 未收敛 | 安装后任一 import 失败置 isError 并带 stderr；脚本按进程退出和场景锚点分别报告，exit 0 不覆盖 FAIL/BLOCKED，也不将无锚点称业务通过 |
| 预算与完成 | `apps/electron/src/main/lib/agent-collaboration-tools.ts` 的 wait 描述与结构化摘要：仍 running/timeout 不能宣称完成 | 安装/脚本工具内部预算耗尽返回 budgetExhausted，接现有 loop 防空转收口。没有照搬上游 3600s wait 默认，也未宣称项目总修复预算已统一 |
| 取消与故障预算 | `apps/electron/src/utility/agent-runtime-request-timeout.ts`：普通能力桥 120s，用户交互才单独延长 | 保持分层超时；新增 SSE 无有效进度 120s（文字/推理/工具参数增长重置，心跳不重置），不是限制整项生成总时长 |
| SSE 结束 | `packages/core/src/providers/sse-reader.ts` 同样忽略 [DONE] 并等 EOF；该上游版本没有现成修复可搬 | 本地已复现后补强：message_stop 与 [DONE] 终结读取、取消底层流；message_delta 的 stop_reason 与最后 usage 保留，工具结果及时交回 SDK query |

## 接线与运行证据

- 参数校验接在 `executeToolCall` 的权限/预算/工具执行之前。非法参数返回 is_error；有效重试仍保有工具调用预算；不执行副作用。
- SSE 保留首事件前有限重试和已有事件后不自动重发的边界。进度超时不限制持续正常的长输出；模型任务总时长不新增硬截止。请求头等待 timer 在成功/失败均释放。
- `child-exec-tool` 的 verification_status 分别为 pass/fail/blocked/not_reported。任意 stdout 中“错误”词不会被正则误判为失败，只识别已有场景锚点；没有锚点必须读实际输出，不能把 ZIP_FAIL 当业务通过。
- `install-packages-tool` 的 imports_verified 表示环境实际 import 可用。安装 pip 成功仍可能 import 失败，报告不合并这两种状态。
- 桌面架构主/子任务均装配组件事实：优先评估已验 speech_runtime/speech_locator，说明缓存寻址、替代引擎理由和下载预算、固定输入证据范围。任务书给出查验入口，不假定每个运行环境的缓存已就绪。
- 固定 WAV 测试适配器标记 `bloma_input_evidence_source=fixed_wav_not_physical_microphone`，恢复 Loader 的 get_code/get_filename；不解除硬件输入保护。既有六案例及老 venv 的测试记录不反向改写。

首轮相关 8 文件/160 例通过；随后补充实际 SDK query 开放连接工具交回测试、Python Loader 测试及最终验证，结果以下方最终记录为准。各组重叠，不累加成新测试总数。证据位于 `run-artifacts/upstream-tool-shape-*.log`。

## 仍需验证与后续范围

本批验证依赖确定性模型替身、本地 SSE 故障流、真实临时项目文件及实际 Python Loader；没有新烧付费额度，未重新跑六个完整生成任务。它证明调用链对这些边界正确，不证明模型行为已全面改善，也未测得端到端提速百分比。

仍需按账本推进：项目总修复/下载额度跨续接统一、工具输出和测试来源的统一结构、任务拆分与接口契约、具体 GUI 测试就绪条件，以及组件缓存的工具化发现。产物模块拆分属于另一批；本次未改变已生成程序。

## 最终验证

本次执行：全量单测 243 文件 / 2258 项通过；集成 2 文件 / 8 项通过；类型检查及开发构建通过。最后针对性 3 文件 / 24 项通过，包含实际 SDK query 在网络连接保持开放时回传工具与 usage；Python 资产 7 项通过。各针对性结果与全量有重叠，不累加。

证据：`upstream-tool-shape-unit.log`、`upstream-tool-shape-integration.log`、`upstream-tool-shape-typecheck.log`、`upstream-tool-shape-build.log`、`upstream-tool-shape-final-targeted.log`、`upstream-tool-shape-python.log`。源码修复已进入开发构建；没有重启用户现有实例，没有新增安装包或付费生成验证。
