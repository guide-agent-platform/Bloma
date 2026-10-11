import { describe, expect, it } from 'vitest'
import { safeToolFeedback, formatToolFeedback, readToolFeedback, toolFeedbackLabel } from '../../shared/tool-feedback'
import { feedbackForTool } from '../../main/agent/loop/tool-feedback'
import { deriveToolCallRecords } from '../../renderer/components/ToolCallBlock'
import type { AgentEvent } from '../../shared/types'

describe('tool feedback contract', () => {
  it('does not turn process exit 0 into business evidence', () => {
    expect(feedbackForTool('run_project_script', { output: 'ZIP_FAIL', detail: { code: 0, verification_status: 'not_reported' } })).toMatchObject({ execution: 'completed', verification: 'unverified', exit_code: 0 })
    expect(feedbackForTool('install_packages', { output: 'import failed', isError: true, detail: { imports_verified: false } })).toMatchObject({ category: 'environment', verification: 'unverified', recovery: 'prepare_environment' })
  })
  it('budget is not executed, not a product failure', () => {
    const feedback = feedbackForTool('run_project_script', { output: 'budget', isError: true, budgetExhausted: true })!
    expect(feedback).toMatchObject({ execution: 'not_run', category: 'budget' })
    expect(toolFeedbackLabel(feedback)).toBe('额度已用尽')
  })
  it('whitelists only typed facts and preserves the header after body truncation', () => {
    const f = safeToolFeedback({ schema_version: 1, execution: 'completed', verification: 'unverified', source: 'fixed_input', secret: 'key', reports: ['00_VERIFY/report.json', '../../private', 'https://token.url'] })!
    expect(f.reports).toEqual(['00_VERIFY/report.json'])
    expect(formatToolFeedback(f, 'x'.repeat(8000))).not.toContain('key')
    expect(readToolFeedback(formatToolFeedback(f, 'x'.repeat(8000)).slice(0, 4000))).toEqual(f)
  })
  it('correlates concurrent same-name tools by call id with legacy event fallback', () => {
    const events: AgentEvent[] = [
      { type: 'tool_call_started', payload: { tool: 'read_file', turn: 1, tool_call_id: 'a', input_summary: 'a.py' } },
      { type: 'tool_call_started', payload: { tool: 'read_file', turn: 1, tool_call_id: 'b', input_summary: 'b.py' } },
      { type: 'tool_call_completed', payload: { tool: 'read_file', turn: 1, tool_call_id: 'b', status: 'error' } },
      { type: 'tool_call_completed', payload: { tool: 'read_file', turn: 1, tool_call_id: 'a', status: 'ok' } },
    ].map((event, i) => ({ ...event, event_id: String(i), session_id: 'test', created_at: '2026-10-12T00:00:00Z' })) as AgentEvent[]
    expect(deriveToolCallRecords(events).map(r => [r.inputSummary, r.status])).toEqual([['a.py', 'ok'], ['b.py', 'error']])
  })
})
