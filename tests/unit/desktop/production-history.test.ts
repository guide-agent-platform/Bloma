import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadProductionHistory } from '../../../main/desktop/production-history'

afterEach(() => vi.unstubAllEnvs())
describe('primary session continuation', () => {
  it('replays same-phase evidence and removes cancelled dangling tool calls', () => {
    const home = mkdtempSync(join(tmpdir(), 'bloma-production-history-')); vi.stubEnv('PROMA_HOME', home)
    mkdirSync(join(home, 'agent-sessions'))
    const records = [
      { timestamp: 1, role: 'user', content: [{ type: 'text', text: 'obsolete PRD' }] },
      { timestamp: 10, role: 'user', content: [{ type: 'text', text: 'implement' }] },
      { timestamp: 11, role: 'assistant', content: [{ type: 'tool_use', id: 'read', name: 'read_file', input: { path: 'app.py' } }] },
      { timestamp: 12, role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: 'actual bridge contract' }] },
      { timestamp: 13, role: 'assistant', content: [{ type: 'tool_use', id: 'cancelled', name: 'edit_file', input: {} }] },
    ]
    writeFileSync(join(home, 'agent-sessions', 's.jsonl'), records.map(r => JSON.stringify(r)).join('\n'))
    const history = loadProductionHistory('s', 10)
    expect(JSON.stringify(history)).toContain('actual bridge contract')
    expect(JSON.stringify(history)).not.toContain('obsolete PRD')
    expect(JSON.stringify(history)).not.toContain('cancelled')
    expect(history[0]?.role).toBe('user')
  })
})
