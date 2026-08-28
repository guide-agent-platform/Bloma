import { restorePromaHome } from '../support/proma-home-guard'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProject } from '../../main/project-service'
import { loadMessages, recordSessionActivity } from '../../main/session-service'
import { appendDelegationSettle, restoreDelegationRecord } from '../../main/delegation-persistence'
import { appendJsonLine, readJsonFile, writeJsonFile } from '../../storage/json-store'
import { getAgentSessionPath } from '../../storage/config-paths'

/**
 * Delegation 子会话持久化与恢复（delegation-persistence-port.md 阶段 1+2，2026-08-28 TDD）：
 * 子会话 JSONL 一直在落盘（数据不丢），但缺两层通路——① meta 归属（session 索引无
 * source_delegation_id/parent_session_id，重启后找不回）② registry 恢复（delegations
 * Map 内存态，重启即丢）。本套件锁定：归属写入 → 唯一性安全检查（防跨父误恢复，
 * Proma agent-collaboration-tools.ts:441-447 同构）→ JSONL 末行 settle 推断终态。
 * 原型 7 断言搬运（prototype/delegation-restore-prototype.ts）+ 真实模块生命周期。
 */

function useTemporaryHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix))
  process.env.PROMA_HOME = home
  return home
}

const originalHome = process.env.PROMA_HOME
afterEach(() => {
  restorePromaHome(originalHome)
})

describe('delegation 恢复（阶段 1 meta 归属 + 阶段 2 registry 恢复）', () => {
  it('running 态恢复：归属字段写入索引后，重启视角能按 delegationId 找回子会话', () => {
    useTemporaryHome('deleg-restore-')
    const project = createProject({ request_id: 'req-a', mode: 'quick' })
    const childA = 'child-session-111'
    const delegA = 'deleg-uuid-0001'

    // 阶段 1：子会话活动记录带归属字段
    recordSessionActivity(childA, project.project_id, {
      parentSessionId: 'parent-session-aaa',
      sourceDelegationId: delegA,
    })
    // 子会话消息落盘（agent-loop appendLoopMessage 同构）
    appendJsonLine(getAgentSessionPath(childA), {
      role: 'assistant',
      content: [{ type: 'text', text: '开始调研' }],
      timestamp: Date.now(),
    })

    // 阶段 2：重启视角恢复（读盘，非内存）
    const restored = restoreDelegationRecord('parent-session-aaa', delegA)
    expect(restored).toBeDefined()
    expect(restored!.childSessionId).toBe(childA)
    expect(restored!.parentSessionId).toBe('parent-session-aaa')
    expect(restored!.status).toBe('running')
    expect(restored!.finished).toBe(false)
  })

  it('completed 态恢复：settle 行落 JSONL 后 status/summary 从盘上推断', () => {
    useTemporaryHome('deleg-done-')
    const project = createProject({ request_id: 'req-b', mode: 'quick' })
    recordSessionActivity('child-222', project.project_id, {
      parentSessionId: 'parent-b',
      sourceDelegationId: 'deleg-0002',
    })
    appendJsonLine(getAgentSessionPath('child-222'), { role: 'assistant', content: [{ type: 'text', text: '结论' }], timestamp: Date.now() })
    appendDelegationSettle('child-222', 'completed', { resultSummary: '调研完成：3 个要点' })

    const restored = restoreDelegationRecord('parent-b', 'deleg-0002')
    expect(restored).toBeDefined()
    expect(restored!.status).toBe('completed')
    expect(restored!.finished).toBe(true)
    expect(restored!.resultSummary).toBe('调研完成：3 个要点')
  })

  it('跨父误恢复被拒绝（parent 不匹配且非空 → undefined）', () => {
    useTemporaryHome('deleg-cross-')
    const project = createProject({ request_id: 'req-c', mode: 'quick' })
    recordSessionActivity('child-333', project.project_id, {
      parentSessionId: 'parent-real',
      sourceDelegationId: 'deleg-0003',
    })
    expect(restoreDelegationRecord('parent-attacker', 'deleg-0003')).toBeUndefined()
  })

  it('孤儿会话（parent 字段缺失）全局唯一命中可恢复，parent 回填请求方', () => {
    useTemporaryHome('deleg-orphan-')
    const project = createProject({ request_id: 'req-d', mode: 'quick' })
    recordSessionActivity('child-444', project.project_id)
    // 手工改索引：只有 delegation 归属、无 parent 字段（模拟旧数据）
    appendDelegationSettle('child-444', 'failed', { error: 'boom' })
    const indexPath = join(process.env.PROMA_HOME!, 'agent-sessions.json')
    const index = readSessionsIndexRaw(indexPath)
    for (const s of index.sessions) {
      if (s.session_id === 'child-444') {
        s.source_delegation_id = 'deleg-0004'
        delete s.parent_session_id
      }
    }
    writeSessionsIndexRaw(indexPath, index)

    const restored = restoreDelegationRecord('parent-recover', 'deleg-0004')
    expect(restored).toBeDefined()
    expect(restored!.status).toBe('failed')
    expect(restored!.parentSessionId).toBe('parent-recover')
  })

  it('同 delegationId 双记录（数据异常）拒绝恢复', () => {
    useTemporaryHome('deleg-dup-')
    const project = createProject({ request_id: 'req-e', mode: 'quick' })
    // 对齐原型场景 D：两条归属记录均无 parent 字段（孤儿态）→ 全局非唯一 → 拒绝
    recordSessionActivity('child-555', project.project_id)
    recordSessionActivity('child-555-dup', project.project_id)
    const indexPath = join(process.env.PROMA_HOME!, 'agent-sessions.json')
    const index = readSessionsIndexRaw(indexPath)
    for (const s of index.sessions) {
      if (s.session_id === 'child-555' || s.session_id === 'child-555-dup') {
        s.source_delegation_id = 'deleg-0005'
        delete s.parent_session_id
      }
    }
    writeSessionsIndexRaw(indexPath, index)
    expect(restoreDelegationRecord('parent-e', 'deleg-0005')).toBeUndefined()
  })

  it('未知 delegationId 返回 undefined；settle 行不污染消息读回', () => {
    useTemporaryHome('deleg-unknown-')
    const project = createProject({ request_id: 'req-f', mode: 'quick' })
    recordSessionActivity('child-666', project.project_id, {
      parentSessionId: 'parent-f',
      sourceDelegationId: 'deleg-0006',
    })
    appendJsonLine(getAgentSessionPath('child-666'), { role: 'assistant', content: [{ type: 'text', text: '正文消息' }], timestamp: Date.now() })
    appendDelegationSettle('child-666', 'cancelled')

    expect(restoreDelegationRecord('parent-f', 'deleg-nobody')).toBeUndefined()

    const { messages } = loadMessages({ request_id: 'req-f', session_id: 'child-666' })
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content[0]).toMatchObject({ type: 'text', text: '正文消息' })
  })

  it('真实落盘核对：索引文件与会话 JSONL 都在磁盘上（非内存态）', () => {
    useTemporaryHome('deleg-disk-')
    const project = createProject({ request_id: 'req-g', mode: 'quick' })
    recordSessionActivity('child-777', project.project_id, {
      parentSessionId: 'parent-g',
      sourceDelegationId: 'deleg-0007',
    })
    appendJsonLine(getAgentSessionPath('child-777'), { role: 'assistant', content: [{ type: 'text', text: '落盘核对' }], timestamp: Date.now() })
    expect(existsSync(join(process.env.PROMA_HOME!, 'agent-sessions.json'))).toBe(true)
    expect(existsSync(getAgentSessionPath('child-777'))).toBe(true)
    const restored = restoreDelegationRecord('parent-g', 'deleg-0007')
    expect(restored).toBeDefined()
  })
})

/** 测试辅助：直接读写索引 JSON（孤儿/双记录用例模拟异常数据用） */
function readSessionsIndexRaw(path: string): { version: number; sessions: Array<Record<string, unknown>> } {
  return readJsonFile(path, { version: 1, sessions: [] })
}

function writeSessionsIndexRaw(path: string, index: { version: number; sessions: Array<Record<string, unknown>> }): void {
  writeJsonFile(path, index)
}
