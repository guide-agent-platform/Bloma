/**
 * IPC 共享件（PR4d 自 ipc.ts 拆出）：errorCodeFrom 错误码映射 + 各族共用助手
 * （校验器/requireFields/extractRequestId/resolvePermissionSession/纠错话术提取）。纯机械搬移。
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dialog } from 'electron'
import type { BrowserWindow, IpcMain } from 'electron'
import type {
  AgentCancelInput,
  AgentConfirmRequirementsInput,
  AgentForkSessionInput,
  AgentListSessionsInput,
  AgentLoadMessagesInput,
  AgentSendMessageInput,
  AgentSteerQueryInput,
  AgentSteerResolveInput,
  AnalyticsTrackInput,
  CategoryRoutingUpdateEnvelope,
  CategoryRoutingRoleUpdateEnvelope,
  ChannelCreateEnvelope,
  ChannelDeleteEnvelope,
  ChannelTestEnvelope,
  ChannelTestDirectEnvelope,
  ChannelUpdateEnvelope,
  FetchModelsEnvelope,
  ConfirmSketchInput,
  DocumentListInput,
  DocumentReadInput,
  DocumentSyncInput,
  DomCollectContextInput,
  DomScrollPreviewInput,
  PermissionResponseInput,
  PastedImageSaveInput,
  PermissionSetModeInput,
  PointCorrectionInput,
  ProjectFileReadInput,
  PromptReadInput,
  PromptResetInput,
  PromptSaveInput,
  ProjectAbandonInput,
  ProjectArchiveInput,
  ProjectCreateInput,
  ProjectDeleteInput,
  ProjectExportInput,
  ProjectUpgradeExportInput,
  AppSwitchStateResult,
  ProjectFinalizeInput,
  ProjectListInput,
  ProjectReopenInput,
  ProjectRenameInput,
  ProjectUnarchiveInput,
  ProjectUpgradeInput,
  RequestEnvelope,
  SandboxRunInput,
  SandboxStopInput,
  SnapshotCreateInput,
  SnapshotDocumentListInput,
  SnapshotDocumentReadInput,
  SnapshotListInput,
  SnapshotRollbackInput,
  SnapshotScreenshotInput,
} from '../../shared/types'
import { IPC_CHANNELS } from '../../shared/types'
import { fail, ok } from '../../shared/api-result'
import { cancelAgent, getSdkQuery, hasForegroundRun, isSessionActive, persistSteerDeferredNotice, publishSteerStatusEvent, registerBackgroundRun, runAgent, setAgentStreamPublisher, unregisterBackgroundRun } from '../orchestration/orchestrator'
import { enqueueSteer, getSteerStatuses, pendingSteerCount, registerSteer, resolveSteer, setSteerStatusListener, steerConfirmEnabled } from '../agent/loop/steer-queue'
import { savePastedImage } from '../platform/shell/pasted-images'
import { collectDomContext, scrollPreview } from '../verification/dom-context'
import { clearPendingReviewAction, runAgentLoopPostTesting, runIterationTask, runMvpTask, setForegroundRunChecker, setProgrammingEventPublisher } from '../coding/programming-orchestrator'
import { handleAgentStreamEvent } from '../platform/shell/notifications'
import { assertToolAllowed, getPermissionMode, resolvePermission, setPermissionMode, setPermissionRequestPublisher } from '../agent/permissions/permission-service'
import {
  abandonProject,
  archiveProject,
  confirmSketch,
  createProject,
  deleteProject,
  finalizeProject,
  findProject,
  getProjectProgressSummary,
  listProjects,
  renameProject,
  reopenProject,
  submitCorrection,
  unarchiveProject,
  updateProject,
  upgradeProject,
} from '../project/project-service'
import { cleanOrphanSessions, forkFrom, listSessions, loadMessages, setSessionActiveChecker } from '../platform/sessions/session-service'
import { exportProjectHandoff } from '../delivery/project-export'
import { upgradeExport } from '../coding/export-manifest'
import { readExperimentSwitches } from '../platform/shell/experiment-switches'
import { dirname } from 'node:path'
import { resolveRequirementConfirm } from '../guide/guide-agent-service'
import { createChannel, deleteChannel, fetchModels, listChannels, testChannel, testChannelDirect, updateChannel } from '../platform/llm/channel-manager'
import {
  buildCategoryRoutingRoleViews,
  buildCategoryRoutingViews,
  updateCategoryRouting,
  updateCategoryRoutingRoles,
} from '../platform/llm/category-routing'
import { listPromptSlots, readPromptSlot, resetPromptSlot, savePromptSlot } from '../agent/prompting/prompt-service'
import { listDocuments, readDocument, syncDocuments, isPrdUserConfirmed } from '../project/document-engine'
import { isCircuitBreakSettled, convergeStageFromEvidence, evaluateDiskArtifact } from '../orchestration/recovery-service'
import { runSandbox, stopSandbox } from '../delivery/sandbox'
import { createSnapshot, listSnapshotDocuments, listSnapshots, loadSnapshotScreenshot, readSnapshotDocument, rollbackSnapshot } from '../delivery/snapshots'
import { trackAnalytics } from '../delivery/track-analytics'
import { hasRequestId, isRecord, requireValue } from '../../shared/validators'
import { getAgentSessionPath } from '../../storage/config-paths'
import { appendJsonLine } from '../../storage/json-store'
import { appendSessionMessage } from '../platform/sessions/session-tree'

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
    if (message.includes('AGENT_SESSION_BUSY')) return fail<T>(requestId, 'AGENT_SESSION_BUSY', message, true)
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

/** 圈选目标文本过长截断，避免整段页面文案灌进归一化 prompt。 */
export const MAX_CORRECTION_TARGET_LEN = 80

/**
 * 从点选纠错入参提取可执行的修改诉求；无明确文案（纯猜模式）返回 undefined（只落盘不重生成）。
 *
 * 圈选 DOM 上下文（text_content / element_selector）必须拼进诉求文本：否则归一化模型
 * 只看到「换个名字」这种无目标文本，无法判定 revise，只能 skip——但 ack 又按已采纳回复，
 * 用户体感「我说改名它说改了结果没改」（2026-08-29 线上案例：圈选标题说「换个名字」）。
 *
 * 形态：
 * - user_note 模式："用户圈选了预览界面上的「<text>」（selector: <sel>），并说：<note>"；
 *   无 DOM 上下文时回退 note 原文（兼容旧测试与纯坐标兜底）；
 * - guess 模式（无 note）：元素文本是「被圈对象」不是修改诉求，不能原样当诉求（会被归一化
 *   当成新需求 append），改带「希望调整这个元素」语义；无 text_content 时返回 undefined。
 */
export function extractCorrectionPrompt(input: PointCorrectionInput): string | undefined {
  const note = input.user_note?.trim()
  const textContent = input.context?.text_content?.trim()
  const selector = input.context?.element_selector?.trim()
  const targetText = textContent || selector
  const targetDesc = targetText
    ? `预览界面上的「${truncateForCorrection(targetText, MAX_CORRECTION_TARGET_LEN)}」${textContent && selector ? `（selector: ${selector}）` : ''}`
    : undefined
  if (note) return targetDesc ? `用户圈选了${targetDesc}，并说：${note}` : note
  if (textContent) return `用户圈选了${targetDesc}，未填写具体说明，希望调整这个元素`
  return undefined
}

export function truncateForCorrection(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

export function requireFields<T extends { request_id: string }>(payload: unknown, fields: string[]): T {
  if (!isRecord(payload)) throw new Error('Invalid payload: expected object')
  if (!hasRequestId(payload)) throw new Error('Missing required field: request_id')
  for (const field of fields) requireValue(payload, field)
  return payload as T
}

