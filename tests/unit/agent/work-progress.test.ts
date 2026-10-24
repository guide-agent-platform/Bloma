import { describe, expect, it } from 'vitest'
import { createWorkProgress, pruneDuplicateReads } from '../../../main/agent/loop/work-progress'
import type { ConversationTurn } from '../../../main/orchestration/stages/orchestration-contracts'

describe('writable executor progress', () => {
  it('warns at six reads and stops an unchanged 24-turn inspection loop', () => {
    const progress = createWorkProgress()
    for (let i = 1; i <= 24; i++) {
      const result = progress.observe([{ name: 'read_file', status: 'ok', turn: i }])
      expect(result.stalled).toBe(i === 24)
      if (i === 6) expect(result.nudge).toContain('最小修改')
    }
  })
  it('failed writes do not fake progress; real edits and tests reset it', () => {
    const progress = createWorkProgress()
    for (let i = 0; i < 6; i++) progress.observe([{ name: 'edit_file', status: 'error', turn: i }])
    expect(progress.observe([{ name: 'edit_file', status: 'ok', turn: 7 }]).idleTurns).toBe(0)
    expect(progress.observe([{ name: 'run_project_script', status: 'ok', turn: 8 }]).idleTurns).toBe(0)
  })
  it('does not classify waiting for active independent work as read-only inspection', () => {
    const progress = createWorkProgress()
    progress.observe([{ name: 'delegate_agent', status: 'ok', turn: 1 }])
    for (let turn = 2; turn <= 30; turn++) expect(progress.observe([{ name: 'wait_for_delegations', status: 'ok', turn }]).stalled).toBe(false)
    expect(progress.observe([{ name: 'read_file', status: 'ok', turn: 31 }]).idleTurns).toBe(1)
  })
  it.each(['run_command', 'start_service', 'stop_process', 'inspect_app', 'register_gui_check', 'register_cli_check'])('recognizes successful software tool %s without counting failed calls or polling as progress', name => {
    const progress = createWorkProgress()
    for (let i = 0; i < 5; i++) progress.observe([{ name: 'read_process', status: 'ok', turn: i }])
    expect(progress.observe([{ name, status: 'error', turn: 6 }]).idleTurns).toBe(6)
    expect(progress.observe([{ name, status: 'ok', turn: 7 }]).idleTurns).toBe(0)
  })
  it('directs failed GUI calls to the public contract instead of changing product behavior', () => {
    const progress = createWorkProgress()
    let nudge: string | undefined
    for (let i = 1; i <= 6; i++) nudge = progress.observe([{ name: 'register_gui_check', status: 'error', turn: i }]).nudge
    expect(nudge).toContain('verification-gui'); expect(nudge).toContain('不因参数拒绝修改产品业务代码')
  })
  it('deduplicates only identical reads while preserving pairs and changed versions', () => {
    const result = (id: string, body: string): ConversationTurn[] => [
      { role: 'assistant', content: [{ type: 'tool_use', id, name: 'read_file', input: { path: 'app.py' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: body }] },
    ]
    const messages = [...result('a', 'OLD'.repeat(200)), ...result('b', 'NEW'.repeat(200)), ...result('c', 'NEW'.repeat(200))]
    const auditCopy = JSON.stringify(messages)
    expect(pruneDuplicateReads(messages)).toBe(600)
    expect(JSON.stringify(messages[1])).toContain('OLDOLD')
    expect(JSON.stringify(messages[3])).toContain('重复读取已省略')
    expect(JSON.stringify(messages[5])).toContain('NEWNEW')
    expect(messages).toHaveLength(6)
    expect(auditCopy).not.toContain('重复读取已省略')
  })
})
