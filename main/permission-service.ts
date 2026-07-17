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

let requestPublisher: ((request: PermissionRequest) => void) | undefined

export function setPermissionRequestPublisher(publisher: (request: PermissionRequest) => void): void {
  requestPublisher = publisher
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
    requestPublisher?.(request)
  })
}

export function resolvePermission(input: PermissionResponseInput): PermissionResponseResult {
  const entry = pendingRequests.get(input.permission_request_id)
  if (!entry || entry.request.session_id !== input.session_id) {
    throw new Error('PERMISSION_REQUEST_NOT_FOUND')
  }

  pendingRequests.delete(input.permission_request_id)
  entry.resolve({ behavior: input.decision })
  return { resolved: true, permission_request_id: input.permission_request_id }
}

export function getPendingRequests(): PermissionRequest[] {
  return [...pendingRequests.values()].map((entry) => entry.request)
}

export function clearPendingRequests(): void {
  pendingRequests.clear()
}

const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'TaskOutput', 'TaskList', 'collect_dom_context', 'capture_preview', 'run_gwt_tests', 'run_security_scan'])

function assessDanger(toolName: string, input: Record<string, unknown>): 'safe' | 'warning' | 'dangerous' {
  if (READ_ONLY_TOOLS.has(toolName)) return 'safe'
  if (toolName === 'rollback_snapshot') return 'dangerous'
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'generate_sketch' || toolName === 'generate_mvp') return 'warning'
  if (toolName === 'Bash' || toolName === 'run_project') {
    const command = typeof input.command === 'string' ? input.command : ''
    if (/\brm\s+-rf\b|\bsudo\b|\bformat\b/i.test(command)) return 'dangerous'
    return 'warning'
  }
  if (toolName === 'create_project_sandbox' || toolName === 'create_snapshot') return 'warning'
  return 'warning'
}

function summarizeToolRequest(toolName: string, dangerLevel: 'safe' | 'warning' | 'dangerous'): string {
  if (dangerLevel === 'dangerous') return `需要确认高风险工具操作：${toolName}`
  return `需要确认本地项目操作：${toolName}`
}
