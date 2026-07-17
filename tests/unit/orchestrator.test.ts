import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildSdkEnv, isSessionActive, runAgent } from '../../main/orchestrator'

describe('AgentOrchestrator', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  it('merges process.env before overriding SDK variables', () => {
    process.env.PATH = 'test-path'
    const env = buildSdkEnv('secret', 'https://example.test', 'model-a')
    expect(env.PATH).toBe('test-path')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('secret')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://example.test')
    expect(env.ANTHROPIC_MODEL).toBe('model-a')
  })

  it('persists streamed assistant messages to JSONL and releases active session', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-test-'))
    process.env.PROMA_HOME = home

    await runAgent({
      request_id: 'req-1',
      session_id: 'session-1',
      project_id: 'project-1',
      content: '做一个记账工具',
      mode: 'quick',
      current_stage: 'clarifying',
      metadata: { source: 'chat' },
    })

    expect(isSessionActive('session-1')).toBe(false)
    const jsonl = readFileSync(join(home, 'agent-sessions', 'session-1.jsonl'), 'utf8')
    expect(jsonl).toContain('做一个记账工具')
    expect(jsonl).toContain('Sprint 0')
  })
})
