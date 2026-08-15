# API 接口规范

> 项目：向导 Agent 多智能体协同开发平台  
> 文档ID：DOC-4.1  
> 版本：v1.1 | 日期：2026-07-10 | 状态：已确认  
> 依赖：DOC-3.1 `architecture.md`、DOC-3.2 `component-design.md`、DOC-3.4 `data-model.md`、`proma-core-demo`

---

## 1. 设计目标

本文档定义平台 Phase 1 的接口边界，覆盖：

- Electron IPC 四层接口。
- Renderer 暴露 API。
- Agent 流式事件。
- 工具权限请求与响应。
- 软件生成 MCP 工具。
- 沙箱、快照、文档、埋点接口。
- 统一错误码。

所有接口必须遵守 Proma core 约束：

- 通道名和类型定义在 `shared/types.ts`，作为单一真相源。
- Renderer 只能通过 `preload/bridge.ts` 暴露的 `window.electronAPI` 调用能力。
- API Key 只在 main 进程解密，不进入 renderer。
- Agent 事件通过 IPC 推送到 Jotai `atomFamily(sessionId)`。
- 运行时持久化只写入 `~/.proma/` 下的 JSON、JSONL 和工作区文件目录。

---

## 2. 命名约定

### 2.1 IPC Channel 命名

```ts
const IPC_CHANNELS = {
  AGENT_SEND_MESSAGE: "agent:send-message",
  AGENT_STOP: "agent:stop",
  AGENT_STREAM_EVENT: "agent:stream-event",
  PERMISSION_RESPONSE: "permission:response",
  PROJECT_CREATE: "project:create",
  PROJECT_LIST: "project:list",
  PROJECT_CONFIRM_SKETCH: "project:confirm-sketch",
  PROJECT_SUBMIT_CORRECTION: "project:submit-correction",
  PROJECT_ARCHIVE: "project:archive",
  PROJECT_UNARCHIVE: "project:unarchive",
  PROJECT_DELETE: "project:delete",
  PROJECT_UPGRADE: "project:upgrade",
  SANDBOX_RUN: "sandbox:run",
  SANDBOX_STOP: "sandbox:stop",
  SNAPSHOT_CREATE: "snapshot:create",
  SNAPSHOT_ROLLBACK: "snapshot:rollback",
  DOCUMENT_SYNC: "document:sync",
  ANALYTICS_TRACK: "analytics:track"
} as const;
```

规则：

- channel 字符串只允许定义在 `shared/types.ts`。
- main/preload/renderer 只能引用常量。
- 所有 invoke payload 必须带 `request_id`，便于追踪和错误定位。
- 所有 Agent 相关请求必须带 `session_id`。

---

## 3. 通用类型

### 3.1 `ApiResult<T>`

```ts
type ApiResult<T> =
  | {
      ok: true;
      request_id: string;
      data: T;
    }
  | {
      ok: false;
      request_id: string;
      error: ApiError;
    };
```

### 3.2 `ApiError`

```ts
type ApiError = {
  code: ErrorCode;
  message: string;
  user_visible_message?: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};
```

规则：

- `message` 面向开发者。
- `user_visible_message` 面向 P0 用户，不能包含堆栈、HTTP 状态码、函数名。
- renderer 默认只展示 `user_visible_message`。

### 3.3 基础枚举

```ts
type ProjectMode = "quick" | "longterm";
type WorkflowStage =
  | "choosing_mode"
  | "clarifying"
  | "generating_sketch"
  | "sketch_ready"
  | "generating_mvp"
  | "testing"
  | "judge_review"
  | "repairing"
  | "ready"
  | "iterating"
  | "completed"
  | "upgrading"
  | "blocked_for_user_decision";

type SnapshotKind =
  | "sketch"
  | "mvp"
  | "iteration"
  | "pre_risk"
  | "upgrade"
  | "rollback_guard";
```

---

## 4. Renderer Bridge API

`preload/bridge.ts` 只暴露以下白名单 API：

```ts
type ElectronAPI = {
  agent: {
    sendMessage(input: AgentSendMessageInput): Promise<ApiResult<AgentSendMessageResult>>;
    cancel(input: AgentCancelInput): Promise<ApiResult<AgentCancelResult>>;
    onStreamEvent(listener: (event: AgentEvent) => void): Unsubscribe;
  };
  permissions: {
    respond(input: PermissionResponseInput): Promise<ApiResult<PermissionResponseResult>>;
  };
  project: {
    create(input: ProjectCreateInput): Promise<ApiResult<Project>>;
    confirmSketch(input: ConfirmSketchInput): Promise<ApiResult<Project>>;
    submitCorrection(input: PointCorrectionInput): Promise<ApiResult<RevisionAccepted>>;
    upgrade(input: ProjectUpgradeInput): Promise<ApiResult<Project>>;
  };
  sandbox: {
    run(input: SandboxRunInput): Promise<ApiResult<SandboxRunResult>>;
    stop(input: SandboxStopInput): Promise<ApiResult<SandboxStopResult>>;
  };
  snapshots: {
    create(input: SnapshotCreateInput): Promise<ApiResult<Snapshot>>;
    rollback(input: SnapshotRollbackInput): Promise<ApiResult<RollbackResult>>;
  };
  documents: {
    sync(input: DocumentSyncInput): Promise<ApiResult<DocumentSyncResult>>;
  };
  analytics: {
    track(input: AnalyticsTrackInput): Promise<ApiResult<AnalyticsTrackResult>>;
  };
};
```

禁止项：

- 不暴露 `fs`、`path`、`child_process`。
- 不暴露明文 API Key。
- 不允许 renderer 自己构造 SDK env。
- 不允许 renderer 直接写 `~/.proma/`。

---

## 5. Agent IPC

### 5.1 `agent:send-message`

用途：用户提交自然语言消息，启动或继续 Agent 流。

```ts
type AgentSendMessageInput = {
  request_id: string;
  session_id: string;
  project_id: string;
  content: string;
  mode: ProjectMode;
  current_stage: WorkflowStage;
  channel_id?: string;
  metadata?: {
    source: "chat" | "card_option" | "system_resume";
    selected_option_id?: string;
  };
};

type AgentSendMessageResult = {
  accepted: true;
  session_id: string;
  stream_started: boolean;
};
```

主进程处理：

1. 校验 payload。
2. 检查 `activeSessions`，同一 `session_id` 正在运行时返回 `AGENT_SESSION_BUSY`。
3. 将用户消息追加写入 `agent-sessions/{session_id}.jsonl`。
4. 读取渠道配置并用 `safeStorage` 解密 API Key。
5. merge `process.env` 构建 SDK env。
6. 调用 `sdk.query()`。
7. 将 `SDKMessage` 转为 `AgentEvent` 推送。

### 5.2 `agent:stream-event`

用途：main 进程向 renderer 推送 Agent 流式事件。

```ts
type AgentEvent = {
  event_id: string;
  session_id: string;
  project_id?: string;
  type:
    | "message_delta"
    | "message_completed"
    | "stage_changed"
    | "tool_call_started"
    | "tool_call_completed"
    | "permission_requested"
    | "sketch_ready"
    | "mvp_ready"
    | "repairing"
    | "rollback_done"
    | "judge_result"
    | "user_decision_required"
    | "error"
    | "completed";
  payload: Record<string, unknown>;
  created_at: string;
};
```

renderer 规则：

- `useGlobalAgentListeners` 必须在应用根层挂载。
- 事件按 `session_id` 写入 `agentStreamStateFamily(sessionId)`。
- 页面切换不得清空未完成流。

### 5.3 `agent:cancel`

```ts
type AgentCancelInput = {
  request_id: string;
  session_id: string;
  reason: "user_cancelled" | "route_change" | "shutdown";
};

type AgentCancelResult = {
  cancelled: boolean;
  session_id: string;
};
```

主进程必须触发 SDK iterator cleanup，并释放 `activeSessions`。

### 5.4 `agent:list-sessions`

用途：列出历史会话索引（支持按项目过滤），用于"回访恢复"时选择最近会话。

```ts
type AgentListSessionsInput = {
  request_id: string;
  project_id?: string;
};

type AgentSessionRecord = {
  session_id: string;
  project_id: string;
  summary?: string;
  status: "active" | "waiting_for_user" | "completed";
  jsonl_path: string;
  created_at: string;
  updated_at: string;
};

type AgentListSessionsResult = {
  sessions: AgentSessionRecord[];
};
```

存储：

- 读取 `~/.proma/agent-sessions.json` 索引。
- 会话索引由 `agent:send-message` 每次运行时维护（创建或更新记录，并回填 `Project.last_session_id`）。
- 按 `updated_at` 倒序返回。

### 5.5 `agent:load-messages`

用途：读取指定会话的历史消息（尾部截取），用于回访恢复时填充对话区。

```ts
type AgentLoadMessagesInput = {
  request_id: string;
  session_id: string;
  limit?: number;          // 返回最近 N 条，缺省 200
  exclude_terminal?: boolean; // 排除内部终态标记（[terminal] 行），缺省 true
};

type AgentLoadMessagesResult = {
  session: AgentSessionRecord;
  messages: AgentMessage[];
  total: number;      // 过滤后可用消息总数
  truncated: boolean; // true 表示存在被截断的早期消息
};
```

存储：

- 读取 `~/.proma/agent-sessions/{session_id}.jsonl`。
- JSONL 不存在时返回 `SESSION_NOT_FOUND`。
- JSONL 存在但索引缺失（升级前遗留数据）时按文件 mtime 合成会话记录，不阻塞读取。

---

## 6. 权限接口

### 6.1 PermissionRequest

权限请求由 main 进程创建，经 `agent:stream-event` 推送到 renderer。

```ts
type PermissionRequest = {
  id: string;
  session_id: string;
  project_id?: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  danger_level: "safe" | "warning" | "dangerous";
  user_visible_summary: string;
  created_at: string;
};
```

### 6.2 `permission:response`

```ts
type PermissionResponseInput = {
  request_id: string;
  permission_request_id: string;
  session_id: string;
  decision: "allow" | "deny";
  remember_for_session?: boolean;
};

type PermissionResponseResult = {
  resolved: true;
  permission_request_id: string;
};
```

主进程规则：

- `pendingRequests` 为 `Map<permission_request_id, { resolve, request }>`。
- UI 响应后取出 resolve，完成 SDK `canUseTool()`。
- resolve 后必须删除 Map 项。
- 过期或不存在的请求返回 `PERMISSION_REQUEST_NOT_FOUND`。

---

## 7. 项目接口

### 7.1 `project:create`

```ts
type ProjectCreateInput = {
  request_id: string;
  mode: ProjectMode;
  initial_message?: string;
};

type Project = {
  project_id: string;
  workspace_slug: string;
  name: string;
  mode: ProjectMode;
  current_stage: WorkflowStage;
  root_path: string;
  current_snapshot_id?: string;
  created_at: string;
  updated_at: string;
};
```

存储：

- 创建项目索引 JSON。
- 创建 `generated-projects/{project_id}`。
- 创建 `documents/{project_id}`。
- 创建 `snapshots/{project_id}`。

### 7.2 `project:list`

```ts
type ProjectListInput = {
  request_id: string;
  scope?: "active" | "archived" | "all"; // 默认 active
};

// 按视角返回项目列表：active 过滤归档，archived 只回归档，all 返回全部（活动项目优先）
type ProjectListResult = Project[];
```

存储：

- 读取项目索引 JSON。
- 按 `scope` 过滤：`active`（默认）过滤 `status === "archived"`；`archived` 只返回 `status === "archived"`；`all` 返回全部。活动项目排在前面。

用途：应用启动时恢复活动项目与会话（scope 默认 active），避免重启后回到两道门；历史列表页「已归档」视角使用 scope=archived。

### 7.3 `project:archive`

```ts
type ProjectArchiveInput = {
  request_id: string;
  project_id: string;
};

// 归档项目：status 置为 "archived"，从活动列表隐藏
type ProjectArchiveResult = Project;
```

存储：

- 更新项目索引 JSON，将 `status` 置为 `archived`。
- 追加 `project_archived` 事件到项目 `events.jsonl`。

用途：历史项目列表提供"归档"操作，归档后不再出现在 `project:list` 返回中。

### 7.4 `project:unarchive`

```ts
type ProjectUnarchiveInput = {
  request_id: string;
  project_id: string;
};

// 取消归档：status 恢复为 "active"，重新出现在 active 视角
type ProjectUnarchiveResult = Project;
```

存储：

- 更新项目索引 JSON，将 `status` 恢复为 `active`。

用途：历史项目列表「已归档」视角提供"恢复"操作，恢复后重新出现在 `project:list`（scope 默认 active）返回中。

### 7.5 `project:delete`

```ts
type ProjectDeleteInput = {
  request_id: string;
  project_id: string;
};

// 硬删除项目：索引条目 + 项目/文档/快照/事件文件 + 关联会话
type ProjectDeleteResult = { deleted: true };
```

存储与清理（迁移自 Proma `deleteAgentWorkspace` / `deleteConversation`）：

- 从项目索引 JSON 移除该条目并落盘（先索引后文件，rm 失败只残留无引用文件，不产生孤儿索引）。
- 从 `agent-sessions.json` 移除该项目的会话索引，并删除 `agent-sessions/{session_id}.jsonl`。
- 物理删除 `generated-projects/{project_id}`、`documents/{project_id}`、`snapshots/{project_id}`、`events/{project_id}.jsonl`。
- 路径安全防护：所有待删路径必须落在 workspace 根内，否则拒绝（`PROJECT_DELETE_PATH_SAFETY`）。
- 删除前主进程先 `stopSandbox` 停止该项目沙箱，避免 Windows 文件句柄占用。

用途：历史项目列表提供"删除"操作（UI 二次确认）。这是不可逆操作，会清掉用户生成的软件全部文件与对话记录。

### 7.6 `project:confirm-sketch`

```ts
type ConfirmSketchInput = {
  request_id: string;
  project_id: string;
  session_id: string;
  snapshot_id: string;
  decision: "accepted" | "needs_change";
  note?: string;
};
```

效果：

- `accepted`：阶段进入 `generating_mvp`。
- `needs_change`：生成 revision task。
- 决策追加写入 JSONL。

### 7.7 `project:submit-correction`

```ts
type PointCorrectionInput = {
  request_id: string;
  project_id: string;
  session_id: string;
  context: CorrectionContext;
  user_note?: string;
  mode: "user_note" | "guess";
};

type CorrectionContext = {
  element_selector?: string;
  text_content?: string;
  bounding_rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  screenshot_region_path?: string;
  fallback_mode: boolean;
};

type RevisionAccepted = {
  accepted: true;
  task_id: string;
};
```

---

## 8. 沙箱接口

### 8.1 `sandbox:run`

```ts
type SandboxRunInput = {
  request_id: string;
  project_id: string;
  command?: string;
  timeout_ms?: number;
};

type SandboxRunResult = {
  status: "running" | "failed";
  preview_url?: string;
  port?: number;
  error_summary?: SandboxErrorSummary;
};
```

### 8.2 `sandbox:stop`

```ts
type SandboxStopInput = {
  request_id: string;
  project_id: string;
};

type SandboxStopResult = {
  stopped: boolean;
};
```

沙箱规则：

- 只能运行 `generated-projects/{project_id}` 内的代码。
- 运行日志内部保留，P0 用户默认不可见。
- 预览 iframe/WebView 必须限制顶部导航和原生弹窗。

---

## 9. 快照接口

### 9.1 `snapshot:create`

```ts
type SnapshotCreateInput = {
  request_id: string;
  project_id: string;
  kind: SnapshotKind;
  summary: string;
  include_documents: boolean;
  health_status: "healthy" | "unhealthy";
};

type Snapshot = {
  snapshot_id: string;
  project_id: string;
  kind: SnapshotKind;
  name: string;
  summary: string;
  screenshot_path?: string;
  files_archive_path: string;
  documents_archive_path?: string;
  health_status: "healthy" | "unhealthy";
  parent_snapshot_id?: string;
  created_at: string;
};
```

### 9.2 `snapshot:rollback`

```ts
type SnapshotRollbackInput = {
  request_id: string;
  project_id: string;
  snapshot_id: string;
  reason: "user_undo" | "repair_fuse" | "upgrade_failed";
};

type RollbackResult = {
  rolled_back: true;
  project_id: string;
  current_snapshot_id: string;
  guard_snapshot_id: string;
  preview_url?: string;
};
```

回滚事务：

1. 锁定项目写入。
2. 创建 `rollback_guard` 快照。
3. 恢复目标快照文件。
4. 更新项目当前快照指针。
5. 重启沙箱预览。
6. 追加回滚事件到 JSONL。

---

## 10. 文档接口

### 10.1 `document:sync`

```ts
type DocumentSyncInput = {
  request_id: string;
  project_id: string;
  session_id: string;
  checkpoint:
    | "sketch_confirmed"
    | "mvp_before_generation"
    | "mvp_tested"
    | "iteration_completed"
    | "mode_upgraded";
  changed_files?: string[];
};

type DocumentSyncResult = {
  documents: DocumentRef[];
  stale_documents: DocumentRef[];
};

type DocumentRef = {
  document_id: string;
  type: "prd" | "user_story" | "plantuml" | "gwt_feature" | "test_report" | "changelog";
  path: string;
  status: "draft" | "synced" | "stale" | "confirmed";
};
```

规则：

- 文档正文写入 `documents/{project_id}`。
- 文档索引写 JSON。
- 长期迭代型必须同步 PlantUML 和 Sprint 相关文档。

---

## 11. 埋点接口

### 11.1 `analytics:track`

```ts
type AnalyticsTrackInput = {
  request_id: string;
  event: AnalyticsEventInput;
};

type AnalyticsEventInput = {
  event_type:
    | "project_created"
    | "conversation_submitted"
    | "guide_role_switched"
    | "sketch_generated"
    | "mvp_delivered"
    | "user_undo"
    | "point_correction"
    | "mode_upgraded"
    | "programming_execution"
    | "self_repair_triggered"
    | "judge_verdict"
    | "satisfaction_marked"
    | "project_finalized";
  project_id?: string;
  session_id?: string;
  payload: Record<string, unknown>;
  privacy_level: "raw" | "masked" | "research_safe";
};

type AnalyticsTrackResult = {
  recorded: true;
  event_id: string;
};
```

规则：

- 写入 `agent-workspaces/{workspace_slug}/analytics.jsonl`。
- 科研导出前必须脱敏。
- 不记录 API Key、真实业务 payload、完整堆栈。

---

## 12. MCP 工具接口

MCP 工具由 Agent SDK 在 main 进程侧调用，权限由 `PermissionService.canUseTool()` 控制。

### 12.1 `create_project_sandbox`

```json
{
  "input": {
    "project_id": "string",
    "template_type": "web_fullstack|desktop_tool|personal_tool|ai_app"
  },
  "output": {
    "root_path": "string",
    "created": true
  }
}
```

### 12.2 `generate_sketch`

```json
{
  "input": {
    "project_id": "string",
    "requirements": [{"id": "F-001", "description": "string"}],
    "max_pages": 3
  },
  "output": {
    "files": [{"path": "string", "content": "string"}],
    "run_command": "string",
    "summary": "string"
  }
}
```

### 12.3 `generate_mvp`

```json
{
  "input": {
    "project_id": "string",
    "prd_path": "string",
    "requirements": [{"id": "F-001", "description": "string"}],
    "template_type": "web_fullstack"
  },
  "output": {
    "files": [{"path": "string", "content": "string"}],
    "run_command": "string",
    "assumptions": ["string"],
    "risks": ["string"]
  }
}
```

### 12.4 `run_gwt_tests`

```json
{
  "input": {
    "project_id": "string",
    "feature_paths": ["string"]
  },
  "output": {
    "total_count": 12,
    "passed_count": 10,
    "failed_count": 2,
    "failure_summary": [{"scenario": "string", "reason": "string"}]
  }
}
```

### 12.5 `capture_preview`

```json
{
  "input": {
    "project_id": "string",
    "preview_url": "string",
    "region": {"x": 0, "y": 0, "width": 1024, "height": 768}
  },
  "output": {
    "screenshot_path": "string"
  }
}
```

### 12.6 `create_snapshot`

```json
{
  "input": {
    "project_id": "string",
    "kind": "sketch|mvp|iteration|pre_risk|upgrade|rollback_guard",
    "summary": "string"
  },
  "output": {
    "snapshot_id": "string",
    "files_archive_path": "string"
  }
}
```

### 12.7 `rollback_snapshot`

```json
{
  "input": {
    "project_id": "string",
    "snapshot_id": "string"
  },
  "output": {
    "rolled_back": true,
    "guard_snapshot_id": "string"
  }
}
```

### 12.8 `collect_dom_context`

```json
{
  "input": {
    "project_id": "string",
    "click": {"x": 120, "y": 240}
  },
  "output": {
    "element_selector": "string",
    "text_content": "string",
    "bounding_rect": {"x": 100, "y": 220, "width": 80, "height": 32},
    "fallback_mode": false
  }
}
```

### 12.9 `run_security_scan`

```json
{
  "input": {
    "project_id": "string",
    "root_path": "string"
  },
  "output": {
    "passed": true,
    "issues": [
      {
        "severity": "low|medium|high|critical",
        "category": "string",
        "user_visible_summary": "string"
      }
    ]
  }
}
```

---

## 13. 权限等级

| 工具 | 默认等级 | 说明 |
|---|---|---|
| `collect_dom_context` | safe | 只读预览上下文 |
| `capture_preview` | safe | 截取项目预览 |
| `run_gwt_tests` | safe | 只读测试执行 |
| `run_security_scan` | safe | 只读扫描 |
| `create_project_sandbox` | warning | 创建本地目录 |
| `generate_sketch` | warning | 写入项目文件 |
| `generate_mvp` | warning | 写入项目文件 |
| `run_project` | warning | 启动本地进程 |
| `create_snapshot` | warning | 写入快照文件 |
| `rollback_snapshot` | dangerous | 覆盖当前工作副本 |

规则：

- `safe` 可自动允许。
- `warning` 默认可在会话内记住。
- `dangerous` 必须明确用户确认，不能跨会话记住。

---

## 14. 错误码

```ts
type ErrorCode =
  | "VALIDATION_ERROR"
  | "IPC_CHANNEL_NOT_FOUND"
  | "AGENT_SESSION_BUSY"
  | "AGENT_SDK_ERROR"
  | "AGENT_SDK_TIMEOUT"
  | "AGENT_CANCELLED"
  | "CHANNEL_NOT_FOUND"
  | "API_KEY_DECRYPT_FAILED"
  | "PERMISSION_REQUEST_NOT_FOUND"
  | "PERMISSION_DENIED"
  | "PROJECT_NOT_FOUND"
  | "SANDBOX_CREATE_FAILED"
  | "SANDBOX_RUN_FAILED"
  | "SANDBOX_PERMISSION_DENIED"
  | "SNAPSHOT_CREATE_FAILED"
  | "SNAPSHOT_NOT_FOUND"
  | "ROLLBACK_FAILED"
  | "DOCUMENT_SYNC_FAILED"
  | "ANALYTICS_WRITE_FAILED"
  | "LOCAL_STORE_WRITE_FAILED";
```

| 错误码 | retryable | 用户可见文案 |
|---|:---:|---|
| `VALIDATION_ERROR` | 否 | “这次操作缺少必要信息，请再试一次。” |
| `AGENT_SESSION_BUSY` | 是 | “我还在处理上一条内容，请稍等一下。” |
| `AGENT_SDK_ERROR` | 是 | “刚才处理时遇到问题，我会换个方式继续。” |
| `AGENT_SDK_TIMEOUT` | 是 | “这一步等得有点久，我会重新尝试。” |
| `CHANNEL_NOT_FOUND` | 否 | “当前还没有可用的模型配置。” |
| `API_KEY_DECRYPT_FAILED` | 否 | “模型配置需要重新验证。” |
| `PERMISSION_DENIED` | 否 | “这个操作已取消，当前内容不会被改动。” |
| `SANDBOX_RUN_FAILED` | 是 | “预览暂时没有启动成功，我正在修复。” |
| `ROLLBACK_FAILED` | 是 | “回到旧版本时遇到问题，我会保留当前内容并继续处理。” |
| `LOCAL_STORE_WRITE_FAILED` | 是 | “本地保存失败，请检查磁盘空间后再试。” |

---

## 15. 修订记录

| 版本 | 日期 | 修订内容 |
|------|------|----------|
| v1.0 | 2026-07-10 | 首版，定义 IPC、Renderer Bridge、Agent 流、权限、项目、沙箱、快照、文档、埋点、MCP 工具和错误码 |
| v1.1 | 2026-07-10 | 按 `proma-core-demo` 对齐修订：IPC 通道 `AGENT_CANCEL` → `AGENT_STOP` 与 Proma 原版命名一致 |
| v1.2 | 2026-08-15 | 项目管理补全：新增 `project:unarchive`（取消归档）、`project:delete`（硬删除，含清理与路径安全防护）；`project:list` 增加 `scope`（active/archived/all）视角 |
