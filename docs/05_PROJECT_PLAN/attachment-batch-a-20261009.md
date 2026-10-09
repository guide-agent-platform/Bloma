# 附件与可靠消息链路：A 批实施结果

日期：2026-10-09。平台基线：`sprint2 / 3da3f98` 加现有未提交修复。本批只改 Bloma 平台，未修改用户生成项目，未提交或推送。

## 结果

- 先保存原有 28 文件的差异、快照和 SHA-256：`run-artifacts/batch-a-baseline/`。25 文件逐字节保留；agent-loop、desktop-route、dispatcher-loop 三文件在原修复上增加图片/消息身份接线，逐项比较未撤销原修复。
- 图片通过受控导入服务复制为不可变快照，记录归属、媒体类型、大小与内容哈希；草稿和发送记录只存短引用。PNG/JPEG/GIF/WebP，最多 4 张、单张 5 MiB。旧 pasted-image 记录继续可读。
- 按项目/会话保存文字和图片引用。设置页往返、会话切换、重启后恢复草稿与图片预览；异步导入完成后写回原草稿。首条消息发送前也登记草稿会话，使重启能够找到同一草稿。
- 新聊天 IPC `chat:submit` 先落持久接收记录再派发，回执独立于模型完成。确认卡继续走原 `agent:send-message`。
- `client_message_id` 为稳定消息身份，响应丢失后重试复用该身份；重复接收不重复派发或写用户消息。同内容的新消息仍有独立身份。
- 接收失败保留草稿和发送快照；确认仅清理已提交引用及对应草稿版本，等待期间的新输入保留。导入失败阻止静默漏图，用户可明确移除失败项后继续。
- 纯图片允许发送，先询问材料用途。带文字图片传入向导/桌面调度员 loop；图片调用异常向上报告，不回退纯文字需求路由。
- 纯文字保留 steer，带图补充整体排队。补齐跨会话项目锁释放后的派发与项目停止时的队列取消。排队正文在执行前不落用户对话；接收记录和材料独立持久化。
- 排队、执行失败、取消和重启待恢复有明确提示。重启不会自动恢复运行中的工程任务。

## 接线

契约：`shared/attachment-types.ts`，经 `shared/types.ts` 导出。平台存储：`main/platform/attachments/composer-store.ts`、`send-inbox.ts`。接收入口：`main/ipc/composer.ts`、`main/orchestration/stages/chat-submit.ts`。输入组件：`renderer/components/MessageComposer.tsx`、`renderer/hooks/use-composer.ts`、`renderer/composer-state.ts`；状态回访：`MessageReceipts.tsx`。

受控数据位于 `${PROMA_HOME}/bloma-composer/{attachments,drafts,inbox}`。新图片复用已有视觉水合协议，文件位于 `pasted-images/material-<id>/`，生命周期不随原聊天会话目录删除。首版采取保守保留策略，引用回收属 C 批。

## 验证与证据

| 范围 | 结果 / 证据 |
| --- | --- |
| 基线核对 | 原 28 文件快照与哈希；25 字节不变，3 文件增量审阅。`run-artifacts/batch-a-baseline/preservation-review.json` |
| 全量单测 | 213 文件 / 2087 例通过，`run-artifacts/batch-a-unit-final.log`；之后补 1 草稿 revision 例并在 10 文件 / 58 例定向复验，`batch-a-boundary-final.log`。当前共 2088 例，未把两次执行写成单次全量 2088 |
| TypeScript / 构建 | typecheck 通过；renderer/main/preload 构建通过，主 bundle 动态 `__require(` 为 0。`batch-a-typecheck.log`、`batch-a-build.log` |
| 集成 | 2 文件 / 8 例通过，`batch-a-integration.log` |
| 真实 Electron | 隔离 PROMA_HOME，真实 renderer/preload/IPC/文件存储，settings 往返和进程重启恢复图片与文字；纯图发送得到用途提问；46 ms 回执早于本地模拟服务的 2500 ms 响应；重复提交只写一次用户消息并发起一次视觉请求；不支持图片的 400 如实显示执行失败。`run-artifacts/batch-a-electron/result.json`、`restored-draft.png`、`execution-failure.png` |

真实 Electron 的模型端为本地 HTTP/SSE 模拟服务，验证传输和接收语义，不是实际供应商识图质量或完整生成狗粮。最终整理后的补验与构建记录见 `run-artifacts/batch-a-final-checks.log`。

全量首跑曾误扫描基线快照中的测试副本，并遇到两条仍锁定旧缺陷行为的 UI 断言；快照已加 `.snapshot` 后缀，断言已更新为本批授权行为。真实 Electron 首跑发现空正文被公共必填校验拦截，已修为聊天专用内容校验，并补 IPC 回归。

## 下一批

B：普通文件选择/拖入、UTF-8 解析与预览、受控分页读取、向导/PRD/实现子会话的材料上下文和来源追溯。C：历史再引用、fork、恢复执行与引用清理、事件采集和完整端到端验收。

A 的图片闭环不等于整个附件规划完成。普通文件、主子会话资料读取与科研数据指标仍未实现；重启后的已接收任务显示待恢复，恢复执行入口留给 C 批。已有生成项目保持原样，完整真实模型到 PRD/实现狗粮仍待 B/C 验收。
