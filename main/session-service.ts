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

import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import type {
  AgentListSessionsInput,
  AgentListSessionsResult,
  AgentLoadMessagesInput,
  AgentLoadMessagesResult,
  AgentMessage,
  AgentSessionRecord,
  SessionCleanOrphansResult,
} from '../shared/types'
import { getAgentSessionPath, getAgentSessionsIndexPath } from '../storage/config-paths'
import { readJsonFile, writeJsonFile } from '../storage/json-store'
import { listProjects, updateProject } from './project-service'

interface SessionsIndex {
  version: number
  sessions: AgentSessionRecord[]
}

/**
 * 记录一次会话活动：创建/更新会话索引，并回填项目"最后活跃会话"。
 * 项目不存在（如测试中的字面 project_id）时静默跳过 last_session_id 回填。
 */
export function recordSessionActivity(sessionId: string, projectId: string): void {
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
    if (existsSync(jsonl)) rmSync(jsonl, { force: true })
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

/**
 * 从会话 JSONL 中提取"主题锚点"：首条非空 user 消息（用户最初想做什么）。
 * 供澄清/纠错路径复用，保证后续需求累积不会丢失最初的主题。
 * 无会话文件或没有 user 消息时返回 undefined。
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
      if (text) return text
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

function readSessions(): SessionsIndex {
  return readJsonFile<SessionsIndex>(getAgentSessionsIndexPath(), { version: 1, sessions: [] })
}

function writeSessions(index: SessionsIndex): void {
  writeJsonFile(getAgentSessionsIndexPath(), index)
}
