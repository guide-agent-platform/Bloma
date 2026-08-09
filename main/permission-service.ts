import { randomUUID } from 'node:crypto'
import type {
  PermissionRequest,
  PermissionResponseInput,
  PermissionResponseResult,
  PromaPermissionMode,
} from '../shared/types'

export interface PermissionResult {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  updatedPermissionMode?: PromaPermissionMode
}

const pendingRequests = new Map<string, {
  resolve: (result: PermissionResult) => void
  request: PermissionRequest
}>()
const sessionIndex = new Map<string, Set<string>>()

let requestPublisher: ((request: PermissionRequest) => void) | undefined

export function setPermissionRequestPublisher(publisher: (request: PermissionRequest) => void): void {
  requestPublisher = publisher
}

/**
 * 生产接线入口（A2-12）：在内部工具/IPC 通道执行前调用，返回 denied 时抛出
 * `PERMISSION_DENIED:<toolName>`。无人值守自动化管线显式传入 `allow-all` 豁免
 * UI 弹窗（warning 自动放行、dangerous 拒绝）；用户显式操作走 `ask` 完整流程。
 */
export async function assertToolAllowed(
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId: string,
  mode: PromaPermissionMode,
  projectId?: string,
): Promise<void> {
  const result = await canUseTool(toolName, toolInput, sessionId, mode, projectId)
  if (result.behavior === 'deny') throw new Error(`PERMISSION_DENIED:${toolName}`)
}

export async function canUseTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId: string,
  currentMode: PromaPermissionMode,
  projectId?: string,
): Promise<PermissionResult> {
  const dangerLevel = assessDanger(toolName, toolInput)

  if (dangerLevel === 'safe') return { behavior: 'allow' }
  if (currentMode === 'allow-all' && dangerLevel !== 'dangerous') return { behavior: 'allow' }
  if (currentMode === 'safe') return { behavior: 'deny' }

  const request: PermissionRequest = {
    id: randomUUID(),
    session_id: sessionId,
    project_id: projectId,
    tool_name: toolName,
    tool_input: toolInput,
    danger_level: dangerLevel,
    user_visible_summary: summarizeToolRequest(toolName, dangerLevel),
    created_at: new Date().toISOString(),
  }

  return new Promise<PermissionResult>((resolve) => {
    pendingRequests.set(request.id, { resolve, request })
    const existing = sessionIndex.get(request.session_id) ?? new Set<string>()
    existing.add(request.id)
    sessionIndex.set(request.session_id, existing)
    requestPublisher?.(request)
  })
}

export function resolvePermission(input: PermissionResponseInput): PermissionResponseResult {
  const entry = pendingRequests.get(input.permission_request_id)
  if (!entry || entry.request.session_id !== input.session_id) {
    throw new Error('PERMISSION_REQUEST_NOT_FOUND')
  }

  pendingRequests.delete(input.permission_request_id)
  sessionIndex.get(input.session_id)?.delete(input.permission_request_id)
  if (sessionIndex.get(input.session_id)?.size === 0) {
    sessionIndex.delete(input.session_id)
  }
  entry.resolve({ behavior: input.decision })
  return { resolved: true, permission_request_id: input.permission_request_id }
}

export function getPendingBySession(sessionId: string): PermissionRequest[] {
  return [...(sessionIndex.get(sessionId) ?? [])]
    .map((requestId) => pendingRequests.get(requestId)?.request)
    .filter((request): request is PermissionRequest => Boolean(request))
}

export function getPendingRequests(): PermissionRequest[] {
  return [...pendingRequests.values()].map((entry) => entry.request)
}

export function clearPendingRequests(): void {
  pendingRequests.clear()
  sessionIndex.clear()
}

/**
 * 工具权限分级唯一权威登记点（A2-13，决策 D2）：内部 service + MCP 兼容签名。
 * 所有 MCP 工具名称/默认等级在此对齐 api-spec §13 权限表。
 */
export const TOOL_PERMISSION_REGISTRY: Record<string, 'safe' | 'warning' | 'dangerous'> = {
  // 只读/分析（safe）
  Read: 'safe',
  Glob: 'safe',
  Grep: 'safe',
  TaskOutput: 'safe',
  TaskList: 'safe',
  collect_dom_context: 'safe',
  capture_preview: 'safe',
  run_gwt_tests: 'safe',
  run_security_scan: 'safe',
  // 写入/生成（warning）
  Write: 'warning',
  Edit: 'warning',
  generate_sketch: 'warning',
  generate_mvp: 'warning',
  create_project_sandbox: 'warning',
  create_snapshot: 'warning',
  run_project: 'warning',
  // 高风险（dangerous）
  rollback_snapshot: 'dangerous',
}

/** 用户可读的工具名，供权限对话框摘要展示（P0 可读语言）。 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  generate_sketch: '生成验证草图',
  generate_mvp: '生成 MVP 应用',
  run_project: '运行项目预览',
  create_snapshot: '创建项目快照',
  rollback_snapshot: '回滚到历史快照',
  run_gwt_tests: '运行功能测试',
  create_project_sandbox: '创建项目沙箱',
  Write: '写入文件',
  Edit: '修改文件',
  Bash: '执行命令',
}

function assessDanger(toolName: string, input: Record<string, unknown>): 'safe' | 'warning' | 'dangerous' {
  // 命令类工具：登记为 warning，但命中危险命令模式时升级为 dangerous
  if (toolName === 'Bash' || toolName === 'run_project') {
    const command = typeof input.command === 'string' ? input.command : ''
    if (/\brm\s+-rf\b|\bsudo\b|\bformat\b/i.test(command)) return 'dangerous'
    return TOOL_PERMISSION_REGISTRY[toolName] ?? 'warning'
  }
  return TOOL_PERMISSION_REGISTRY[toolName] ?? 'warning'
}

function summarizeToolRequest(toolName: string, dangerLevel: 'safe' | 'warning' | 'dangerous'): string {
  const name = TOOL_DISPLAY_NAMES[toolName] ?? toolName
  if (dangerLevel === 'dangerous') return `需要确认高风险操作：${name}`
  return `需要确认本地项目操作：${name}`
}
