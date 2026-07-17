# 向导 Agent 多智能体协同开发平台 - Sprint 0

本仓库是基于 `proma-core-demo` 扩展的 Sprint 0 工程底座，聚焦角色 A 的交付边界：IPC 四层链路、Local-First 存储、safeStorage wrapper、AgentOrchestrator 基础守卫、权限服务和测试入口。

## 已实现范围

- `shared/types.ts`：Phase 1 IPC channel 单一真相源、`ApiResult<T>`、Agent/Project/Sandbox/Snapshot/Document/Analytics 类型。
- `main/ipc.ts`：Electron main 进程 handler 骨架，所有 invoke 统一参数校验并返回 `ApiResult<T>`。
- `preload/bridge.ts`：只暴露 `window.electronAPI` 白名单 API，不暴露 `fs`、`path`、`child_process`、`ipcRenderer`。
- `renderer/agent-atoms.ts`：Jotai `atomFamily(session_id)` 流式状态、全局监听器、权限请求按 session 分组。
- `main/orchestrator.ts`：同 session 并发守卫、SDK env merge、取消/清理、AgentEvent 转换、JSONL partial persistence。
- `main/permission-service.ts`：`canUseTool()` + `pendingRequests Map` + UI 决策回传模式。
- `storage/config-paths.ts`：`PROMA_HOME` 优先的 Local-First JSON/JSONL/工作区目录。
- `main/safe-storage.ts` / `main/channel-manager.ts`：API Key 只在 main 进程通过 Electron safeStorage 加解密，返回 UI 前脱敏。
- `tests/`：给 C 接入的单元/集成测试骨架，覆盖 core boundary、临时 `PROMA_HOME`、env merge、JSONL、权限服务。

## 运行命令

```bash
npm.cmd install --ignore-scripts
npm.cmd run typecheck
npm.cmd run test:unit
npm.cmd run test:integration
npm.cmd run docs:check
```

说明：本轮验证使用 `--ignore-scripts`，因为 Electron 安装脚本下载二进制时可能受网络影响。正式运行 Electron 壳时需要重新执行完整安装。

## B 角色接入点

- `window.electronAPI.agent.sendMessage/cancel/onStreamEvent`
- `window.electronAPI.permissions.respond`
- `window.electronAPI.project.*`
- `window.electronAPI.sandbox.*`
- `window.electronAPI.snapshots.*`
- `window.electronAPI.documents.sync`
- `window.electronAPI.analytics.track`
- `renderer/agent-atoms.ts` 中的 `agentStreamStateFamily(sessionId)`、`pendingPermissionRequestsAtom`

## C 角色接入点

- `tests/integration/proma-core-boundary.test.ts`
- `tests/integration/local-first.test.ts`
- `tests/unit/orchestrator.test.ts`
- `tests/unit/permission-service.test.ts`
- `scripts/docs-check.mjs`

后续 GWT/E2E 可在此基础上接入 `features/proma-core-boundary.feature`、`mode-selection.feature` 和主链路场景。
