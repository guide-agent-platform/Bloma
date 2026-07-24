import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildSdkEnv,
  isSessionActive,
  runAgent,
  setAgentStreamPublisher,
  setRetrySleepForTests,
  setSDKQueryForTests,
  shouldRetry,
} from '../../main/orchestrator'
import type { SDKMessage } from '../../shared/types'

describe('AgentOrchestrator', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    setAgentStreamPublisher(() => undefined)
    setRetrySleepForTests(async () => undefined)
    setSDKQueryForTests(defaultTestQuery)
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
    expect(jsonl).toContain('[terminal] status=completed')
  })

  it('persists terminal error to JSONL when SDK fails', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-test-'))
    process.env.PROMA_HOME = home

    setSDKQueryForTests(async function* () {
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'partial-answer' }] },
      }
      throw Object.assign(new Error('boom'), { statusCode: 400 })
    })

    await expect(
      runAgent({
        request_id: 'req-err',
        session_id: 'session-err',
        project_id: 'project-err',
        content: '触发错误',
        mode: 'quick',
        current_stage: 'clarifying',
      }),
    ).rejects.toThrow()

    const jsonl = readFileSync(join(home, 'agent-sessions', 'session-err.jsonl'), 'utf8')
    expect(jsonl).toContain('partial-answer')
    expect(jsonl).toContain('[terminal] status=error')
    expect(jsonl).toContain('AGENT_SDK_ERROR')
    expect(isSessionActive('session-err')).toBe(false)
  })

  it('passes merged env into the SDK query', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-test-'))
    process.env.PROMA_HOME = home
    process.env.PATH = 'test-path'
    let capturedEnv: Record<string, string> | undefined

    setSDKQueryForTests((_prompt, options) => {
      capturedEnv = options.env
      return defaultTestQuery()
    })

    await runAgent({
      request_id: 'req-env',
      session_id: 'session-env',
      project_id: 'project-env',
      content: '测试 env',
      mode: 'quick',
      current_stage: 'clarifying',
    })

    expect(capturedEnv?.PATH).toBe('test-path')
    expect(capturedEnv?.ANTHROPIC_AUTH_TOKEN).toBe('test-key-main-only')
  })

  it('retries 429, 5xx, 529, and transient network errors', () => {
    expect(shouldRetry(Object.assign(new Error('rate limited'), { statusCode: 429 }))).toBe(true)
    expect(shouldRetry(Object.assign(new Error('overloaded'), { statusCode: 529 }))).toBe(true)
    expect(shouldRetry(Object.assign(new Error('server'), { statusCode: 500 }))).toBe(true)
    expect(shouldRetry(new Error('read ECONNRESET'))).toBe(true)
    expect(shouldRetry(Object.assign(new Error('bad request'), { statusCode: 400 }))).toBe(false)
  })

  it('keeps first five retries silent and notifies from the sixth attempt', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-test-'))
    process.env.PROMA_HOME = home
    let attempts = 0
    const events: string[] = []

    setAgentStreamPublisher((event) => events.push(event.type))
    setRetrySleepForTests(async () => undefined)
    setSDKQueryForTests(() => {
      attempts += 1
      if (attempts <= 6) throw Object.assign(new Error('rate limited'), { statusCode: 429 })
      return defaultTestQuery()
    })

    await runAgent({
      request_id: 'req-retry',
      session_id: 'session-retry',
      project_id: 'project-retry',
      content: '测试 retry',
      mode: 'quick',
      current_stage: 'clarifying',
    })

    expect(attempts).toBe(7)
    expect(events.filter((type) => type === 'retrying')).toHaveLength(1)
  })
})

async function* defaultTestQuery(): AsyncGenerator<SDKMessage> {
  yield {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Sprint 0' }] },
  }
  yield { type: 'result', subtype: 'success' }
}
