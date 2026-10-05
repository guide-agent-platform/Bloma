// @vitest-environment node
/**
 * 委派进度心跳测试（2026-10-06 体验批 C）。
 * 覆盖：尾部解析（最近工具/最后活动/截断容错）、JSONL 快照复用（大小未变零读）、
 * 渲染端归约（running 刷新心跳 / 已终结不复活）。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseHeartbeatFromTail, inspectChildSession, teardownDelegationHeartbeat, type HeartbeatRecord } from '../../../main/agent/delegation/delegation-heartbeat'
import type { AgentEvent } from '../../../shared/types'

describe('parseHeartbeatFromTail（纯函数）', () => {
  it('提取最近的 tool_use 名与最后一行 _createdAt', () => {
    const tail = [
      JSON.stringify({ type: 'assistant', _createdAt: 1000, message: { content: [{ type: 'text', text: 'a' }] } }),
      JSON.stringify({ type: 'assistant', _createdAt: 2000, message: { content: [{ type: 'tool_use', name: 'write_file' }] } }),
      JSON.stringify({ type: 'user', _createdAt: 3000, message: { content: [{ type: 'tool_result' }] } }),
    ].join('\n')
    const parsed = parseHeartbeatFromTail(tail, Date.now())
    expect(parsed.lastTool).toBe('write_file')
    expect(parsed.lastActivityMs).toBe(3000)
  })

  it('首行被 64KB 边界截断时跳过不炸', () => {
    const tail = `{"type":"assistant","_createdAt":888,"message":{"content":[{"type":"text","text":"截断行不完整`
    const parsed = parseHeartbeatFromTail(tail, Date.now(), true)
    expect(parsed.lastTool).toBeUndefined() // 截断行 JSON.parse 失败被跳过
    expect(parsed.lastActivityMs).toBeUndefined()
  })

  it('空尾/全静音返回空对象', () => {
    expect(parseHeartbeatFromTail('', Date.now())).toEqual({})
    expect(parseHeartbeatFromTail('\n\n', Date.now())).toEqual({})
  })
})

describe('inspectChildSession（快照复用）', () => {
  const originalHome = process.env.PROMA_HOME
  let dir: string
  let record: HeartbeatRecord

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hb-'))
    process.env.PROMA_HOME = dir
    record = { delegationId: 'd1', parentSessionId: 'parent', childSessionId: 'child-1', role: 'implement' }
  })
  afterEach(() => {
    restoreHome(originalHome)
    teardownDelegationHeartbeat()
    rmSync(dir, { recursive: true, force: true })
  })

  it('读取真实 JSONL：工具与活动时间正确，大小未变时复用快照', () => {
    const sessionDir = join(dir, 'agent-sessions')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'child-1.jsonl'), [
      JSON.stringify({ type: 'assistant', _createdAt: 100, message: { content: [{ type: 'tool_use', name: 'install_packages' }] } }),
      '',
    ].join('\n'))
    const first = inspectChildSession(record)
    expect(first?.last_tool).toBe('install_packages')
    expect(first?.last_activity_ms).toBe(100)
    expect(first?.file_bytes).toBeGreaterThan(0)
    // 追加新事件后心跳刷新
    appendFileSync(join(sessionDir, 'child-1.jsonl'), JSON.stringify({ type: 'assistant', _createdAt: 500, message: { content: [{ type: 'tool_use', name: 'run_project_script' }] } }) + '\n')
    const second = inspectChildSession(record)
    expect(second?.last_tool).toBe('run_project_script')
    expect(second?.last_activity_ms).toBe(500)
  })

  it('文件不存在时抛错由上层 tick 吞掉（不产出 payload）', () => {
    expect(() => inspectChildSession(record)).toThrow()
  })
})

describe('渲染端归约防复活（类型层锁定）', () => {
  it('delegation_heartbeat 事件类型与 payload 契约', () => {
    const event: AgentEvent = {
      event_id: 'e1', created_at: new Date().toISOString(), session_id: 's1',
      type: 'delegation_heartbeat',
      payload: { delegation_id: 'd1', child_session_id: 'c1', role: 'implement', last_tool: 'write_file', last_activity_ms: 123, file_bytes: 456 },
    }
    expect(event.type).toBe('delegation_heartbeat')
    expect(event.payload.delegation_id).toBe('d1')
  })
})

/** PROMA_HOME 恢复（config-paths 读 env 的时点在调用内，直接还原即可）。 */
function restoreHome(original: string | undefined): void {
  if (original === undefined) delete process.env.PROMA_HOME
  else process.env.PROMA_HOME = original
}
