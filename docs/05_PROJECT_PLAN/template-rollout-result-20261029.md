# 产品模板剩余批次：本机工程交付与待验边界

日期：2026-10-29（Asia/Shanghai）。用户在 `ea6d9f7` 后指令“继续全部完成”。本轮继续 B2–B9 的可执行工程：`65757dc` 已提交记录库/任务后台；其余实现与本记录同一提交。本文是当前接手入口；具体 HEAD 以 `git log` 核对。

**本机模板工程已实施，真实条件未就绪的验收没有标成完成。** 真实供应商/外部账号效果、干净系统验收和真实效率对照仍待条件。本轮未调用付费模型、未 push、未重启用户原有 Bloma 实例，未读取/复制平台渠道 Key 或改写真实账本。用户原生产流程文档两行改动保持未暂存，hash-object 保持 `53c7abb3aef8497d8b0522b8aab806c82b2ec164`。

## 已交付组件

所有入口复用 `prepare_software_capability` / `inspect_software_capabilities`，没有新建插件引擎或额外强制模型阶段。`components` topic 提供简明目录；具体 inspect 返回版本、源码摘要、文件、schema、运行时/依赖和验证入口。准备只认证文件及相应探针，不能签发完整产品 PASS；新增组件探针标注 `module_load_only`。

| 选择器 | 实现与适用范围 | 已验证行为 |
| --- | --- | --- |
| `data-store` | `product_store.cjs`；JSON 最多32MiB/2万记录；稳定对象/实体修订/引用、全库CAS、原子写、备份恢复及显式迁移 | 同名不同ID、陈旧写/悬空引用拒绝、写失败/坏备份/迁移失败保留、恢复前备份及真实子进程重开 |
| `jobs` | `product_jobs.cjs`；单owner、有界并发、进度/检查点、任务取消和显式恢复 | A取消不影响B、旧回调不写新状态、失败后继续、去重、真实杀进程恢复、未知副作用须核对 |
| `http-workflow` | `product_http.cjs`；公开连接、字段映射、分页/游标、HMAC通知、去重/乱序和持久外部写入状态 | 401/429/坏响应、重叠/断页、提交后游标、签名/重复/冲突/旧版本、丢失回执后不重发 |
| `multimodal` | `product_media.cjs`；注入产品自己的AI/OCR/ASR；结果绑定来源摘要与修订、人工校正保留原文 | 真图片字节/换图、晚回复不串来源、取消后无结果、校正/同步前复核原始快照、实际OCR/ASR及重开 |
| `file-io` | `product_files.cjs` / 受监管文档worker；真实快照、预览/提交、逐项失败、可选内容去重、含原始字节的归档 | PDF/DOCX/中文TXT混合坏文件、同名不同内容、预览失败保留、取消、归档摘要/来源读回和实际界面恢复 |
| `query-list` | `product_query.cjs`；小数据内存过滤/排序/分页/稳定选择、过期响应丢弃及逐项批处理 | 空查询计数/页码、查询切换、跨页再排序后只删除原ID、部分失败可见；大数据后端分页由具体产品适配 |
| `workbench` | 可拆分的 Node/Electron 产品组合示例，含设置/连接表单、来源预览、解析、任务、校正、同步、查询和归档界面 | 实际IPC、系统加密Key、连接改名/取消、C1–C3固定场景及原生窗口重开；Webhook仅显式开启的127.0.0.1入口 |
| `distribution` | `product_distribution.cjs`；物理Electron/依赖/资源清单、启动前校验、便携包、外置数据安装/升级/回退、独立离线语音资源打包 | 中文空格路径、移除开发工具PATH、包内解析/真实ASR、缺资源拒绝、升级/回退保留数据、schema不兼容拒绝 |
| `efficiency` | `product_efficiency.cjs`；预登记、不可覆盖样本、身份/费用/人工介入/失败/逐案例记录及证据文件核验 | 重复/缺输入/未知费用/缺证据/失败/身份不符不出提速结论；只有注册任务成对数据可进入人工比较 |

T01连接器设置已随工作台补齐，凭据仅在产品后台用自身OS加密存储，公开连接配置不含明文Key。保存/取消不发服务请求。Key更换先暂存新身份，公开配置CAS失败删除新暂存，旧配置和凭据保留；加密不可用拒绝持久化。当前没有OAuth或用户密钥删除/自动清理界面，旧未引用密文仍保留。

组件只提供可复用行为与最小适配。工作台和设置CSS是示例，嵌入时按已确认设计选择样式，不应无条件把示例全局CSS加载到已有产品。新增选择器不是新的需求capabilities标签，也不替代 CORE_CHECK、确认、费用及正式交付门。

## S01/S02 支撑

产品诊断只记录明确错误code、操作ID、依据摘要和下一步，未知错误保持未知，不输出原始凭据/响应体。后台任务保留来源ID、检查点和外部提交状态；未知写入须先核对。原宿主 diagnostics 增加当前操作及组件验证入口，历史验收仍是 historical/revalidated:false。

改动影响分析补充已登记组件/测试关系、package/alias未解析明细、动态加载/缺失文件、源码摘要及建议命令；没有缓存，也没有自动执行/缩减正式验收。`partial` 不解释为“其余代码无影响”。

## 本机证据与修复边界

原始证据在 Git 忽略的 `run-artifacts/template-rollout-20261029/`，普通Git分发不含这些文件。最终定向检查11文件58项通过，原生工作台19项通过，便携包/升级8项通过；类型、构建、文档检查通过。最终状态/数量见实际报告，不跨复跑相加。源码绑定检查另核对物化文件与保留包一致，不作为新增业务样本。

- `components-final.log`：最终定向检查；`types.log` / `build.log`：类型与构建；`docs.log`：文档检查。
- `workbench-report.json` / `workbench.png`：C1–C3真实产品窗口、两张可见内容不同的图片、真实文件/IPC/本机HTTP/签名字节、原生OCR和离线ASR。视觉回答是受控服务，不能认证真实模型理解质量。报告有物化文件摘要及逐例结果。
- `distribution-report.json` / `portable-product.png`：使用复制后的物理Electron及应用依赖启动，清除Node/npm/Python开发PATH和外部语音变量；包内Python/模型完成真实WAV转写；升级/回退/不兼容schema与缺资源反例。报告记录实际包摘要与保留位置。
- `source-match.json`：当前模板源码与原生报告/实际物理包摘要一致；复验脚本为 `scripts/verify-template-evidence-source.mjs`。
- `efficiency-protocol-draft.json` / `efficiency-readiness.json`：当前为 waiting_for_real_conditions，不含真实对照结果或提速百分比。

本轮保留的失败与修复包括：并发测试误假定A请求先返回（改按来源ID核对）；原生脚本错误等待不可见option（改核对选中项）；五文件GUI暴露去重键拼接超长导致任务未入队（改稳定摘要，并补真实五文件回归）；首次目录复制异常退出未成报告（原因未确认，改为按冻结清单逐文件复制/校验再切换）；可见界面复核清理默认内部JSON/散列溢出，并补排序保留选择ID与同步前再次检查源快照。失败报告没有算成成功样本，修复后在最终代码上复验。

固定需求在 `65757dc` 的[实施与验收条件](template-rollout-execution-20261029.md)中已先冻结；[场景JSON](template-scenarios-20261029.json)是对应原文与案例索引，不在失败后降低需求。本机脚本由工程方执行，不能据此宣称跨模型可靠性或生成提速。

本机保留的可运行包：`run-artifacts/template-rollout-20261029/portable-product-cb6a9e0b7a91/Launch.cmd`，包ID为`cb6a9e0b7a91`前缀（完整值见distribution-report.json）。它包含物理Electron、文档依赖和独立离线音频资源，默认AI路由仍为空，不包含测试账号/Key/业务数据。该目录不随Git分发；可用脚本从工程重新构建。

## 运行与复验

准备 `workbench` 后，在产品自己的Node/Electron工程安装/准备实际依赖并运行 `electron product_workbench_electron.cjs`；资料目录用产品自己的 `APP_DATA_DIR`。文档解析依赖可先走既有 `documents` 准备。音频须有本产品显式配置的离线资源，缺失会显示未准备并拒绝转写，不自动从宿主默认缓存下载或借用平台渠道。

本机原生复验脚本：

```powershell
node scripts/verify-product-workbench.mjs
node scripts/verify-product-distribution.mjs
node scripts/prepare-template-efficiency.mjs
```

这些脚本要求已有真实Windows OCR、可用Electron/Playwright浏览器、本机npm离线缓存及已校验的SenseVoice模型三件；ASR测试解释器位置为 `run-artifacts/template-rollout-20261029/asr-runtime/Scripts/python.exe`。本次准备命令是 `python -m venv --system-site-packages .../asr-runtime`，再安装 `sherpa-onnx==1.13.8`；实际复用NumPy 2.4.4。分发适配把Python 3.13.7、实际NumPy/Sherpa依赖、标准库和校验模型复制成独立资源，并用自身 `_pth` 验证前缀，不把测试venv路径作为包的依赖。新机器需准备自己的资源并重新验证，不能从本记录推导资源已存在。

`distribution` 后台提供 `buildSpeechResources` → `buildDistribution` → `verifyDistribution` → `installDistribution` / `rollbackDistribution`。物理 `.asar` 按原文件处理；安装/升级数据目录必须外置。每次启动先验证完整清单；不同数据schema拒绝直接升级，需用T04显式迁移/恢复流程。安装/卸载目录可删除版本文件，但外部数据必须由用户另行决定，模板不自动删除资料。

任务handler必须合作响应取消；中断后不会接管旧PID。异常退出残留owner锁时，只允许显式恢复且确认旧PID不存在，活动/未知owner拒绝。工作台缺资源或数据被占用时不应通过删除锁、重置计量或伪造成功绕过。

## 仍需真实条件的验收

| 项目 | 已交付 | 尚缺条件/结论 |
| --- | --- | --- |
| B7/L4 | 受控线协议与真实输入、业务反例、可配置真实服务入口 | 用户指定的模型/路由、产品Key、外部账号/写入范围及完整预算；真实视觉/业务质量未验 |
| B8/L5 | 含离线音频资源的实际便携包、同机清除开发环境PATH后启动/升级/回退 | 当前未提供Windows Sandbox或另一干净系统；同机新路径不等于干净机器；公开发布/签名未授权 |
| B9/E02 | 草案生成、严格预登记/记录/证据核对与比较工具 | 模型/渠道/账号/环境/设计/预算条件、成对真实生成与完整费用/失败证据；不出提速或通用可靠性结论 |

本机工程没有因为这些外部条件停在半实现状态；相应真实验证仍明确待办。开始真实测试前必须重新核对当时生效渠道、余额/配额、费率、账本/责任及完整输入预留保护，不能沿用历史预算或本机测试结果。

收尾尝试清理本轮过时便携包副本及一个失败临时目录时，自动审批返回 `blocked by policy`，未提供具体细项；没有继续删除，目录保留。当前可运行包以上述 `cb6a9e0b7a91` 为准，旧副本不代表当前源码。
