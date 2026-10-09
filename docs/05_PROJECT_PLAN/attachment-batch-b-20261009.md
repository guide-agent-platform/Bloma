# 附件与可靠消息链路：B 批实施结果

日期：2026-10-09。基线：`sprint2 / 3da3f98` 加已有平台修复和 A 批工作树。本批只修改平台，保留既有未提交修复；未提交、推送或修改用户原生成项目。

## 已实现

- 文件选择、拖入和粘贴复用同一受控导入服务。支持图片，以及 UTF-8 TXT、Markdown、CSV、JSON、日志和常见代码文件；8 文件/消息、其中最多 4 图片，文本单文件 1 MiB、图片 5 MiB。
- 导入复制为不可变快照，保存文件名、字节数、内容哈希、编码、行数与归属。非 UTF-8、二进制、PDF/Word/压缩包及超限明确拒绝，失败保留草稿并阻止静默漏材料。
- 文件附件条展示名称/大小，可移除和只读预览。文本/HTML/代码均按文本显示，不执行。预览标明实际行范围与未展示全文状态，允许指定起始行和继续分页。设置往返与重启恢复文件引用和预览；已发送消息保存可回查的材料元数据。
- 授权材料装配到当前消息、会话回访、向导、PRD/需求加厚、桌面调度员和实现子会话。带材料补充整体排队，未派发的材料不进入当前模型上下文；纯材料先询问用途。
- 新 `list_attachments` / `read_attachment` 只读工具按不透明 ID 和本任务授权清单读取，支持行分页、返回预算及 next_line。工程 `read_file` 的项目根约束保持原样；子会话在项目根覆盖下仍可读取同一素材。
- 短文件在预算内完整提供；较大文件提供清单、开头/结尾片段和明确覆盖范围，可继续分页。单行超过 12000 字符时明确报预算错误，不把半行记为已完整读取。保存成功不等于全文进入模型。
- PRD 可带需求级 `source_refs`（ID、SHA-256、起止行）；只接受实际读取过的对应范围，错误哈希/未读范围不作为来源。PRD 文本附来源记录，桌面需求摘要携带来源定位。未产出来源时不机械把所有材料挂到所有需求上。
- 实际读取日志记 `material_read`、reader_session、ID/哈希、行范围及内容。主进程读到材料与供应商实际收到/理解材料是不同事实，读取日志不能代替模型质量验收。

主要模块：`shared/attachment-formats.ts`、`shared/attachment-types.ts`；`main/platform/attachments/composer-store.ts`、`material-context.ts`；`main/agent/tools/attachment-tools.ts`；`agent-loop.ts`、`agent-collaboration.ts`；`guide/pipeline.ts`、`prd-engine-llm.ts`、`requirement-enricher.ts`；`renderer/components/AttachmentPreview.tsx` 与既有 composer。

## 本轮 UI 调整

用户确认修改目标为输入框和聊天气泡：输入区取消独立白底，附件按钮统一为透明标签；助手气泡采用轻透明背景、取消阴影，消息/输入间距收紧。聊天消息入场动画关闭，思考呼吸从 1.6 秒改为 3.2 秒，最低透明度从 0.55 提高为 0.88。实际 Electron 截图已核对，用户表示“可以”；其余面板和弹窗未扩大改动。

样式位于 `renderer/styles/chat.css`、`tokens.css` 及聊天组件。截图：`run-artifacts/batch-b-electron-fixture/materials-history.png`。

## 验证

| 范围 | 结果 / 证据 |
| --- | --- |
| 全量单测 | 216 文件 / 2100 例通过，`run-artifacts/batch-b-unit.log` |
| 最终定向复验 | UI、图片/文件、思考提示及真实子 loop 根覆盖：6 文件 / 25 例通过，`batch-b-final-boundaries.log`。全量后仅做这些相关补验，不声称重新全量执行 |
| 类型 / 构建 | typecheck、renderer/main/preload build 通过；主 bundle `__require(`=0。`batch-b-typecheck.log`、`batch-b-build.log` |
| 集成 | 2 文件 / 8 例通过，`batch-b-integration.log` |
| 本地模型服务 + 真实 Electron | 原生文件选择、只读预览、设置/进程重启、历史元数据、实际 PRD 与子会话工具链均通过；`batch-b-electron-fixture/result.json`、`probe-result.json` |
| DeepSeek 实际渠道 | 用户明确批准本次自建需求 Markdown、虚构账目 CSV 和必要提示词发送至 `api.deepseek.com/anthropic` / `deepseek-flash`。项目 `299d8cff-862a-4762-8738-863422a0882c`、主会话 `1585730d-e178-4ca0-8d73-9602ca8d0915`、子会话 `0720bda5-8027-45a1-bd27-f681797f31b7`（research 只读角色）。真实模型 PRD 包含 `settlement_currency`、拒绝负数与导出保留币种，并记录两文件的有效 ID/哈希/行范围；子会话实际调用 read_attachment 读 CSV 第 2 行得到 `餐费,12.50,CNY`。`batch-b-electron-real/result.json`、`probe-result.json`、隔离 home 的 `bloma-composer/reads/` |

模型测试使用隔离 PROMA_HOME 与 user-data，现有凭据只通过 Electron 内部解密，没有输出或落盘明文 Key。测试最初被自动审批拒绝外发，经用户明确批准后才执行。最初仅复制加密渠道 JSON 导致隔离环境不可解密，补齐对应加密 Local State 后真实测试通过；这是测试环境配置问题，未因此改动生产加密机制。

验证边界：真实渠道验证了“材料 → 向导 → PRD 来源 + 独立委派子会话受控读取”路径，PRD 和子会话探针使用实际平台模块。没有跑完整 PRD 内审/UX/实现/交付新单，也不证明全部供应商或所有材料类型的语义质量。根覆盖测试验证实际 AsyncLocalStorage 隔离，不等于另做完整 Git worktree 合并验收。

## 下一步

C 批：历史再引用、fork 与共享引用关系、取消/重启后的恢复执行入口、素材引用清理、输入事件采集和完整端到端验收。A/B 的 needs_recovery 仍仅提示已接收待恢复，不自动重启工程任务。PDF/Word/OCR 后置；原生成项目继续保持原样。
