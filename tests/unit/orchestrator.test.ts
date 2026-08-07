import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

vi.mock('../../main/channel-manager', () => ({
  getChannelByIdRaw: () => ({
    id: 'test-channel',
    name: 'Test',
    provider_type: 'anthropic',
    base_url: 'https://api.anthropic.com',
    api_key: 'encrypted-test-key',
    models: [{ id: 'claude-sonnet-4-6', name: 'Claude', enabled: true }],
    enabled: true,
  }),
  decryptApiKey: () => 'test-key-from-channel',
}))

describe('AgentOrchestrator', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    setSDKQueryForTests(defaultTestQuery)
  })

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

  it('strips host ANTHROPIC_*/CLAUDE_* config and keeps only allowlisted env', () => {
    const saved = {
      PATH: process.env.PATH,
      USERPROFILE: process.env.USERPROFILE,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_CUSTOM_HEADERS: process.env.ANTHROPIC_CUSTOM_HEADERS,
      CLAUDE_CODE_DISABLE_AUTO_UPDATE: process.env.CLAUDE_CODE_DISABLE_AUTO_UPDATE,
    }
    process.env.PATH = 'test-path'
    process.env.USERPROFILE = 'test-home'
    process.env.ANTHROPIC_API_KEY = 'leaked-host-key'
    process.env.ANTHROPIC_CUSTOM_HEADERS = '{"x":"y"}'
    process.env.CLAUDE_CODE_DISABLE_AUTO_UPDATE = 'true'
    try {
      const env = buildSdkEnv('secret', 'https://example.test', 'model-a')
      expect(env.PATH).toBe('test-path')
      expect(env.USERPROFILE).toBe('test-home')
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('secret')
      expect(env.ANTHROPIC_BASE_URL).toBe('https://example.test')
      expect(env.ANTHROPIC_MODEL).toBe('model-a')
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
      expect(env.CLAUDE_CODE_DISABLE_AUTO_UPDATE).toBeUndefined()
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
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
      current_stage: 'generating_mvp',
      channel_id: 'test-channel',
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
        current_stage: 'generating_mvp',
        channel_id: 'test-channel',
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
      current_stage: 'generating_mvp',
      channel_id: 'test-channel',
    })

    expect(capturedEnv?.PATH).toBe('test-path')
    expect(capturedEnv?.ANTHROPIC_AUTH_TOKEN).toBe('test-key-from-channel')
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
      current_stage: 'generating_mvp',
      channel_id: 'test-channel',
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
