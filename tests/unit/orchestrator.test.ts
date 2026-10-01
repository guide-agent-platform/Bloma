import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildSdkEnv,
  cancelAgent,
  isProjectActive,
  isSessionActive,
  registerBackgroundRun,
  resetSDKQueryForTests,
  runAgent,
  setAgentStreamPublisher,
  setRetrySleepForTests,
  setSDKQueryForTests,
  shouldRetry,
  unregisterBackgroundRun,
} from '../../main/orchestration/orchestrator'
import { getAgentSessionPath } from '../../storage/config-paths'
import type { AgentEvent, SDKMessage } from '../../shared/types'

vi.mock('../../main/platform/llm/channel-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/platform/llm/channel-manager')>()
  return {
    ...actual,
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
    getFirstEnabledChannel: () => undefined,
  }
})

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

  it('retries 429, 5xx, 529, and transient network errors', () => {
    expect(shouldRetry(Object.assign(new Error('rate limited'), { statusCode: 429 }))).toBe(true)
    expect(shouldRetry(Object.assign(new Error('overloaded'), { statusCode: 529 }))).toBe(true)
    expect(shouldRetry(Object.assign(new Error('server'), { statusCode: 500 }))).toBe(true)
    expect(shouldRetry(new Error('read ECONNRESET'))).toBe(true)
    expect(shouldRetry(Object.assign(new Error('bad request'), { statusCode: 400 }))).toBe(false)
  })

})

describe('AgentOrchestrator · 项目级运行隔离与停止终态（2026-08-29 修复）', () => {
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

  it('同一项目已有后台运行，另一会话发消息入队排队而非静默丢失（全链路审查 P1-1 修复，2026-10-01）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-test-'))
    process.env.PROMA_HOME = home
    const runId = registerBackgroundRun('session-bg', new AbortController(), 'project-x')
    // 旧行为：PROJECT_BUSY 在排队判定之外抛出 → 不入队不落盘，渲染端静默丢消息。
    // 新行为：项目锁占用期间消息入队（queued: true），run 完成后自动派发；
    // 项目锁本身仍由 registerForegroundRun 硬保证（不并发双跑）。
    const outcome = await runAgent({
      request_id: 'req-fg',
      session_id: 'session-fg',
      project_id: 'project-x',
      content: '做一个工具',
      mode: 'quick',
      current_stage: 'clarifying',
      channel_id: 'test-channel',
    })
    expect(outcome.queued).toBe(true)
    expect(outcome.stream_started).toBe(false)
    unregisterBackgroundRun('session-bg', runId)
    expect(isProjectActive('project-x')).toBe(false)
  })

  it('后台注册按令牌注销：过期令牌不能清掉新运行，正确令牌才释放项目', () => {
    const runId = registerBackgroundRun('session-s', new AbortController(), 'project-y')
    // 同 session 再注册被拒（不再静默覆盖句柄）
    expect(() => registerBackgroundRun('session-s', new AbortController(), 'project-y')).toThrow('AGENT_SESSION_BUSY')
    // 旧任务的 finally 用过期令牌清理：不得删除新句柄
    unregisterBackgroundRun('session-s', 'stale-run-token')
    expect(isProjectActive('project-y')).toBe(true)
    unregisterBackgroundRun('session-s', runId)
    expect(isProjectActive('project-y')).toBe(false)
  })

  it('cancelAgent 取消后台运行：abort 生效、发布 AGENT_CANCELLED 终态、释放项目锁', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-test-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    const controller = new AbortController()
    const runId = registerBackgroundRun('session-c', controller, 'project-z')
    const result = await cancelAgent({
      request_id: 'req-cancel',
      session_id: 'session-c',
      project_id: 'project-z',
      reason: 'user_cancelled',
    })
    expect(result.cancelled).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    expect(events.some((event) => event.type === 'error' && event.payload?.code === 'AGENT_CANCELLED')).toBe(true)
    expect(isProjectActive('project-z')).toBe(false)
    const second = await cancelAgent({
      request_id: 'req-cancel-2',
      session_id: 'session-c',
      project_id: 'project-z',
      reason: 'user_cancelled',
    })
    expect(second.cancelled).toBe(false)
    // 兜底复位（2026-08-29 卡死修复）：无可停运行时补发 completed 终态，复位渲染端 running
    const rescue = events.find((event) => event.type === 'completed')
    expect(rescue?.session_id).toBe('session-c')
    expect(rescue?.payload?.subtype).toBe('forced_reset')
  })
})

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function* defaultTestQuery(): AsyncGenerator<SDKMessage> {
  yield {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Sprint 0' }] },
  }
  yield { type: 'result', subtype: 'success' }
}

// ===========================================================================
// I3 deferred 持久化（2026-09-11 尾批）：留待下一轮达成时会话 JSONL 留痕
// ===========================================================================
describe('I3 steer deferred 持久化（persistSteerDeferredNotice）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    if (originalPromaHome === undefined) delete process.env.PROMA_HOME
    else process.env.PROMA_HOME = originalPromaHome
  })

  it('deferred 落盘 [steer-deferred] system 行（跨重启回放可见）；写盘失败静默不抛', async () => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-steer-defer-'))
    const { persistSteerDeferredNotice } = await import('../../main/orchestration/orchestrator')
    persistSteerDeferredNotice('session-defer-1', '再加一个搜索功能')
    const lines = readFileSync(getAgentSessionPath('session-defer-1'), 'utf8').split('\n').filter(Boolean)
    const row = JSON.parse(lines[lines.length - 1])
    expect(row.role).toBe('system')
    const text = row.content[0].text
    expect(text).toContain('[steer-deferred]')
    expect(text).toContain('留待下一轮的修改：再加一个搜索功能')
    // 坏 home 路径：静默降级不抛（待办仅会话内状态条可见）
    process.env.PROMA_HOME = join(tmpdir(), 'nonexistent-steer-defer-xyz')
    expect(() => persistSteerDeferredNotice('session-defer-2', 'x')).not.toThrow()
  })
})
