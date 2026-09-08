import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { forkFrom, listSessions, loadMessages, recordSessionActivity, setSessionActiveChecker } from '../../main/session-service'
import { appendSessionMessage, resetSessionTreeForTests } from '../../main/session-tree'
import { getAgentSessionPath, getAgentSessionsIndexPath } from '../../storage/config-paths'
import { isSessionActive, registerBackgroundRun, unregisterBackgroundRun } from '../../main/orchestrator'

/**
 * P0-2 会话 fork（2026-09-08 pi 差距方案 §2）。
 * 锁定：JSONL v2 树链写入 / 前缀复制 / 旧文件零迁移 / 原文件一字不动 / 活跃拒绝 / 索引登记。
 */

type Line = Record<string, unknown>

function readLines(sessionId: string): Line[] {
  const path = getAgentSessionPath(sessionId)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Line)
}

function userMsg(text: string, timestamp: number): Line {
  return { role: 'user', content: [{ type: 'text', text }], timestamp }
}

function assistantMsg(timestamp: number): Line {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu-1', name: 'echo', input: {} }, { type: 'text', text: '进展' }],
    timestamp,
  }
}

/** 剥链字段后的纯消息（比较复制保真用）。 */
function stripChain(line: Line): Line {
  const { id: _id, parentId: _pid, ...rest } = line
  return rest
}

function lastIdOf(sessionId: string): string | undefined {
  const lines = readLines(sessionId)
  return lines.length > 0 ? (lines[lines.length - 1]!.id as string) : undefined
}

describe('session-fork（P0-2，2026-09-08）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const projectId = 'project-fork'
  const source = 'session-fork-source'

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-session-fork-'))
    resetSessionTreeForTests()
    // 生产由 ipc.registerIpcHandlers 注入；单测接线以覆盖 BUSY 分支
    setSessionActiveChecker(isSessionActive)
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    resetSessionTreeForTests()
    setSessionActiveChecker(() => false)
  })

  it('appendSessionMessage：连续写入形成 id/parentId 链（首行 parent=null，父指向上一行 id）', () => {
    appendSessionMessage(source, userMsg('想做记账本', 1))
    appendSessionMessage(source, assistantMsg(2))
    appendSessionMessage(source, userMsg('再加预算功能', 3))
    const lines = readLines(source)
    expect(lines).toHaveLength(3)
    expect(lines[0]!.parentId).toBeNull()
    expect(typeof lines[0]!.id).toBe('string')
    expect((lines[0]!.id as string).length).toBe(8)
    expect(lines[1]!.parentId).toBe(lines[0]!.id)
    expect(lines[2]!.parentId).toBe(lines[1]!.id)
    expect(lines[2]!.id).toBe(lastIdOf(source))
    // 原字段保真：role/content/timestamp 未被链字段污染
    expect(stripChain(lines[2]!)).toEqual(userMsg('再加预算功能', 3))
  })

  it('forkFrom：复制「首行到锚点」前缀到新会话（新链重写），原文件一字不动', () => {
    appendSessionMessage(source, userMsg('想做记账本', 1001))
    appendSessionMessage(source, assistantMsg(1002))
    appendSessionMessage(source, userMsg('再加预算功能', 1003))
    appendSessionMessage(source, assistantMsg(1004))
    const originalBefore = readFileSync(getAgentSessionPath(source), 'utf8')

    const result = forkFrom(source, { project_id: projectId, entry_timestamp: 1003 })
    expect(result.forked).toBe(true)
    expect(result.copied_messages).toBe(3)

    const copy = readLines(result.new_session_id)
    expect(copy).toHaveLength(3)
    // 复制品保真：去链字段后逐行等于原前缀
    const originalPrefix = readLines(source).slice(0, 3).map(stripChain)
    expect(copy.map(stripChain)).toEqual(originalPrefix)
    // 新链完整且自洽（首行 parent=null，后行 parent=前行 id）
    expect(copy[0]!.parentId).toBeNull()
    expect(copy[1]!.parentId).toBe(copy[0]!.id)
    expect(copy[2]!.parentId).toBe(copy[1]!.id)

    // 原文件字节级不动
    expect(readFileSync(getAgentSessionPath(source), 'utf8')).toBe(originalBefore)
  })

  it('旧文件（无 id/parentId）按 entry_timestamp fork：零迁移兼容', () => {
    // 直接写无链字段的「旧格式」行
    const path = getAgentSessionPath(source)
    const legacy: Line[] = [userMsg('第一条', 10), assistantMsg(20), userMsg('从这里重来', 30), assistantMsg(40)]
    mkdirSync(join(process.env.PROMA_HOME!, 'agent-sessions'), { recursive: true })
    writeFileSync(path, legacy.map((l) => JSON.stringify(l)).join('\n'), 'utf8')

    const result = forkFrom(source, { project_id: projectId, entry_timestamp: 30 })
    expect(result.copied_messages).toBe(3)
    const copy = readLines(result.new_session_id)
    expect(copy.map(stripChain)).toEqual(legacy.slice(0, 3).map(stripChain))
    // 新文件仍是合法 v2（链齐全）
    expect(copy[0]!.parentId).toBeNull()
    expect(copy[1]!.parentId).toBe(copy[0]!.id)
    expect(copy[2]!.parentId).toBe(copy[1]!.id)
  })

  it('按 entry_id 定位：v2 行 id 命中即 fork；锚点缺失抛 SESSION_FORK_ENTRY_NOT_FOUND', () => {
    appendSessionMessage(source, userMsg('想做记账本', 2001))
    appendSessionMessage(source, assistantMsg(2002))
    appendSessionMessage(source, userMsg('再加预算', 2003))
    const anchorId = readLines(source)[1]!.id as string

    // assistant 行（非 user）作为 entry_id → 拒绝
    expect(() => forkFrom(source, { project_id: projectId, entry_id: anchorId })).toThrow('SESSION_FORK_ENTRY_NOT_FOUND')
    // 不存在的 entry_id → 拒绝
    expect(() => forkFrom(source, { project_id: projectId, entry_id: 'deadbeef' })).toThrow('SESSION_FORK_ENTRY_NOT_FOUND')
    // 缺锚点参数 → 拒绝
    expect(() => forkFrom(source, { project_id: projectId })).toThrow('SESSION_FORK_ENTRY_NOT_FOUND')
    // 源会话不存在
    expect(() => forkFrom('session-missing', { project_id: projectId, entry_timestamp: 1 })).toThrow('SESSION_NOT_FOUND')
  })

  it('活跃会话 fork 拒绝（AGENT_SESSION_BUSY）：复用 run 中语义防读到写一半', () => {
    appendSessionMessage(source, userMsg('开始生成', 3001))
    const runId = registerBackgroundRun(source, new AbortController(), projectId)
    try {
      expect(() => forkFrom(source, { project_id: projectId, entry_timestamp: 3001 })).toThrow('AGENT_SESSION_BUSY')
    } finally {
      unregisterBackgroundRun(source, runId)
    }
  })

  it('索引登记：新会话出现在 listSessions 且带 parent_session_id / fork_entry_id', () => {
    appendSessionMessage(source, userMsg('想做记账本', 4001))
    appendSessionMessage(source, assistantMsg(4002))
    appendSessionMessage(source, userMsg('从这里重开', 4003))
    const anchorId = readLines(source)[2]!.id as string
    recordSessionActivity(source, projectId)

    const result = forkFrom(source, { project_id: projectId, entry_id: anchorId })
    const sessions = listSessions({ request_id: 'req-fork', project_id: projectId }).sessions
    const created = sessions.find((s) => s.session_id === result.new_session_id)
    expect(created).toBeDefined()
    expect(created!.parent_session_id).toBe(source)
    expect(created!.fork_entry_id).toBe(anchorId)
    expect(created!.project_id).toBe(projectId)
  })

  it('JSONL 审计读取兼容：fork 出的新会话可被 loadMessages 正常读取（链字段无干扰）', () => {
    appendSessionMessage(source, userMsg('想做记账本', 5001))
    appendSessionMessage(source, assistantMsg(5002))
    appendSessionMessage(source, userMsg('从这里重开', 5003))
    const result = forkFrom(source, { project_id: projectId, entry_timestamp: 5003 })
    const loaded = loadMessages({ request_id: 'req-fork-2', session_id: result.new_session_id })
    expect(loaded.total).toBe(3)
    expect(loaded.messages).toHaveLength(3)
    expect(loaded.messages[0]!.role).toBe('user')
    expect(loaded.messages[0]!.content).toEqual([{ type: 'text', text: '想做记账本' }])
    // 索引在 fork 时已登记 → resolveSessionRecord 直接命中（无需 mtime 合成）
    expect(loaded.session.session_id).toBe(result.new_session_id)
  })

  it('会话索引文件仍是合法结构（fork 后不破坏既有记录）', () => {
    appendSessionMessage(source, userMsg('一条', 6001))
    forkFrom(source, { project_id: projectId, entry_timestamp: 6001 })
    const indexPath = getAgentSessionsIndexPath()
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { version: number; sessions: Array<Record<string, unknown>> }
    expect(index.version).toBe(1)
    expect(index.sessions.length).toBeGreaterThan(0)
  })
})
