# Bloma 学习助手会话评估（2026-10-28）

## 结论与范围

本轮已生成可启动、可操作的学习助手基础版本，但尚未达到可靠交付：独立复查发现 8 项产物缺陷，其中 3 项涉及数据丢失或保存可信性；平台还存在环境准备、启动诊断、冻结测试恢复及停滞判定方面的不足。不能将“有界面”或测试文件覆盖 12 个需求编号当作业务已通过。

- 平台源码基线：`3e4d988`；本次未修改平台或生成程序源码、真实业务数据、冻结规则、用量账本，也未恢复制作或发起付费模型请求。
- 项目：`72c441ad-3bec-48a6-b35f-faca6393068f`，桌面端 AI 学习助手，longterm。
- 会话：`8a7d17cc-dab6-41fe-8d59-c33fcb93e76b`；operation：`a31c8a82-fad6-415b-85a2-45e1b3e99a6f`。
- 原工程：`C:/Users/17359/.proma/agent-workspaces/default-software-builder/generated-projects/72c441ad-3bec-48a6-b35f-faca6393068f`。下文产物源码路径相对此目录。
- 证据：`run-artifacts/learning-assistant-review-20261028/`，含可重跑的 `review.cjs`、`supplement.cjs`、`results.json`、`supplement-results.json`、`source-manifest.json`、`host-summary.json`、`notes-after-switch.png`。
- 方法：读取原工程源码；模块/API 探针使用隔离 APP_DATA_DIR；用原项目 Electron 二进制和正常应用入口操作真实窗口；AI 协议检查只连接本机临时 HTTP 替身。读写失败使用受控故障注入，并非填满物理磁盘。
- 前后源文件哈希一致；测试实例已关闭。用户原有 `docs/05_PROJECT_PLAN/production-workflow-v2-20261020.md` 改动保持原样。

## 已完成且本次验证到的部分

1. TXT 导入、内容搜索、创建多条笔记的 API 主路径成功。
2. 最小 DOCX/PDF 文本样例能够解析；这不证明复杂排版、中文公式、扫描 PDF 或完整阅读体验通过。
3. 原始 Electron 正常入口可显示真实笔记界面；此次 UI 探针没有捕获 pageerror，截图已人工检查。
4. 停留在同一笔记，等待自动保存后内容确实写入磁盘；Electron 关闭后，另一 Node 进程重新读取仍见该内容。
5. 这些是本地抽查与正向对照，不是整套正式验收。没有重跑全部 12 项原生测试，也没有验证真实模型讲解质量、完整解题正确性、正式发布包或干净机器安装。

## 产物缺陷（已复现）

| 编号 / 优先级 | 缺陷及实际影响 | 证据与源码 |
| --- | --- | --- |
| P-01 / P1 | 编辑笔记 A 后在 550ms 内切到 B，A 的新内容丢失。延迟保存读取的是届时的当前笔记与 DOM，而没有捕获 A 的编辑快照或在切换前保存。 | `ui-autosave-navigation`：A 仍为 `original A`；停留后保存 B 的正向对照成功。`public/js/app.js:48-79,524`。 |
| P-02 / P1 | 写文件或 rename 失败仍 resolve，调用方认为保存成功；内存保留新内容，磁盘仍是旧内容，重启丢失。 | `write-and-rename-errors`：注入 ENOSPC/EACCES，两次均 resolve，磁盘未变。`server/store.cjs:70-79`；各写 API 依赖 persist 的返回结果。 |
| P-03 / P1 | 数据库 JSON 损坏被静默当作空库，下一次保存覆盖原损坏字节，没有备份或阻断。会将可恢复的数据故障变成数据丢失。 | `corrupt-store-overwrite`：加载后 notes=0，后续保存替换原文件，无备份。`server/store.cjs:54-64`。 |
| P-04 / P2 | 端口冲突回退仍无效：`start(0)` 想请求随机端口，`port || 4318` 却将 0 转回默认端口；设置 PORT 时回退也继续优先同一 PORT。 | `ephemeral-port-fallback` 拦截真实 listen 参数，requested=0、actual=4318，未占用用户固定端口。`server/index.cjs:401`、`electron/main.cjs` 的 EADDRINUSE 分支。 |
| P-05 / P2 | 文档归档允许“课程 A + 课程 B 的章节”，制造分类结构不一致；校验只确认两个 ID 各自存在，没有确认从属关系。 | `cross-course-chapter-consistency`：错误组合返回 HTTP 200。`server/index.cjs:204-206`。 |
| P-06 / P2 | AI 返回无引用内容时，仍按成功答案保存，不能兑现“基于资料讲解并附引用跳转”的承诺。只在提示词中要求引用不足以保证结果。 | `ai-success-without-citations`：本地替身返回无引用文本，ok=true、refs=0。`server/ai.cjs:87-97`。需区分资料不足的明确降级，不能伪造引用。 |
| P-07 / P2 | AI 超时只覆盖收到响应头之前，读取响应正文前已清除计时器；服务端先发响应头、正文停滞时，超时不再生效。 | `ai-body-timeout`：设置 100ms，延迟约 700ms 才返回正文，约 714ms 后仍成功。`src/llm-client.cjs:57-87`。 |
| P-08 / P2 | 非 Word 字节只要命名为 .docx，也会被解析为一页“未提取到文字”并视为成功，掩盖格式损坏。 | `corrupt-docx`：输入 `not a ZIP or Word file` 被接受。`server/parsers.cjs:107-129`。应区分合法空文档与解析失败。 |

说明：上述八项分别验证不同边界，不是八项正式验收失败统计或成功率估计。P-05 是 API 约束缺陷，未声称所有 UI 路径都能产生该错误组合；P-06/P-07 使用本地替身，没有调用或评价真实供应商。

## 平台流程缺陷与机制问题

### H-01：准备环境耗时没有形成有效恢复

会话 14:46:03 开始，npm install 及后续 Electron 安装共出现三次 300 秒超时，直到约 15:02 改用镜像后台安装。应把依赖安装状态、下载进度和 Electron 二进制就绪分开记录；已有 npm 缓存不能替代 Electron 二进制的独立校验。对相同原因限制重试，采用配置化可信来源及完整性校验，不让模型临时猜镜像或反复消耗主执行时间。

### H-02：普通命令与 GUI 入口解析不一致，错误提示误导

`main/software/command-runtime.ts` 支持 npm/npx 命令解析，而 `main/software/gui-observer.ts:18-28` 对 `npx electron .` 按 root 下的 npx 文件解析，返回 ELECTRON_EXECUTABLE_MISSING。当时 Electron 二进制实际已存在。应明确区分不支持的包装命令与缺失运行时，并给出可执行的入口修正；不能随意执行或推断复杂 npm 脚本。

### H-03：等待窗口超时丢失根因

`debug-sessions.ts:139` 在 CDP 已连通后仅等待 page 15 秒；失败时主要返回 TimeoutError。此前单独后端占用 4318，随后 Electron 仍尝试启动后端，结合代码和恢复记录符合端口冲突，但返回没有直接说明。需要联合进程退出、stderr、后端就绪和窗口事件提供分阶段诊断。不能把增加等待时长当作对端口冲突的修复。

### H-04：冻结测试先于安全检查，恢复规则和反馈不足

`verification-tool.ts:22` 先登记冻结测试；`verification.ts:115` 随后因安全静态检查返回 failed，未进入 core/GUI 执行。`canRepairUnexecutedNativePlan` 只接纳指定 GUI 零断言/启动失败证据，该次纯安全失败不满足例外。后续改测试便被拒绝。

比对冻结副本与最终主测试：acceptance.mjs 唯一差异是 12 处 `test(...)` 改为 `await test(...)`，没有降低输入或业务断言；同时冻结清单里的 `tests/tmp/a.docx` 被删除，新增 probe.mjs 也改变了测试目录。`native-gui-tests.ts` 对整个测试目录递归冻结，包括临时文件。因此“冻结预期改变”并不能直接归因为削弱业务需求。

改进应先保证测试引导协议可执行、临时输出与冻结资产分离，再冻结业务契约；对未执行测试的恢复要有证据约束、保留旧版和具体差异。不能放开任意改断言、清空封存或把探针换成验收来过门。

### H-05：安全诊断类别和恢复建议不够具体

第一次正式检查因 9 处 unsafe_dom 静态告警失败，`core=null`。这是安全扫描失败，不是业务 GUI 断言失败，当前反馈却归入 product_assertion，后续通用恢复提示又无法说明冻结差异。安全规则使用正则检测变量 innerHTML 写入，不能据告警数量直接宣称有 9 个可利用漏洞。模型随后改成自制 DOM 白名单，但没有成功的最新安全/完整验收凭据，不能宣称问题已全面修复。

### H-06：进展定义和终止文案会误导

`main/agent/loop/work-progress.ts:13` 将成功 run_command/write_file 计为进展，打印文件或改探针会重置 idle 计数，即使 GUI_EXISTING_EXPECTATIONS_CHANGED 一直存在。应记录同一错误的恢复证据和真实阶段推进，并保留允许合理修改的空间。

15:16:03 因 HARNESS_DEADLINE_EXCEEDED 停止，run-state=cancelled、desktop_blocked=verification-incomplete；日志另有“单次输出上限”提示与 `[terminal] status=completed`。这些文案与真实截止原因、未交付状态容易混淆。应同时呈现执行结束原因、业务验证状态和下一步，而不能让 completed 看似交付完成。

## 建议处理顺序

1. 平台先完善依赖准备、入口预检和启动失败诊断；补足同错重试限制，让模型尽早拿到可操作根因。
2. 明确冻结测试前的协议预检、稳定资产边界和有记录的恢复机制，同时改进停滞判定与终止文案；保留费用、完整性和验收门。
3. 产物修复优先处理 P-01/P-02/P-03，再修端口、分类、损坏输入和 AI 协议边界；新增独立负例，不能只重跑原模型编写的正向脚本。
4. 保留当前失败样本与账本。未经后续明确指令，本评估不修改真实产物或启动续跑；完整业务验收和真实 AI 效果继续标记未验证。

## 复核命令与证据边界

在本仓库执行 `node run-artifacts/learning-assistant-review-20261028/review.cjs`、`node run-artifacts/learning-assistant-review-20261028/supplement.cjs`。脚本使用固定本机工程路径和本地依赖，证据目录默认被 Git 忽略，不保证另一台机器直接复现。重跑会覆盖本评估自己的隔离数据与结果，不改变原始工程；需要保留独立批次时先复制证据目录并修改输出位置。

此次仅执行一次主探针；补充脚本执行两次，第二次只新增记录宿主摘要。未叠加计数或声称多次独立完整验收。未运行全库单测/构建，因为本轮没有平台源码改动；报告为审查产出。
