import { describe, expect, it } from 'vitest'
import { commandProgressKey, createWorkProgress, isPendingToolExecution, pruneDuplicateReads, toolFailureKey } from '../../../main/agent/loop/work-progress'
import type { ConversationTurn } from '../../../main/orchestration/stages/orchestration-contracts'

describe('writable executor progress', () => {
  it('does not stop bounded polling of a real pending command or clear an unresolved verifier failure with pending feedback', () => {
    expect(isPendingToolExecution('read_process', '{"kind":"command","execution_status":"running"}')).toBe(true)
    expect(isPendingToolExecution('read_process', '{"kind":"command","execution_status":"completed"}')).toBe(false)
    const progress = createWorkProgress()
    for (let i = 0; i < 7; i++) progress.observe([{ name: 'verify_app', status: 'error', failureKey: 'same:x', turn: i }])
    for (let i = 0; i < 30; i++) expect(progress.observe([{ name: 'read_process', status: 'ok', pending: true, turn: i }]).stalled).toBe(false)
    progress.observe([{ name: 'verify_app', status: 'ok', pending: true, turn: 40 }])
    expect(progress.observe([{ name: 'verify_app', status: 'error', failureKey: 'same:x', turn: 41 }]).stalled).toBe(true)
  })
  it('does not clear a failed installation when a different print command succeeds', () => {
    const progress = createWorkProgress(), failed = { name: 'run_command', status: 'error' as const, failureKey: 'DEPENDENCY_INSTALL_TIMEOUT:hash', progressKey: commandProgressKey('run_command', { command: ['npm', 'ci'] }) }
    for (let turn = 1; turn <= 8; turn++) {
      progress.observe([{ name: 'run_command', status: 'ok', turn, progressKey: commandProgressKey('run_command', { command: ['node', '-e', 'console.log("inspect")'] }) }])
      expect(progress.observe([{ ...failed, turn }]).stalled).toBe(turn === 8)
    }
  })
  it('does not stop when the failing tool really recovers later in the same batch', () => {
    const progress = createWorkProgress(), failure = { name: 'verify_app', status: 'error' as const, failureKey: 'GUI_FAILED:x', turn: 1 }
    for (let i = 0; i < 7; i++) progress.observe([failure])
    expect(progress.observe([failure, { name: 'verify_app', status: 'ok', turn: 1 }]).stalled).toBe(false)
  })
  it('stops the same unresolved failure even with successful commands and probe writes between attempts', () => {
    const progress = createWorkProgress(), failureKey = toolFailureKey('verify_app', '{"failure":{"code":"GUI_EXISTING_EXPECTATIONS_CHANGED"}}')
    for (let turn = 1; turn <= 8; turn++) {
      progress.observe([{ name: 'run_command', status: 'ok', turn }])
      progress.observe([{ name: 'write_file', path: 'tests/probe.mjs', status: 'ok', turn }])
      const result = progress.observe([{ name: 'verify_app', status: 'error', failureKey, turn }])
      expect(result.stalled).toBe(turn === 8)
      if (turn === 3) expect(result.nudge).toContain('同一工具错误')
    }
  })
  it('clears a failure after the same tool succeeds and distinguishes different business assertions', () => {
    const progress = createWorkProgress(), failureKey = 'GUI_FAILED:x'
    for (let i = 0; i < 7; i++) progress.observe([{ name: 'verify_app', status: 'error', failureKey, turn: i }])
    progress.observe([{ name: 'verify_app', status: 'ok', turn: 8 }])
    expect(progress.observe([{ name: 'verify_app', status: 'error', failureKey, turn: 9 }]).stalled).toBe(false)
    const a = toolFailureKey('verify_app', '{"failure":{"code":"PRODUCT_CHECK_FAILED","actual":"one"}}')
    const b = toolFailureKey('verify_app', '{"failure":{"code":"PRODUCT_CHECK_FAILED","actual":"two"}}')
    expect(a).not.toBe(b); expect(a).not.toContain('one')
  })
  it('reads wrapped Pi receipts and tolerates malformed result fields without retaining output', () => {
    const key = toolFailureKey('run_command', '<tool-feedback>{"execution":"failed"}</tool-feedback>\n{"code":"DEPENDENCY_INSTALL_TIMEOUT","input_version":"manifest-v1"}')
    expect(key).toBe(toolFailureKey('run_command', '{"code":"DEPENDENCY_INSTALL_TIMEOUT","input_version":"manifest-v1"}'))
    expect(key).not.toBe(toolFailureKey('run_command', '{"code":"DEPENDENCY_INSTALL_TIMEOUT","input_version":"manifest-v2"}'))
    expect(toolFailureKey('run_command', '{"code":7}')).toBeUndefined()
    expect(() => toolFailureKey('run_command', '{"code":"COMMAND_TIMEOUT","input_version":7}')).not.toThrow()
  })
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
