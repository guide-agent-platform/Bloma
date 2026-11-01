/**
 * IPC 共享件（PR4d 自 ipc.ts 拆出）：errorCodeFrom 错误码映射 + 各族共用助手
 * （校验器/requireFields/extractRequestId/resolvePermissionSession/纠错话术提取）。纯机械搬移。
 * 死 import 尸块已清（2026-10-03 审查卫生批——拆分残留的 147 个未用符号）。
 */
import type {
  AgentCancelInput,
  AgentConfirmRequirementsInput,
  AgentSendMessageInput,
  PermissionResponseInput,
  ProjectCreateInput,
} from '../../shared/types'
import { fail, ok } from '../../shared/api-result'
import { hasRequestId, isRecord, requireValue } from '../../shared/validators'
import { findProject } from '../project/project-service'

export function requireFields<T extends { request_id: string }>(payload: unknown, fields: string[]): T {
  if (!isRecord(payload)) throw new Error('Invalid payload: expected object')
  if (!hasRequestId(payload)) throw new Error('Missing required field: request_id')
  for (const field of fields) requireValue(payload, field)
  return payload as T
}


export function errorCodeFrom(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const match = /^([A-Z][A-Z0-9_]*):/.exec(message)
  return match ? match[1] : 'AGENT_SDK_ERROR'
}


export async function safeInvoke<T>(requestId: string, fn: () => T | Promise<T>) {
  try {
    return ok(requestId, await fn())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 兜底前先把真实错误打到主进程终端，避免被 VALIDATION_ERROR 掩盖而无法排查
    console.error('[ipc] handler error:', message, error)
    if(message.includes('PROJECT_NOT_DELIVERED'))return fail<T>(requestId,'PROJECT_NOT_DELIVERED',message)
    if (message.includes('AGENT_SESSION_BUSY')) return fail<T>(requestId, 'AGENT_SESSION_BUSY', message, true)
    // 全链路审查 P1-1（2026-10-01）：项目锁冲突不得落 VALIDATION_ERROR 静默——与 SESSION_BUSY
    // 同级映射（retryable），渲染端可引导等待/停止而非石沉大海。
    if (message.includes('AGENT_PROJECT_BUSY')) return fail<T>(requestId, 'AGENT_PROJECT_BUSY', message, true)
    if (message.includes('CHANNEL_NOT_FOUND')) return fail<T>(requestId, 'CHANNEL_NOT_FOUND', message)
    if (message.includes('SESSION_NOT_FOUND')) return fail<T>(requestId, 'SESSION_NOT_FOUND', message)
    if (message.includes('SESSION_FORK_ENTRY_NOT_FOUND')) {
      return fail<T>(requestId, 'SESSION_FORK_ENTRY_NOT_FOUND', message)
    }
    if (message.includes('PROJECT_NOT_FOUND')) return fail<T>(requestId, 'PROJECT_NOT_FOUND', message)
    if (message.includes('PERMISSION_REQUEST_NOT_FOUND')) return fail<T>(requestId, 'PERMISSION_REQUEST_NOT_FOUND', message)
    if (message.includes('PERMISSION_DENIED')) return fail<T>(requestId, 'PERMISSION_DENIED', message)
    if (message.includes('SANDBOX_RUN_FAILED')) {
      return fail<T>(requestId, 'SANDBOX_RUN_FAILED', message, true, {
        category: message.split(':')[1] ?? 'unknown',
      })
    }
    if (message.includes('SNAPSHOT_CREATE_FAILED')) return fail<T>(requestId, 'SNAPSHOT_CREATE_FAILED', message, true)
    if (message.includes('DOCUMENT_SYNC_FAILED')) return fail<T>(requestId, 'DOCUMENT_SYNC_FAILED', message, true)
    if (message.includes('ANALYTICS_WRITE_FAILED')) return fail<T>(requestId, 'ANALYTICS_WRITE_FAILED', message, true)
    // safeStorage 解密失败等：不要伪装成「缺少必要信息」，落到专用 code
    if (message.includes('safeStorage') || message.includes('decrypt') || message.includes('API_KEY_DECRYPT_FAILED')) {
      return fail<T>(requestId, 'API_KEY_DECRYPT_FAILED', message)
    }
    return fail<T>(requestId, 'VALIDATION_ERROR', message)
  }
}

export function validateAgentSend(payload: unknown): AgentSendMessageInput {
  // request_id 必填：message-queue 用它作 queueMessageId 去重键（审查 P2-③：缺省会被 undefined 误判重复丢消息）
  const input = requireFields<AgentSendMessageInput>(payload, ['request_id', 'session_id', 'project_id', 'content', 'mode', 'current_stage'])
  // clipboard-paste P1（2026-08-29）：可选 images 结构校验——存在则必须为合法引用数组（消费端另有过滤）
  if (input.images !== undefined) {
    if (!Array.isArray(input.images)) throw new Error('PASTED_IMAGE_BAD_REFS: images 必须为数组')
    for (const r of input.images) {
      if (!r || typeof r.imageId !== 'string' || typeof r.media_type !== 'string') {
        throw new Error('PASTED_IMAGE_BAD_REFS: images 元素必须含 imageId/media_type 字符串')
      }
    }
  }
  return input
}

export function validateCancel(payload: unknown): AgentCancelInput {
  return requireFields<AgentCancelInput>(payload, ['session_id', 'reason'])
}

export function validateConfirmRequirements(payload: unknown): AgentConfirmRequirementsInput {
  const input = requireFields<AgentConfirmRequirementsInput>(payload, ['session_id', 'project_id', 'decision'])
  if (input.decision !== 'confirm' && input.decision !== 'delegate') {
    throw new Error('decision must be confirm or delegate')
  }
  // adopted_ideas：可选字符串数组（用户勾选采纳的市调想法原文），非数组/含非字符串项时剔除
  if (input.adopted_ideas !== undefined) {
    if (!Array.isArray(input.adopted_ideas)) {
      delete input.adopted_ideas
    } else {
      input.adopted_ideas = input.adopted_ideas.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    }
  }
  return input
}

export function validatePermissionResponse(payload: unknown): PermissionResponseInput {
  return requireFields<PermissionResponseInput>(payload, ['permission_request_id', 'session_id', 'decision'])
}

export function validateProjectCreate(payload: unknown): ProjectCreateInput {
  const input = requireFields<ProjectCreateInput>(payload, ['mode'])
  if (input.mode !== 'quick' && input.mode !== 'longterm') throw new Error('mode must be quick or longterm')
  return input
}

export function extractRequestId(payload: unknown): string {
  return hasRequestId(payload) ? payload.request_id : ''
}

/** IPC 层权限门禁的会话标识：优先取项目最近会话，缺失时退化为 project_id。 */
export function resolvePermissionSession(projectId: string): string {
  try {
    return findProject(projectId).last_session_id ?? projectId
  } catch {
    return projectId
  }
}


