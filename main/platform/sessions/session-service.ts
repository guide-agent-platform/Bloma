/**
 * SessionService — 会话索引与历史消息读取
 *
 * 补齐"历史对话管理"缺失的读取半边：
 * - `agent-sessions/{session_id}.jsonl` 的写入在 orchestrator.ts（单向），
 *   本模块负责 `agent-sessions.json` 索引的维护与读取。
 * - `recordSessionActivity()` 在每次 Agent 运行时调用，更新会话索引，
 *   并 best-effort 回填 `Project.last_session_id`（项目不存在时静默跳过，
 *   兼容测试与演示环境）。
 * - `listSessions()` / `loadMessages()` 供新 IPC 通道
 *   `agent:list-sessions` / `agent:load-messages` 调用。
 *
 * 对齐：shared/types.ts §6.5、DOC-3.4 data-model.md §5 Session / §6 Message
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { rmSyncWithRetry } from '../storage/fs-retry'
import type {
  AgentForkSessionResult,
  AgentListSessionsInput,
  AgentListSessionsResult,
  AgentLoadMessagesInput,
  AgentLoadMessagesResult,
  AgentMessage,
  AgentSessionRecord,
  SessionCleanOrphansResult,
} from '../../../shared/types'
import { getAgentSessionPath, getAgentSessionsIndexPath, getPromaHome } from '../../../storage/config-paths'
import { readJsonFile, writeJsonFile } from '../../../storage/json-store'
import { appendSessionMessage } from './session-tree'

/**
 * 会话活跃检查器（P0-2 fork 的 BUSY 判定）：由 ipc 层接线注入 orchestrator.isSessionActive
 * ——session-service 不反向 import orchestrator（两模块互引会形成循环依赖，vitest 模块
 * 初始化序下破坏委派运行时状态）。缺省 false = 未接线环境（纯单测）不拒绝。
 */
let sessionActiveChecker: (sessionId: string) => boolean = () => false

export function setSessionActiveChecker(checker: (sessionId: string) => boolean): void {
  sessionActiveChecker = checker
}
import { listProjects, updateProject } from '../../project/project-service'
import { cleanupPastedImages } from '../shell/pasted-images'

interface SessionsIndex {
  version: number
  sessions: AgentSessionRecord[]
}

/**
 * 记录一次会话活动：创建/更新会话索引，并回填项目"最后活跃会话"。
 * 项目不存在（如测试中的字面 project_id）时静默跳过 last_session_id 回填。
 * delegationMeta（delegation-persistence 阶段 1，2026-08-28）：委派子会话首次记录时
 * 写入归属字段，重启后可按 delegationId 反查子会话 JSONL。
 */
export function recordSessionActivity(
  sessionId: string,
  projectId: string,
  delegationMeta?: { parentSessionId: string; sourceDelegationId?: string },
): void {
  const index = readSessions()
  const existing = index.sessions.find((item) => item.session_id === sessionId)
  const now = new Date().toISOString()

  if (existing) {
    existing.project_id = projectId
    existing.updated_at = now
  } else {
    index.sessions.push({
      session_id: sessionId,
      project_id: projectId,
      status: 'active',
      jsonl_path: getAgentSessionPath(sessionId),
      created_at: now,
      updated_at: now,
      ...(delegationMeta
        ? { parent_session_id: delegationMeta.parentSessionId, source_delegation_id: delegationMeta.sourceDelegationId }
        : {}),
    })
  }
  writeSessions(index)

  try {
    updateProject(projectId, { last_session_id: sessionId })
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('PROJECT_NOT_FOUND')) throw error
  }
}

/** 列出会话记录；可按项目过滤，按最近活跃时间倒序 */
export function listSessions(input: AgentListSessionsInput): AgentListSessionsResult {
  const sessions = readSessions().sessions
    // 委派子会话（source_delegation_id 非空：审查/协作的审计件）不是用户对话——不出现在
    // 会话列表（2026-09-19 实测 870 个子会话把列表刷成清一色「未命名对话」）。注意 fork
    // 分支会话也带 parent_session_id 但是真实用户对话，必须可见——判据用 source_delegation_id。
    // 子会话仍留在索引与磁盘，供审计回查（按 session_id 直读不受此过滤影响）。
    .filter((item) => !item.source_delegation_id)
    .filter((item) => !input.project_id || item.project_id === input.project_id)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  return { sessions }
}

/**
 * U11：清理孤儿会话——移除 project_id 已不在项目索引中的会话记录及其 JSONL 文件。
 * 归档项目仍存在于项目索引（可恢复），其会话历史必须保留，故不在此清理范围。
 * 只清理指向已删除/不存在项目的会话，以及空 project_id 的遗留会话。
 */
export function cleanOrphanSessions(): SessionCleanOrphansResult {
  const validIds = new Set(listProjects('all').map((project) => project.project_id))
  const index = readSessions()
  const orphans = index.sessions.filter((item) => !validIds.has(item.project_id))
  for (const orphan of orphans) {
    const jsonl = getAgentSessionPath(orphan.session_id)
    if (existsSync(jsonl)) rmSyncWithRetry(jsonl, { force: true })
    // 粘贴图清理（clipboard-paste P2 兑现，r73）：孤儿会话的粘贴图目录同步回收（幂等静默）
    cleanupPastedImages(orphan.session_id)
  }
  index.sessions = index.sessions.filter((item) => validIds.has(item.project_id))
  writeSessions(index)
  return { removed: orphans.length }
}

/**
 * 读取指定会话的 JSONL 历史消息。
 * 默认排除内部标记（`[terminal]` 终态行、`[decision-card]` 决策卡片选项行），支持尾部截取（limit）。
 * JSONL 存在但索引缺失时（升级前遗留数据），按文件 mtime 合成会话记录。
 */
export function loadMessages(input: AgentLoadMessagesInput): AgentLoadMessagesResult {
  const path = getAgentSessionPath(input.session_id)
  if (!existsSync(path)) throw new Error('SESSION_NOT_FOUND')

  const record = resolveSessionRecord(input.session_id, path)

  const excludeTerminal = input.exclude_terminal ?? true
  const limit = input.limit ?? 200

  const all = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line): AgentMessage | undefined => {
      try {
        return JSON.parse(line) as AgentMessage
      } catch {
        return undefined
      }
    })
    .filter((message): message is AgentMessage => {
      if (!message) return false
      // delegation-persistence（2026-08-28）：settle 行（终态标记，无 role）不是对话消息
      if ((message as unknown as Record<string, unknown>).delegation_settle) return false
      if (!excludeTerminal) return true
      const text = message.content?.find((block) => block.type === 'text')?.text ?? ''
      return !text.startsWith('[terminal]') && !text.startsWith('[decision-card]')
    })

  const total = all.length
  const messages = all.slice(Math.max(0, all.length - limit))
  return {
    session: record,
    messages,
    total,
    truncated: messages.length < total,
  }
}

/** 自由文本让渡长度上限：超过即视为含实际内容的话（「随便做个游戏」），不做让渡判定。 */
const AUTO_DELEGATION_MAX_LENGTH = 16

/** JSONL 行解析：损坏行跳过（与 loadMessages 同口径）。 */
function parseSessionLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line): Record<string, unknown> | undefined => {
      try {
        return JSON.parse(line) as Record<string, unknown>
      } catch {
        return undefined
      }
    })
    .filter((message): message is Record<string, unknown> => message !== undefined)
}

/** 目标锚点是否为可 fork 的 user 消息（非空文本/含 text 块）。 */
function isForkableUserMessage(line: Record<string, unknown>): boolean {
  if (line.role !== 'user') return false
  const content = line.content
  if (typeof content === 'string') return content.trim().length > 0
  if (Array.isArray(content)) {
    return content.some(
      (block) =>
        block && typeof block === 'object' && (block as { type?: unknown; text?: unknown }).type === 'text'
        && typeof (block as { text?: unknown }).text === 'string'
        && ((block as { text?: unknown }).text as string).trim().length > 0,
    )
  }
  return false
}

/**
 * 会话 fork（P0-2，2026-09-08 pi 差距方案 §2）：从源会话的某条 user 消息处重开——
 * 把「首行到该消息」的前缀原样复制进新会话文件（树链重写为线性 v2），原文件一字不动；
 * 索引登记新会话（parent_session_id = 源会话，fork_entry_id = 锚点行 id）。
 *
 * 锚点解析：entry_id（v2 行 id）优先；旧文件（无 id）按 entry_timestamp 定位。
 * 活跃会话拒绝（BUSY）——与 send-message 忙语义一致，防 fork 读到写一半的文件。
 */
export function forkFrom(
  sessionId: string,
  opts: { project_id: string; entry_id?: string; entry_timestamp?: number; new_session_id?: string },
): AgentForkSessionResult {
  if (sessionActiveChecker(sessionId)) throw new Error('AGENT_SESSION_BUSY')
  const sourcePath = getAgentSessionPath(sessionId)
  if (!existsSync(sourcePath)) throw new Error('SESSION_NOT_FOUND')
  const hasAnchor = (opts.entry_id !== undefined && opts.entry_id !== '') || typeof opts.entry_timestamp === 'number'
  if (!hasAnchor) throw new Error('SESSION_FORK_ENTRY_NOT_FOUND: 需要 entry_id 或 entry_timestamp')

  const lines = parseSessionLines(sourcePath)
  // 找锚点下标（升序遍历保「首个命中」语义，链上下文自然正确）
  let anchorIndex = -1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    if (opts.entry_id && line.id === opts.entry_id) {
      anchorIndex = i
      break
    }
    if (typeof opts.entry_timestamp === 'number' && line.timestamp === opts.entry_timestamp) {
      anchorIndex = i
      break
    }
  }
  if (anchorIndex < 0) throw new Error('SESSION_FORK_ENTRY_NOT_FOUND')
  const anchor = lines[anchorIndex]!
  if (!isForkableUserMessage(anchor)) throw new Error('SESSION_FORK_ENTRY_NOT_FOUND: fork 锚点必须是 user 文本消息')

  const newSessionId = opts.new_session_id ?? randomUUID()
  const prefix = lines.slice(0, anchorIndex + 1)
  for (const line of prefix) appendSessionMessage(newSessionId, line)

  recordSessionActivity(newSessionId, opts.project_id, { parentSessionId: sessionId, sourceDelegationId: undefined })
  // fork 归属补记：新记录追加 fork_entry_id（源锚点行 id；旧文件无 id 时为 undefined）
  const index = readSessions()
  const created = index.sessions.find((item) => item.session_id === newSessionId)
  if (created && typeof anchor.id === 'string') created.fork_entry_id = anchor.id
  if (created) writeSessions(index)

  return { new_session_id: newSessionId, forked: true, copied_messages: prefix.length }
}

/** 自由文本让渡话术判定：≤16 字且整句命中（人称前缀/语气词已归一）。供两处共用，改表须两侧同步：

/**
 * 自由文本让渡话术表（D1 修复）：「我还没想法/随便/你帮我决定」这类输入与点选
 * 「你帮我决定」卡片语义相同。整句命中才触发——人称前缀与语气词尾归一后全匹配，
 * 含实际内容的长句（「随便做个游戏」「帮我做个记账的」）不误伤。首版从宽，
 * 靠线上对话样本迭代（对齐行为断言词表的扩充思路）。
 */
const AUTO_DELEGATION_PATTERN =
  /^(?:还没想(?:法|好)?|没(?:有)?想法|没头绪|不知道(?:做|要)?什么|都(?:可以|行)|随便(?:来|做|弄|你|了)?|你(?:帮我)?决定|你来定|你看着办|听你的|交给你们?|帮我(?:挑|选)(?:一个|一下)?|无所谓)$/

/**
 * 让渡话术判定：≤16 字且整句命中（人称前缀/语气词已归一）。供两处共用，改表须两侧同步：
 * - guide-agent-service 自由文本让渡分流（resolveAutoDelegation）
 * - readPrimaryIntent 主题锚点豁免（让渡话术不承载主题）
 */
export function isAutoDelegationText(content: string): boolean {
  const trimmed = content.trim()
  if (trimmed.length === 0 || trimmed.length > AUTO_DELEGATION_MAX_LENGTH) return false
  const normalized = trimmed
    .replace(/^(?:我|我们|咱们)/, '')
    .replace(/(?:了|呢|啊|呀|吧|呗|哦|哈)+[。.!！~～\s]*$/, '')
  return AUTO_DELEGATION_PATTERN.test(normalized)
}

/**
 * 纯问候语（D4 修复）：整句命中才跳过，「你好，我想做个记账本」承载主题、必须保留。
 * 问候语不承载任何产品信息，若被当成主题锚点前置 F-001，会把真正的需求挤到 F-002。
 */
const GREETING_ONLY_PATTERN =
  /^(?:(?:你|您)好(?:呀|啊)?|嗨|哈喽|哈啰|hello|hi|hey|在吗|在么|早上好|下午好|晚上好|早安|午安)[\s!！。.~～呀啊嗯]*$/i

/**
 * 从会话 JSONL 中提取"主题锚点"：首条非空 user 消息（用户最初想做什么）。
 * 供澄清/纠错路径复用，保证后续需求累积不会丢失最初的主题。
 * 无实质内容的消息（纯问候、让渡话术、trim 后不足 2 字）不配当锚点，跳过向下找；
 * 全部无实质内容或无会话文件时返回 undefined。
 */
export function readPrimaryIntent(sessionId: string): string | undefined {
  const path = getAgentSessionPath(sessionId)
  if (!existsSync(path)) return undefined
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const message = JSON.parse(line) as AgentMessage
      if (message.role !== 'user') continue
      const text = (message.content ?? [])
        .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
        .join('')
        .trim()
      if (
        text.length >= 2 &&
        !GREETING_ONLY_PATTERN.test(text) &&
        !isAutoDelegationText(text)
      ) {
        return text
      }
    } catch {
      // 跳过损坏行
    }
  }
  return undefined
}

function resolveSessionRecord(sessionId: string, path: string): AgentSessionRecord {
  const existing = readSessions().sessions.find((item) => item.session_id === sessionId)
  if (existing) return existing
  const modifiedAt = statSync(path).mtime.toISOString()
  return {
    session_id: sessionId,
    project_id: '',
    status: 'active',
    jsonl_path: path,
    created_at: modifiedAt,
    updated_at: modifiedAt,
  }
}

/** 测试 seam：直接读写会话索引（模拟委派子会话等非 recordSessionActivity 形态）。 */
export function readSessionsForTest(): SessionsIndex {
  return readSessions()
}

export function writeSessionsForTest(index: SessionsIndex): void {
  writeSessions(index)
}

function readSessions(): SessionsIndex {
  return readJsonFile<SessionsIndex>(getAgentSessionsIndexPath(), { version: 1, sessions: [] })
}

/**
 * 存量迁移（2026-09-04 索引独立化）：旧共用 agent-sessions.json 里的 Bloma 条目
 *（snake_case：session_id 字段）搬进新专属索引 bloma-agent-sessions.json。
 * 幂等：新索引已存在 → 跳过；旧文件不存在 → 跳过。只读旧写新，绝不动 Proma 的
 * agent-sessions.json（陷阱 40 双向兼容保守原则）。启动时调用，失败不阻断。
 */
export function migrateLegacySessionsIndexOnce(): { migrated: number; skipped: boolean } {
  const newPath = getAgentSessionsIndexPath()
  if (existsSync(newPath)) return { migrated: 0, skipped: true }
  const legacyPath = join(getPromaHome(), 'agent-sessions.json')
  if (!existsSync(legacyPath)) return { migrated: 0, skipped: true }
  try {
    const legacy = JSON.parse(readFileSync(legacyPath, 'utf8')) as { sessions?: unknown[] }
    if (!Array.isArray(legacy.sessions)) return { migrated: 0, skipped: true }
    // Bloma 条目判据与人工分离脚本一致：有 session_id 且无 id（Proma 条目驼峰 id）
    const blomaItems = legacy.sessions.filter(
      (item): item is AgentSessionRecord =>
        !!item && typeof item === 'object' && 'session_id' in item && !('id' in item),
    )
    writeJsonFile(newPath, { version: 1, sessions: blomaItems } satisfies SessionsIndex)
    return { migrated: blomaItems.length, skipped: false }
  } catch {
    // 旧文件损坏/不可读：不迁移不阻断（新索引按需重建）
    return { migrated: 0, skipped: true }
  }
}

function writeSessions(index: SessionsIndex): void {
  writeJsonFile(getAgentSessionsIndexPath(), index)
}
