# 05 — IPC 与渲染层

> 覆盖 IPC 四层链路（shared 契约 → ipc handler → preload 桥 → renderer atoms）与关键 UI 组件。
> 是 `00-总索引.md` §6「IPC 四层链路」的完整展开；决策卡回传链路在 §7 深描。
> 图例与锚点约定见 `00-总索引.md` §2。
>
> **锚点基准**：当前工作区（`test/delegation-s4-port` @ `afbfda79`）。委派协作（delegation_*）与
> `tool_call_*` 事件为当前分支可见；标注 `[sprint2]` 的 PRD 审查门回传在 `origin/sprint2`。

---

## §1 四层链路总览

```mermaid
flowchart LR
    subgraph L1["Layer 1 · shared/types.ts（单一契约源）"]
        CH[IPC_CHANNELS 常量<br/>类型：AgentSendMessageInput / AgentEvent / Project / WorkflowStage ...]
    end
    subgraph L2["Layer 2 · main/ipc.ts"]
        REG[registerIpcHandlers<br/>ipcMain.handle(channel, safeInvoke(...))]
        PUB[事件发布器装配<br/>agent-stream-event 单向通道]
    end
    subgraph L3["Layer 3 · preload/bridge.ts"]
        BR[contextBridge.exposeInMainWorld<br/>electronAPI = { agent, project, permissions, ... }]
    end
    subgraph L4["Layer 4 · renderer/agent-atoms.ts"]
        ATOMS[agentStreamStateFamily 归约<br/>stage / permission / delegation / preview atoms]
        HOOKS[useUserDecisionCards → CardOptions]
    end

    CH -->|invoke 请求类型| REG
    REG -->|响应 ApiResult&lt;T&gt;| BR
    BR -->|window.electronAPI.xxx| ATOMS
    PUB -->|ipcRenderer.on('agent:stream-event')| BR
    BR -->|onStreamEvent(listener)| ATOMS
    ATOMS -->|events| HOOKS
```

- **请求方向**：renderer `invoke(channel, payload)` → preload 封装 → `ipcMain.handle` → `safeInvoke` 包 `ApiResult`。
- **事件方向**：主进程 `setAgentStreamPublisher / setProgrammingEventPublisher / setPermissionRequestPublisher`
  统一 `webContents.send('agent:stream-event', AgentEvent)` → preload `onStreamEvent` 订阅 → 全局监听器归约 atom。
- **分层铁律**：renderer 不直接访问 Node.js / fs / API Key / Agent SDK，一切经 preload 桥；桥不承载业务逻辑。

---

## §2 shared/types.ts — IPC 契约要点（Layer 1）

### 2.1 通道常量与请求包装（`shared/types.ts:17`）

`IPC_CHANNELS` 是单一扁平对象（48 个通道），全部 handler 与桥层都引用它，杜绝手写字符串漂移。
命令以 `agent:*` / `session:*` / `permission:*` / `project:*` / `sandbox:*` / `snapshot:*` / `document:*` /
`dom:*` / `analytics:*` / `channel:*` / `category-routing:*` / `prompt:*` 前缀命名。

请求包装：

- `RequestEnvelope`（`shared/types.ts:76`）— 所有 invoke input 必须 `extends` 它，带 `request_id`。
- `ApiResult<T>`（`:80`）— `{ ok:true, data }` / `{ ok:false, error: ApiError }`；`ApiError`（`:107`）带
  `code`（`ErrorCode`，含 `AGENT_SESSION_BUSY` / `PERMISSION_DENIED` / `SANDBOX_RUN_FAILED` / `API_KEY_DECRYPT_FAILED` 等 21 个）、
  `user_visible_message`、`retryable`。

### 2.2 Agent 消息入参（`shared/types.ts:551`）

```text
AgentSendMessageInput = RequestEnvelope + {
  session_id, project_id, content,
  mode: ProjectMode ('quick'|'longterm'),
  current_stage: WorkflowStage,          # 渲染端上报阶段，主进程仅回退用
  channel_id?: string,
  metadata?: {
    source: 'chat' | 'card_option' | 'system_resume'   # card_option = 决策卡回传
    selected_option_id?: string                        # 用户点选的选项 id
  }
}
```

> **回传契约**：决策卡回传 = `source:'card_option'` + `selected_option_id`；普通聊天 = `source:'chat'`。
> 主进程 `resolveCardAnswer`（`guide-agent-service.ts:231`）据此识别已澄清并直接开草图。

### 2.3 AgentEvent 事件契约（`shared/types.ts:675`）

所有事件带 `event_id / session_id / project_id? / type / payload: Record<string,unknown> / created_at`。
全部 `type` 与 payload 要点：

| type | payload 要点 | 消费方 |
|---|---|---|
| `message_delta` | `text` | 流式气泡累积 |
| `message_completed` | — | 流式气泡收尾（running 保持 true） |
| `stage_changed` | `stage` | 权威阶段展示（StageIndicator） |
| `tool_call_started` | `tool` / `turn` / `input_summary` | 阶段指示细化「第 N 轮 · 正在{工具}」 |
| `tool_call_completed` | `tool` / `turn` / `status` / `duration_ms` / `output_summary` / `detail`(含 `delegation_id`) | ToolCallFeed / 委派行派生 |
| `permission_requested` | `request: PermissionRequest` | 权限弹窗队列 |
| `sketch_ready` | `preview_url` / `snapshot_id` / `summary` | 预览 + 确认草图 |
| `mvp_ready` | `preview_url` / `snapshot_id` / `run_command` | 预览 + MVP 横幅 + 自动改名回填 |
| `repairing` | — | MvpStatusBanner「自动修复中」 |
| `rollback_done` | `preview_url` | 预览回填 |
| `judge_result` | `verdict` / `outcome` | MvpStatusBanner 裁判结果 |
| `user_decision_required` | `kind`(clarification/requirement_confirm/prd_review/retry…) / `title` / `questions[{id,label,description}]` / `requirements` / `research` | 决策卡 / RequirementConfirmDialog |
| `retrying` | — | 重试提示 |
| `error` | `code` / `message` | 全局错误 + last_error |
| `completed` | — | 终态：累积文本沉淀为助手消息 |
| `permission_mode_changed`（F8） | `mode` | 权限模式 atom 同步 |
| `delegation_question` | `delegation_id` / `child_session_id` / `role` / `question` | 委派「待回答」 |
| `delegation_started/completed/failed/cancelled` | `delegation_id` / `child_session_id` / `role` / `goal` / `status` | delegationsFamily 生命周期 |

### 2.4 平台枚举与实体

- `WorkflowStage`（`shared/types.ts:124`）— 13 阶段，与 `00-总索引 §5` 状态机一一对应。
- `SnapshotKind`（`:155`）— `sketch / mvp / iteration / pre_risk / upgrade / rollback_guard`。
- `ProviderType`（`:156`）— 22 家渠道厂商协议标识（anthropic / openai / deepseek / google / kimi / zhipu / ark / minimax / doubao / qwen / xiaomi / custom…）。
- `Project`（`:717`）— 含 `current_stage`（**权威阶段唯一源**）、`blocked_action`、`sketch_source`、`via_agent_loop`、`agent_loop_status`、`constraints`、`scope_exclusions` 等。
- `AgentLoopStatus`（`:665`）— `completed / turn_limit / budget_exhausted / cancelled`（loop-aware judge 用）。

### 2.5 权限相关类型

- `PermissionRequest`（`shared/types.ts:628`）— 工具权限门请求（tool_name / tool_input / danger_level / user_visible_summary）。
- `PermissionResponseInput`（`:639`）— `permission_request_id + decision('allow'|'deny') + remember_for_session?`。
- `PromaPermissionMode`（`:181`）— `safe / ask / allow-all`；dangerous 级别与模式无关、一律人工确认（@S3-JUDGE-009）。
- `PermissionSetModeInput`（`:652`）— 设置页三档同步主进程 enforcement，成功后广播 `permission_mode_changed`。

### 2.6 与 00-总索引 §6 对齐

- 契约唯一源、handler 注册、桥层、事件流、决策回传五条均已在 §2.1–2.5 落点，锚点与 00 一致。
- `00 §6` 提到 `shared/types.ts` 共 1167 行，本文件全部锚点以此文件为基准。
- `00 §2.4` 高频事件速记（`stage_changed` / `user_decision_required` / `permission_requested` / `mvp_ready` / `delegation_*`）在此展开为完整事件表（§2.3）。

---

## §3 main/ipc.ts — Handler 注册（Layer 2）

### 3.1 事件发布器装配（`main/ipc.ts:103`）

`registerIpcHandlers(ipcMain, mainWindow)` 开头装配三条单向事件源，全部走 `agent:stream-event` 通道：

```text
setAgentStreamPublisher(event):      # Agent 会话流（orchestrator 发布）
    webContents.send('agent:stream-event', event)
    handleAgentStreamEvent(event)     # T6 后台执行系统通知（无后端注入时 no-op）
setProgrammingEventPublisher(event): # 编程编排流（programming-orchestrator 发布）
    webContents.send(...) ; handleAgentStreamEvent(event)
setPermissionRequestPublisher(req):  # 权限门请求 → 封装成 permission_requested 事件
    webContents.send('agent:stream-event', { event_id:req.id, session_id, project_id,
                                             type:'permission_requested', payload:{request:req} })
```

### 3.2 IPC handler 清单表

> 每个 handler 统一形如 `safeInvoke(extractRequestId(payload), () => { 校验 → 服务侧函数 })`，
> 校验失败或服务侧抛错 → `ApiResult` 错误归一（§3.3）。权限门用 `assertToolAllowed`（`permission-service`）。

| channel | 入参（`shared` 类型） | 返回 | 服务侧函数 / 关键副作用 |
|---|---|---|---|
| **agent:** | | | |
| `agent:send-message` | `AgentSendMessageInput` | `AgentSendMessageResult` | `runAgent`（`orchestrator.ts:167`）并发守卫 + 权威阶段 + 事件流 |
| `agent:stop` | `AgentCancelInput` | `AgentCancelResult` | `cancelAgent`（abort SDK 查询） |
| `agent:list-sessions` | `AgentListSessionsInput` | `AgentListSessionsResult` | `listSessions` |
| `agent:load-messages` | `AgentLoadMessagesInput` | `AgentLoadMessagesResult` | `loadMessages` |
| `agent:confirm-requirements` | `AgentConfirmRequirementsInput` | `AgentConfirmRequirementsResult` | `resolveRequirementConfirm`（`guide-agent-service.ts:647`）confirm/delegate → PRD 前移 + 草图 |
| `session:clean-orphans` | `RequestEnvelope` | `{ removed }` | `cleanOrphanSessions`（U11） |
| **permission:** | | | |
| `permission:response` | `PermissionResponseInput` | `PermissionResponseResult` | `resolvePermission`（决策 allow/deny 放行/拒绝工具） |
| `permission:set-mode` | `PermissionSetModeInput` | `PermissionSetModeResult` | `setPermissionMode` + **广播** `permission_mode_changed`（F8） |
| **project:** | | | |
| `project:create` | `ProjectCreateInput` | `Project` | `createProject` + 埋点 `project_created` |
| `project:list` | `ProjectListInput` | `Project[]` | `listProjects` + 每项目附 `progress_summary`（U16） |
| `project:archive` / `unarchive` | `ProjectArchiveInput` | `Project` | `archiveProject` / `unarchiveProject` |
| `project:delete` | `ProjectDeleteInput` | `{ deleted }` | 先 `stopSandbox`（避免句柄占用 EPERM）再 `deleteProject` |
| `project:export` | `ProjectExportInput` | `ProjectExportResult` | `dialog.showOpenDialog` 选目录 → `exportProject`；取消 → `{ canceled:true }`（U10） |
| `project:rename` | `ProjectRenameInput` | `Project` | `renameProject`（清洗 + 空名 VALIDATION_ERROR，U13） |
| `project:abandon` / `reopen` | `ProjectAbandonInput` | `Project` | `abandonProject` / `reopenProject`（active ↔ abandoned，U15） |
| `project:confirm-sketch` | `ConfirmSketchInput` | `Project` | `confirmSketch`；`accepted` → **fire-and-forget** `runMvpTask` + `runAgentLoopPostTesting`（注册可取消句柄，失败发 error 事件，熔断/用户停止静默） |
| `project:submit-correction` | `PointCorrectionInput` | `RevisionAccepted` | `submitCorrection` + 埋点 `point_correction`；同区两次纠错 → 向导追问；有诉求 → `runIterationTask` 再生成（U8） |
| `project:upgrade` | `ProjectUpgradeInput` | `Project` | 先 `createSnapshot(kind:'upgrade')` + 埋点 `mode_upgraded` → `upgradeProject` |
| `project:finalize` | `ProjectFinalizeInput` | `Project` | 埋点 `satisfaction_marked` + `project_finalized` → `finalizeProject`（U6） |
| **sandbox:** | | | |
| `sandbox:run` | `SandboxRunInput` | `SandboxRunResult` | 权限门 `run_project` → `runSandbox`（用户显式操作走当前权限模式） |
| `sandbox:stop` | `SandboxStopInput` | `SandboxStopResult` | `stopSandbox` |
| `sandbox:restore` | `SandboxRunInput` | `SandboxRunResult` | `runSandbox` 直接重跑回填 preview_url，**不弹权限**（P0-2 重启恢复） |
| **snapshot:** | | | |
| `snapshot:create` | `SnapshotCreateInput` | `Snapshot` | 权限门 `create_snapshot` → `createSnapshot` |
| `snapshot:rollback` | `SnapshotRollbackInput` | `RollbackResult` | 权限门 `rollback_snapshot` → `rollbackSnapshot`；`reason='user_undo'` 埋点 `user_undo` |
| `snapshot:list` | `SnapshotListInput` | `SnapshotListResult` | `listSnapshots` |
| `snapshot:screenshot` | `SnapshotScreenshotInput` | `{ data_url }` | `loadSnapshotScreenshot` 读图转 base64（U9） |
| `snapshot:document-list` | `SnapshotDocumentListInput` | `SnapshotDocumentListResult` | `listSnapshotDocuments`（T7 冻结文档回看） |
| `snapshot:document-read` | `SnapshotDocumentReadInput` | `SnapshotDocumentReadResult` | `readSnapshotDocument` |
| **document:** | | | |
| `document:sync` | `DocumentSyncInput` | `DocumentSyncResult` | `syncDocuments`（checkpoint 落盘） |
| `document:list` | `DocumentListInput` | `DocumentListResult` | `listDocuments` |
| `document:read` | `DocumentReadInput` | `DocumentReadResult` | `readDocument` |
| **dom:** | | | |
| `dom:collect-context` | `DomCollectContextInput` | `DomCollectContextResult` | `collectDomContext`（渲染进程读不到跨域 iframe，主进程 subframe.executeJavaScript 收集 selector/文本/包围盒，U8） |
| **analytics:** | | | |
| `analytics:track` | `AnalyticsTrackInput` | `AnalyticsTrackResult` | `trackAnalytics` |
| **channel:** | | | |
| `channel:list` | `RequestEnvelope` | `Channel[]` | `listChannels` |
| `channel:create` | `ChannelCreateEnvelope` | `Channel` | `createChannel`（safeStorage 加密存 key） |
| `channel:update` | `ChannelUpdateEnvelope` | `Channel` | `updateChannel`；不存在抛 `CHANNEL_NOT_FOUND` |
| `channel:test` | `ChannelTestEnvelope` | `ChannelTestResult` | `testChannel` |
| `channel:test-direct` | `ChannelTestDirectEnvelope` | `ChannelTestResult` | `testChannelDirect` |
| `channel:fetch-models` | `FetchModelsEnvelope` | `FetchModelsResult` | `fetchModels` |
| `channel:delete` | `ChannelDeleteEnvelope` | `{ deleted }` | `deleteChannel`；不存在抛 `CHANNEL_NOT_FOUND` |
| **category-routing:** | | | |
| `category-routing:list` | `RequestEnvelope` | `CategoryRoutingListResult` | `buildCategoryRoutingViews`（视图模型，不含明文 key，M5） |
| `category-routing:update` | `CategoryRoutingUpdateEnvelope` | `CategoryRoutingListResult` | `updateCategoryRouting`（非法引用剥离 + warn，不阻塞其余类别） |
| **prompt:** | | | |
| `prompt:list` | `RequestEnvelope` | `PromptSlotInfo[]` | `listPromptSlots` |
| `prompt:read` | `PromptReadInput` | `PromptSlotDetail` | `readPromptSlot` |
| `prompt:save` | `PromptSaveInput` | `PromptSaveResult` | `savePromptSlot` |
| `prompt:reset` | `PromptResetInput` | `PromptResetResult` | `resetPromptSlot` |

### 3.3 safeInvoke 错误归一（`main/ipc.ts:737`）

```text
safeInvoke(requestId, fn):
  try:      return ok(requestId, await fn())
  catch e:
    console.error('[ipc] handler error:', ...)     # 先落真实错误，避免被 VALIDATION_ERROR 掩盖
    # 按错误消息前缀匹配 → 专用 ErrorCode + retryable：
    AGENT_SESSION_BUSY(可重试) / CHANNEL_NOT_FOUND / SESSION_NOT_FOUND / PROJECT_NOT_FOUND /
    PERMISSION_REQUEST_NOT_FOUND / PERMISSION_DENIED / SANDBOX_RUN_FAILED(带 category) /
    SNAPSHOT_CREATE_FAILED / DOCUMENT_SYNC_FAILED / ANALYTICS_WRITE_FAILED / API_KEY_DECRYPT_FAILED
    return fail(requestId, code, message)          # 未命中 → VALIDATION_ERROR 兜底
```

> **要点**：错误码不靠抛异常类型，而从 `^([A-Z][A-Z0-9_]*):` 消息前缀提取（`errorCodeFrom`，`ipc.ts:97`），
> 与引擎层抛错约定（如 `SANDBOX_RUN_FAILED:${category}`）打通。

---

## §4 preload/bridge.ts — 桥（Layer 3）

### 4.1 桥面结构（`preload/bridge.ts:71`）

`electronAPI` 对象与 `shared/types.ts:1082` 的 `ElectronAPI` 类型逐字段对齐，纯 `ipcRenderer.invoke` 封装，
**不承载业务**；`contextBridge.exposeInMainWorld('electronAPI', electronAPI)`（`:195`）暴露。禁止暴露
fs / path / child_process / process.env / ipcRenderer 本体。

```text
electronAPI:
  agent.onStreamEvent(listener):                     # 唯一的事件订阅入口（:85）
      handler = (_event, data) => listener(data)
      ipcRenderer.on('agent:stream-event', handler)
      return () => ipcRenderer.removeListener(...)   # 返回取消订阅函数（Unsubscribe）
  agent.sendMessage / cancel / listSessions / loadMessages / cleanOrphans / confirmRequirements
  permissions.respond / setMode
  project.create / list / archive / unarchive / delete / export / rename / abandon / reopen
           / confirmSketch / submitCorrection / upgrade / finalize
  sandbox.run / stop / restore
  snapshots.create / rollback / list / screenshot / documentList / documentRead
  documents.sync / list / read
  dom.collectContext
  analytics.track
  channels.list / create / update / test / testDirect / fetchModels / delete
           / categoryRoutingList / categoryRoutingUpdate
  prompts.list / read / save / reset
```

---

## §5 renderer/agent-atoms.ts — 事件流归约（Layer 4）

`setupGlobalAgentListeners`（`renderer/agent-atoms.ts:191`）在 `main.tsx:9` 调用一次，永不卸载；
经 `window.__jotai_store__` 直接操作 atoms，不依赖 React 组件生命周期。事件归约是**流式 reducer**：
每事件追加进 `agentStreamStateFamily(sessionId).events`，另按事件类型旁路更新其他 atoms。

### 5.1 setupGlobalAgentListeners — `renderer/agent-atoms.ts:191`（详细级）

- 输入：读取 `window.electronAPI?.agent`（onStreamEvent）、`window.__jotai_store__`
- 副作用：会话追踪 / 预览与快照 atom / 自动改名回填 / 消息沉淀 / 决策卡消费标记与需求确认弹窗 / 权限模式同步 / 委派归约 / 权限队列 / 阶段与工具状态 / streamState 累积
- 返回值：cleanup 函数（应用退出时取消订阅）

```text
setupGlobalAgentListeners():
  if !api or !store: return no-op
  return api.onStreamEvent((event) => store.set(...))     # 单入口，以下都在事件回调内

  # ---- 0. 会话追踪 ----
  if event.session_id 不在 agentSessionsAtom: 追加 { session_id, project_id, title:'当前对话' }

  # ---- 1. 预览与快照（sketch_ready / mvp_ready / rollback_done）----
  if event.type in {sketch_ready, mvp_ready, rollback_done}:
      url = event.payload.preview_url
      if event.project_id 且 url: previewUrlsAtom[project_id] = url     # 按项目隔离
      if event.payload.snapshot_id: currentSnapshotIdAtom = snapshot_id  # 「确认草图」回传依赖
      if event.project_id: 异步 loadSnapshots(project_id)               # 时间轴胶片条数据源

  # ---- 2. MVP 自动改名回填 ----
  if event.type == 'mvp_ready':
      异步 project.list → 找到当前项目，若 name 已变 → currentProjectAtom = 新项目  # autoNameProject 落盘

  # ---- 3. 终态沉淀（completed / error）----
  if event.type in {completed, error}:
      accumulated = 读 streamState.content（尚未重置，同步读）
      if accumulated 非空: agentMessagesFamily 追加一条 assistant 消息    # 修复「流式文本消失不进列表」

  # ---- 4. 新一轮决策需求 ----
  if event.type == 'user_decision_required':
      decisionConsumedFamily(session_id) = false                        # 重置，让新卡片能弹
      if payload.kind == 'requirement_confirm':                          # 专用弹窗，不走内联卡
          requirementConfirmFamily(session_id) = { title, requirements(过滤合法id/description),
                                                   research{available, summary} }

  # ---- 5. 权限模式广播（F8）----
  if event.type == 'permission_mode_changed' 且 payload.mode 合法:
      permissionModeAtom = mode

  # ---- 6. 委派归约（delegation_* + tool_call_completed.detail）----
  delegationsFamily(session_id) = reduceDelegationEvent(previous, event)

  # ---- 7. 主 reducer：streamStateFamily 单播 ----
  streamAtom = agentStreamStateFamily(session_id)
  store.set(streamAtom, previous):
      # 7a. 权限请求入队
      if event.type == 'permission_requested':
          pendingPermissionRequestsAtom[event.session_id].append(event.payload.request)
      # 7b. 阶段变更 → workflowStageAtom + stageIndicatorLabelAtom
      if event.type == 'stage_changed' 且 payload.stage:
          workflowStageAtom = stage;  stageIndicatorLabelAtom = STAGE_LABEL_MAP[stage] ?? '处理中'
      # 7c. 工具进行中 → 阶段指示细化「第 N 轮 · 正在{工具}」
      #     仅在 generating_mvp/testing/repairing/iterating 生效；下一次 stage_changed 重置
      if event.type == 'tool_call_started' 且 stage ∈ {generating_mvp, testing, repairing, iterating}:
          toolName = TOOL_STAGE_LABELS[tool] ?? tool
          stageIndicatorLabelAtom = turn 存在 ? `第 ${turn} 轮 · 正在${toolName}` : `正在${toolName}`
      # 7d. 文本累积 + running 判定
      isTerminal = type ∈ {completed, error}
      return { running: !isTerminal,
               events: [...previous.events, event],
               content: isTerminal ? '' : previous.content + text,   # 终态清空（已沉淀为消息）
               last_error: type=='error' ? payload.code : 保留 }
```

### 5.2 AgentEvent → atom 映射表

| 事件类型 | 更新/触发的 atom 或动作 | 派生 UI |
|---|---|---|
| `message_delta` | `streamStateFamily.content` 累积 | 流式气泡 |
| `message_completed` | `streamStateFamily.events` 追加（running 保持 true） | 气泡收尾 |
| `stage_changed` | `workflowStageAtom`、`stageIndicatorLabelAtom` | StageIndicator / MvpStatusBanner |
| `tool_call_started` | `streamStateFamily.events`；生成/测试/修复/迭代阶段更新 `stageIndicatorLabelAtom` | 阶段指示细化 |
| `tool_call_completed` | `streamStateFamily.events`；`detail.delegation_id` 存在时派生进 `delegationsFamily`（仅无既有记录） | ToolCallFeed / DelegationFeed |
| `permission_requested` | `pendingPermissionRequestsAtom` 按 session 入队 | PermissionDialog |
| `sketch_ready` | `previewUrlsAtom[project_id]`、`currentSnapshotIdAtom`、异步 `loadSnapshots` | 预览 + 「确认草图」按钮 |
| `mvp_ready` | 同上 + 异步 `project.list` 回填 `currentProjectAtom`（自动改名） | 预览 + MVP 横幅 |
| `repairing` | `streamStateFamily.events` | MvpStatusBanner |
| `rollback_done` | `previewUrlsAtom[project_id]`、`currentSnapshotIdAtom`、`loadSnapshots` | 预览回填 |
| `judge_result` | `streamStateFamily.events` | MvpStatusBanner 裁判结果 |
| `user_decision_required` | `decisionConsumedFamily=false`；`kind='requirement_confirm'` 写 `requirementConfirmFamily` | 决策卡 / RequirementConfirmDialog |
| `retrying` | `streamStateFamily.events` | 重试提示 |
| `error` | 终态：累积文本沉淀 `agentMessagesFamily`；`streamState` 清空 content、running=false、`last_error` | 全局错误气泡 |
| `completed` | 终态：同上（无 last_error） | 流程收尾 |
| `permission_mode_changed` | `permissionModeAtom` | 设置页/权限弹窗模式 |
| `delegation_question` | `delegationsFamily` 该行 `pending_question` | 委派「待回答」警示 |
| `delegation_started/completed/failed/cancelled` | `delegationsFamily` 该行 status | CollaborationPanel / DelegationFeed |

### 5.3 委派事件归约 reduceDelegationEvent — `renderer/agent-atoms.ts:365`

- 输入：`previous: DelegationView[]` + `event: AgentEvent`
- 副作用：无（纯函数，供 delegationsFamily reducer 调用）
- 返回值：`DelegationView[]`（按 `delegation_id` upsert，原子字段不覆盖已有记录）

```text
reduceDelegationEvent(previous, event):
  # delegation_id 两种来源：生命周期事件在顶层；tool_call_completed 的 delegate_agent detail 嵌套
  id = event.payload.delegation_id ?? (type=='tool_call_completed' && detail?.delegation_id)
  if !id: return previous
  base = { delegation_id: id,
           child_session_id / role / goal: 已有记录值 ?? 本次事件值 ?? 默认('custom'/'') ,
           status: 已有 ?? 'running' }
  switch event.type:
    delegation_started    → upsert({...base, status:'running'})
    delegation_completed  → upsert({...base, status:'completed'})
    delegation_failed     → upsert({...base, status:'failed'})
    delegation_cancelled  → upsert({...base, status:'cancelled'})
    delegation_question   → upsert({...base, pending_question: payload.question})
    tool_call_completed   → # 仅无既有记录时派生初始行（防御时序：工具调用先于子循环收敛）
                             if 已有: return previous
                             status = detail.status ∈ {completed,failed,cancelled} ? : 'running'
                             return upsert(派生行)
    default               → return previous
```

---

## §6 renderer/components/App.tsx — 主流程挂载与会话激活

### 6.1 结构

- `App`（`App.tsx:64`）— 根组件：`<Aurora/><AppRoutes/><PermissionDialog/><RequirementConfirmDialog/>`
  （后两者常驻挂载、无状态渲染 null）。
- `AppRoutes`（`App.tsx:82`）— 四路由：`mode-selection / workspace / project-history / settings`；持有全部 IPC
  回调（发送/停止/卡片/纠错/回滚/确认草图/完成/升级/预览刷新）。

### 6.2 启动恢复与会话激活

- `App.tsx:166`（启动 `useEffect`）— `project.list` 取首个活动项目直接进工作区：用 `last_session_id` 续接会话
  （无则新会话 id）、回填各 atom、`loadSnapshots` + `loadAgentSessions` + `loadSessionHistory`（历史骨架占位）、
  `PREVIEW_READY_STAGES` 阶段 `restorePreview`（P0-2 沙箱重跑）。
- `handleModeSelected`（`App.tsx:206`）— 模式选择后取 `currentProjectAtom` 新建会话、写入首条问候语、
  清空上一项目预览/时间轴。
- `handleResumeProject`（`App.tsx:242`）— 从历史列表恢复，逻辑同启动恢复。
- `handleProjectsChanged`（`App.tsx:648`）— 归档/删除/恢复后同步列表；当前项目被删则回模式选择。

### 6.3 发送 / 停止 / 卡片回传（摘要）

- `handleSendMessage`（`App.tsx:284`）— 本地追加 user 气泡 → `agent.sendMessage({metadata:{source:'chat'}})`；
  `AGENT_SESSION_BUSY` 时补一条引导系统消息（U5）。
- `handleStopGeneration`（`App.tsx:322`）— 本地落系统消息「已停止生成」→ `agent.cancel(reason:'user_cancelled')`。
- `handleCardOptionSelect`（`App.tsx:341`）— 决策卡回传（详见 §7）。

### 6.4 其他回调（摘要）

- `handleCollectDomContext` / `handleCorrectionSubmit`（`App.tsx:368 / 385`）— 点选纠错：点击即收集 DOM 上下文
  （跨域 iframe 由主进程收集），提交时缺失则兜底再收集一次；纯坐标 fallback_mode 兜底。
- `handleConfirmSketch`（`App.tsx:521`）— `project.confirmSketch(decision:'accepted')`；后端 fire-and-forget
  跑 MVP（P0-1 / D5）。
- `handleRollback`（`App.tsx:448`）— `snapshots.rollback(reason:'user_undo')`；成功后回填预览/快照指针、刷新时间轴，
  如实提示文档版本差异（T7）。
- `handleMarkComplete`（`App.tsx:547`）— `project.finalize` → 同步 completed 阶段（U6）。
- `handleUpgrade` / `handleConfirmUpgrade`（`App.tsx:574 / 578`）— 升级确认弹窗 → `project.upgrade` → 切 longterm（U1）。
- `restorePreview` / `handleRefreshPreview` / `handlePreviewError`（`App.tsx:137 / 605 / 631`）— 沙箱重跑回填预览与
  加载/错误/超时态管理（P0-2 / P2）。

---

## §7 决策卡回传链路（详细级）

澄清/需求确认卡片的完整闭环：**主进程发 `user_decision_required` → 渲染端归约 events → 派生决策卡 → 用户点选
→ 立即消费 + `metadata.source='card_option'` + `selected_option_id` 回传 → 主进程 `resolveCardAnswer` 识别 → 开草图**。

```mermaid
sequenceDiagram
    participant M as main（guide-agent-service）
    participant P as preload bridge
    participant A as agent-atoms（store）
    participant H as useUserDecisionCards
    participant C as CardOptions
    participant App as AppRoutes

    M->>P: send('agent:stream-event', user_decision_required{kind,title,questions})
    P->>A: onStreamEvent(listener)
    A->>A: events 追加 + decisionConsumed=false + requirementConfirmFamily(kind=requirement_confirm)
    A-->>H: streamStateFamily.events 变化
    H->>H: extractDecisionCards 后向扫描（sketch_ready 优先 → null 隐藏）
    H-->>C: DecisionCards{title, options[1..3]}
    C->>App: onSelect(option)
    App->>App: markDecisionConsumed(sessionId)  ← 立即隐藏，不等 sketch_ready（空窗期防重复点击撞 BUSY）
    App->>P: invoke('agent:send-message', { content: option.label,
                                            metadata: { source:'card_option',
                                                        selected_option_id: option.id } })
    P->>M: runAgent → handleGuideMessage
    M->>M: resolveCardAnswer 识别 card_option + 非阻塞 id → runSketchTask
```

### 7.1 useUserDecisionCards / extractDecisionCards — `ChatPanel-sprint2.tsx:144 / 97`

- 输入：读取 `activeAgentSessionIdAtom` + `agentStreamStateFamily(sessionId).events` + `decisionConsumedFamily`
- 副作用：无（纯派生 hook）
- 返回值：`null`（无决策需求/已消费）或 `DecisionCards{title?, options[]}`

```text
useUserDecisionCards():
  sessionId, streamState, consumed = 读 atoms
  if !sessionId or consumed: return null            # 已点选立即隐藏（不等 sketch_ready 空窗）
  return extractDecisionCards(streamState.events)   # 后向扫描事件流

extractDecisionCards(events):                       # 从后往前扫
  for event in events.reversed:
      if type in {sketch_ready, mvp_ready}: return null        # 产物就绪 → 卡片已被后端消费
      if type != 'user_decision_required': continue
      questions = payload.questions ?? []
      if questions.length == 0: return { options: [] }          # 0 条 = 模型在文本里追问，不弹卡
      return { title: payload.title,                            # 1~3 条 → 决策卡
               options: questions.map(q => ({ id: q.id ?? q.label ?? String(i),   # B5 防御缺 id
                                              label: q.label, description: q.description })) }
  return null                                                  # 无决策事件
```

### 7.2 toCardSelectionMeta — `ChatPanel-sprint2.tsx:170`

```text
toCardSelectionMeta(optionId): { source: 'card_option', selected_option_id: optionId }
```

### 7.3 handleCardOptionSelect — `renderer/components/App.tsx:341`

- 输入：`option: CardOption`（来自 useUserDecisionCards 的决策卡）
- 副作用：本地追加 user 气泡、`markDecisionConsumed(sessionId)`（立即隐藏卡片）、回传 `agent:send-message`
- 返回值：无（fire-and-forget）

```text
handleCardOptionSelect(option):
  appendMessageToSession(sessionId, { role:'user', text: option.label })   # 点击即有反馈
  markDecisionConsumed(sessionId)                                          # 立即消费卡片，防空窗重复点击
  agent.sendMessage({
      request_id, session_id, project_id: 当前项目 ?? 列表首个,
      content: option.label, mode, current_stage: currentStage,
      metadata: toCardSelectionMeta(option.id),     # source='card_option' + selected_option_id
  })
```

### 7.4 resolveCardAnswer（主进程识别）— `main/guide-agent-service.ts:231`

```text
resolveCardAnswer(input, primaryIntent):
  if input.metadata?.source != 'card_option': return undefined          # 非卡片来源直接放行到模型路径
  optionId = input.metadata.selected_option_id
  if BLOCKED_DECISION_IDS.has(optionId ?? ''): return undefined         # 阻塞类决策（test_repair 等）不走此通道
  isFixedCard = FIXED_CARD_LABELS[optionId] == input.content.trim()     # 固定卡片校验
  description = isFixedCard ? CARD_ANSWER_REQUIREMENTS[optionId] : input.content
  return { prompt: input.content,
           requirements: ensurePrimaryIntent([{id:'F-001', description}], primaryIntent) }
  # 返回值非空 → handleGuideMessage 分支 1：recordDecision('clarification_answer') → runSketchTask
```

> **要点**：卡片回传与「自由文本让渡」（`resolveAutoDelegation`，`guide-agent-service.ts:249`）出口一致；
> 让渡不带 card_option 元数据，靠 `isAutoDelegationText` 确定性判定（零模型依赖）。
> PRD 审查卡回传（override / supplement）在 `[sprint2]` `resolvePrdReviewCardAnswer` 提前拦截，见 `01 §3`。

---

## §8 关键组件职责摘要表

| 组件 | 位置 | 职责 |
|---|---|---|
| `ChatPanel` | `renderer/components/ChatPanel.tsx:78` | 消息列表 + 输入框 + CardOptions 决策卡 + WaitingFeedback 超时态 + ToolCallFeed + DelegationFeed 委派胶囊 |
| `ChatPanel-sprint2`（决策卡） | `ChatPanel-sprint2.tsx:144` | `useUserDecisionCards`（events→决策卡）、`extractDecisionCards`（后向扫描）、`toCardSelectionMeta` |
| `CardOptions` | `CardOptions.tsx:21` | 决策卡选项按钮组（单轮 ≤4，含「你帮我决定」） |
| `PreviewPanel` | `PreviewPanel.tsx:47` | 预览 iframe 玻璃磁贴 + 状态机（空/加载/运行/错误/超时）+ 控制栏 + 点选纠错 + 确认草图 + 标记完成 |
| `TimelinePanel` | `TimelinePanel.tsx:21` | 顶部快照胶片条 + 版本计数 + 回滚确认 + 快照冻结文档回看（T7） |
| `RequirementConfirmDialog` | `RequirementConfirmDialog.tsx:59` | 需求确认弹窗三出口：confirm 勾选子集 / delegate 让渡 / 补充说明（send-message）；市调摘要折叠展示 |
| `CollaborationPanel` | `CollaborationPanel.tsx:26` | 委派协作右抽屉（`collaborationPanelExpandedAtom` 门控）：子会话 id/role/status 实时 + pending_question + 展开历史 |
| `DelegationFeed` | `DelegationFeed.tsx:23` | ChatPanel 内联委派行胶囊（仿 ToolCallBlock 折叠行），数据源 `delegationsFamily` |
| `MvpStatusBanner` | `MvpStatusBanner.tsx:214` | MVP 状态横幅：mvp_ready / judge_result / repairing / stage_changed 派生 |
| `StageIndicator` | `StageIndicator.tsx:9` | 阶段胶囊（active=琥珀色脉冲，空闲=灰色） |
| `WorkspaceHeader` | `WorkspaceHeader.tsx:30` | 顶部头部：品牌 + 项目名 + 模式徽标 + StageIndicator + 网络态 + 协作/设置/升级入口 |
| `WorkspaceShell` | `WorkspaceShell.tsx:73` | 工作区 Bento 布局容器（Header + 时间轴 + 主区 + 协作抽屉挂载） |
| `PermissionDialog` | `PermissionDialog.tsx:133` | 权限门弹窗：读 `permissionQueueAtom`（FIFO 派生）→ `permissions.respond` / `setMode` |
| `ToolCallBlock` | `ToolCallBlock.tsx:162/193` | `deriveToolCallRecords`（started 建行 → completed 回填）、ToolCallFeed 工具调用行、ToolBlocksReplay 历史回放 |
| `ModeSelectionPage` / `ModeCard` | `ModeSelectionPage.tsx:14` | 模式选择两卡（quick/longterm）→ `project.create` |
| `ProjectHistoryPage` | `ProjectHistoryPage.tsx:60` | 项目历史列表：归档/删除/恢复/重命名 + 恢复工作区 |
| `DocumentPanel` | `DocumentPanel.tsx:27` | 文档面板（仅 longterm 可见）：PRD/GWT/测试报告阅读 |
| `atoms.ts`（组件层再导出） | `renderer/components/atoms.ts:39` | 从 agent-atoms 再导出共享 atom + 组件特有原子（workspaceWaiting 等） |
| `atoms-sprint2.ts` | `renderer/components/atoms-sprint2.ts:36` | 权限队列派生 `permissionQueueAtom`、渠道/路由/提示词设置页状态 |

---

## 本域函数索引

| 函数 | 位置 | 章节 |
|---|---|---|
| `registerIpcHandlers` | `main/ipc.ts:103` | §3.1/§3.2 |
| `safeInvoke` | `main/ipc.ts:737` | §3.3 |
| `errorCodeFrom` | `main/ipc.ts:97` | §3.3 |
| `validateAgentSend` | `main/ipc.ts:766` | §3.2 agent:send-message |
| `validateConfirmRequirements` | `main/ipc.ts:775` | §3.2 agent:confirm-requirements |
| `validatePermissionResponse` | `main/ipc.ts:783` | §3.2 permission:response |
| `resolvePermissionSession` | `main/ipc.ts:798` | §3.2 权限门会话 |
| `extractCorrectionPrompt` | `main/ipc.ts:807` | §3.2 project:submit-correction |
| `electronAPI`（桥对象） | `preload/bridge.ts:71` | §4.1 |
| `setupGlobalAgentListeners` | `renderer/agent-atoms.ts:191` | §5.1 |
| `reduceDelegationEvent` | `renderer/agent-atoms.ts:365` | §5.3 |
| `markDecisionConsumed` | `renderer/agent-atoms.ts:541` | §7.3 |
| `loadAgentSessions` | `renderer/agent-atoms.ts:561` | §6.2 |
| `loadSessionHistory` | `renderer/agent-atoms.ts:577` | §6.2 |
| `loadSnapshots` | `renderer/agent-atoms.ts:594` | §5.1 |
| `clearPermissionRequest` | `renderer/agent-atoms.ts:607` | §5.2 |
| `resetProjectState` | `renderer/agent-atoms.ts:622` | §6.2 |
| `App` / `AppRoutes` | `renderer/components/App.tsx:64 / 82` | §6.1 |
| `handleModeSelected` | `renderer/components/App.tsx:206` | §6.2 |
| `handleResumeProject` | `renderer/components/App.tsx:242` | §6.2 |
| `handleSendMessage` | `renderer/components/App.tsx:284` | §6.3 |
| `handleStopGeneration` | `renderer/components/App.tsx:322` | §6.3 |
| `handleCardOptionSelect` | `renderer/components/App.tsx:341` | §7.3 |
| `handleCollectDomContext` | `renderer/components/App.tsx:368` | §6.4 |
| `handleCorrectionSubmit` | `renderer/components/App.tsx:385` | §6.4 |
| `handleConfirmSketch` | `renderer/components/App.tsx:521` | §6.4 |
| `handleRollback` | `renderer/components/App.tsx:448` | §6.4 |
| `handleMarkComplete` | `renderer/components/App.tsx:547` | §6.4 |
| `handleUpgrade` / `handleConfirmUpgrade` | `renderer/components/App.tsx:574 / 578` | §6.4 |
| `restorePreview` | `renderer/components/App.tsx:137` | §6.4 |
| `useUserDecisionCards` | `renderer/components/ChatPanel-sprint2.tsx:144` | §7.1 |
| `extractDecisionCards` | `renderer/components/ChatPanel-sprint2.tsx:97` | §7.1 |
| `toCardSelectionMeta` | `renderer/components/ChatPanel-sprint2.tsx:170` | §7.2 |
| `resolveCardAnswer` | `main/guide-agent-service.ts:231` | §7.4 |
| `resolveAutoDelegation` | `main/guide-agent-service.ts:249` | §7.4 |
| `deriveToolCallRecords` | `renderer/components/ToolCallBlock.tsx:162` | §5.2/§8 |

