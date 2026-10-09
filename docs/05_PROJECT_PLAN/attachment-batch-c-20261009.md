# 附件与可靠消息链路：C 批实施结果

日期：2026-10-09。基线 `sprint2 / 3da3f98` 加原有平台修复和 A/B 工作树。本批只修改平台；生成程序使用隔离测试 home，未改用户原有生成项目。未提交或推送。

## 已实现

- 历史消息可预览图片/文本，并添加到当前草稿；输入区提供历史材料入口。同名再次导入保留新 ID/哈希，列表用哈希区分版本。原文件改动或删除不影响材料快照。
- fork 只共享分叉点以前的材料引用和读取授权，不复制整个附件目录。原历史删除后，新会话继续读取同一 ID/哈希。旧 pasted-image 在 fork 时按需快照，原历史与字节不变，避免原会话图片清理破坏分叉。
- 重启只展示接收记录和是否可能部分执行，不自动恢复工程任务。用户选择“继续执行 / 不再执行”；失败可重试，排队消息可撤回。
- 恢复复用 client_message_id；operation_id 对恢复回执丢失后的重试去重。生命周期分配 run_generation，旧运行终态与迟到流事件不能覆盖新运行。恢复时不重复写用户消息，也不把同一身份再拼进模型历史。
- 已接收回执恢复后，草稿只清理相应发送快照与已提交引用；等待期间的新输入保留。不同身份的同文消息、同文但不同附件版本的消息均保留。
- 24 小时保护期后，只回收确定不被保留草稿、接收记录或历史引用的素材；引用记录损坏即跳过回收。fork 引用保持保护，不为省空间立即删除移除项。
- 收集 attachment_imported、parse_failed、message_accepted、material_read、attachment_reuse/fork、message_resumed/cancelled 和回收事件；事件中不写材料正文。实际读取日志与“供应商理解”仍分开解释。

## 上游参考与适配

本地参考仓库 `C:\Users\17359\OneDrive\Desktop\proma-upstream`，核对 HEAD `bf3e98c`（2026-09-17）；未把它称为联网核对的最新上游，也未整体合并。

| 来源 | 吸收/适配 |
| --- | --- |
| `apps/electron/src/main/lib/agent-queue-coordinator.ts` | 当前 dispatch 身份去重；主进程持有队列与恢复投影；生命周期 reserveRunGeneration。Bloma 在既有队列上补持久接收和显式恢复，不依赖 renderer 挂载消费 |
| `apps/electron/src/main/lib/agent-session-manager.ts` 的 branchBindings | fork 只保留锚点以前的映射。Bloma 使用 JSONL 前缀与不可变材料授权，不引入 Pi artifact 格式 |
| `apps/electron/src/main/lib/attachment-service.ts`、`agent-fork-workspace-copy.ts` | 参考 UUID 存储、受控路径与 fork 资源处理；上游复制工作区，Bloma 按本规划共享不可变引用，旧图按需快照，不照搬整目录复制/删除 |
| renderer `rich-text-input.tsx` 的 draftScopeKey 与 `input-draft-echo.ts` | 异步结果绑定发起时的草稿作用域，避免旧回执覆盖新输入。Bloma 保留既有 revision 保护，补恢复确认与历史再引用 |

上述为按模块吸收；六层依赖、工程 read_file 沙箱和 Bloma 的确认门保留。新素材存储仍用原子临时文件 + rename，参考上游本地 JSON/JSONL 原则。

## 狗粮暴露并修复的平台问题

1. **Python 启动没有统一虚拟环境**：依赖在项目 `.venv`，冒烟/启动按钮/纠错实例却执行裸系统 Python。现在三处复用已有 `resolveDriverVenvCommand`；显式指定解释器时保持原样。
2. **实现子会话预算不匹配**：桌面父会话 40 轮，原先所有子会话统一 12 轮；本次首个实现者前 9 轮读资料、第 10 轮才写代码。现在桌面 implement/custom 为 24，research 等保持原缺省 12，仍受父上限约束；补执行预算/收尾提示。`loop_status` 单独回传并持久化，轮次耗尽显示“待续跑”，普通 completed 生命周期标签改为“已结束”。不宣称已完成统计学意义的成本/成功率改善。
3. **需求输入混入技术约束**：首轮测试把技术栈和锚点写进用户需求，已按用户意见纠正。后续需求只描述场景、功能和边界，技术栈与验证协议由平台内部提供。
4. **测试环境长路径和误选目录**：首轮测试 home 嵌在长工作区路径，CFFI 原生 DLL 导入失败，被 pywebview 回退错误包装为缺 coreclr。.NET 在短路径同依赖下实测正常，未安装/修改系统运行时。后续测试 home 改短临时路径。一度按目录时间误选旧失败测试续跑，此操作错误已向用户说明并结束相关实例；之后强制显式项目 ID + home + 根目录核对。失败证据原样保留。

## 最终验证

| 范围 | 结果与证据 |
| --- | --- |
| 全量单测 | 221 文件 / 2119 例通过，`run-artifacts/batch-c-unit-final.log` |
| 类型、构建、集成 | typecheck、renderer/main/preload build 通过，主 bundle `__require(`=0；集成 2 文件 / 8 例通过。`batch-c-typecheck.log`、`batch-c-build.log`、`batch-c-integration.log` |
| C 生命周期真实 Electron | 重启无自动派发、显式恢复仅一次、新草稿保留、历史再引用、删除原历史后 fork 仍读、撤回未执行、输入事件有实证，最终 `batch-c-electron-lifecycle-final.log` 与 `batch-c-electron-latest.json` |
| 根覆盖、配额、事件代次 | C 定向/回归：引用与旧图、保守回收、同文身份、迟到事件、12/24 轮执行差异、启动解释器等通过；记录在 `batch-c-*.log`。不以单测代替完整 Git worktree 合并验收 |
| 真实 DeepSeek 全链 | 固定项目 `c43e2f7e-6e4f-4f47-bf0b-181556587c00`；home `C:\Users\17359\AppData\Local\Temp\blc-rNL1Bk`。附件 → 向导/需求确认 → PRD 内审/确认 → UX 确认 → quick 实现/续跑 → 启动冒烟 → completed/completed、desktop_phase=delivered。最终正确目标续跑耗时约 176 秒，不把它当成从零 Time-to-MVP。`batch-c-dogfood-latest.json`、`batch-c-dogfood-verified.log`、`batch-c-verified-target.json` |
| 最终产物独立 GUI | 在独立 APP_DATA_DIR：真实 WebView2 启动，样例两条与币种正确；实际填写/保存使 DOM 与磁盘变化；负数拒绝且磁盘不变；导出 CSV 保留 settlement_currency/USD；重启保留新增记录。`batch-c-independent-gui-final.log`、`batch-c-gui-latest.json`。平台冒烟截图在该项目 `00_VERIFY/screenshots/LAUNCH.png` |

最终 PRD 10 项需求保留 source_refs；输入事件中有 38 次 material_read、13 个读取会话。首版 A/B/C 输入与材料链路完成相应验证；科研统计管道、所有模型/材料类型以及 longterm 的 MVP/交付后点选全链未在本轮全面验收。PDF/Word/OCR 后置。

首轮失败项目 `83ba85a3-1225-454e-ae5d-7b2d6f24f7f7` 和误选续跑没有改成成功；第二轮短路径项目曾受 12 轮预算阻塞，最后在修正平台和固定目标后完成。生成者 DELIVERY 对其自身 GUI 验证范围仍应单独阅读，独立验收事实以上述报告为准。
