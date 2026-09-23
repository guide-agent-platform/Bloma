import { readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildSdkEnv,
  cancelAgent,
  isSessionActive,
  runAgent,
  setAgentStreamPublisher,
  setRetrySleepForTests,
  setSDKQueryForTests,
} from '../../../main/orchestration/orchestrator'
import { createProject, findProject, updateProject } from '../../../main/project/project-service'
import { listSessions, loadMessages } from '../../../main/platform/sessions/session-service'
import type { SDKMessage } from '../../../shared/types'
import {
  listFilesRecursively,
  useTemporaryPromaHome,
  waitForCondition,
  type TemporaryPromaHome,
} from '../support/test-environment'

vi.mock('../../../main/platform/llm/channel-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../main/platform/llm/channel-manager')>()
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

describe('Sprint 0 agent storage lifecycle acceptance', () => {
  let environment: TemporaryPromaHome | undefined

  afterEach(() => {
    environment?.cleanup()
    environment = undefined
    setAgentStreamPublisher(() => undefined)
    setRetrySleepForTests(async () => undefined)
    setSDKQueryForTests(successfulQuery)
    vi.restoreAllMocks()
  })

  it('[S0-STORE-003] 项目写入应完全位于临时 PROMA_HOME 并创建约定目录', () => {
    environment = useTemporaryPromaHome('bloma-role-c-store-')
    const project = createProject({
      request_id: 'role-c-project',
      mode: 'quick',
      initial_message: '阶段验收项目',
    })

    expect(project.root_path.startsWith(environment.home)).toBe(true)
    expect(listFilesRecursively(environment.home).map((path) => basename(path))).toContain('projects.json')
    expect(project.current_stage).toBe('clarifying')
    expect(project.mode).toBe('quick')
  })

  it('[S0-STORE-004] SDK 部分输出后失败时应保留用户消息、部分输出和终态', async () => {
    environment = useTemporaryPromaHome('bloma-role-c-partial-')
    setSDKQueryForTests(async function* (): AsyncGenerator<SDKMessage> {
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '已经完成第一部分' }],
        },
      }
      throw Object.assign(new Error('role-c simulated failure'), { statusCode: 400 })
    })

    await expect(runAgent(agentInput('role-c-partial'))).rejects.toThrow('role-c simulated failure')

    const jsonl = readFileSync(
      join(environment.home, 'agent-sessions', 'role-c-partial.jsonl'),
      'utf8',
    )
    expect(jsonl).toContain('阶段验收消息')
    expect(jsonl).toContain('已经完成第一部分')
    expect(jsonl).toContain('[terminal] status=error')
  })

  it('[S0-STORE-006] runAgent 后会话索引与消息读取可还原对话历史', async () => {
    environment = useTemporaryPromaHome('bloma-role-c-history-')
    setSDKQueryForTests(successfulQuery)
    const project = createProject({ request_id: 'role-c-history-project', mode: 'quick' })
    // 本用例聚焦存储生命周期而非阶段路由：让项目存储阶段与渲染端上报一致（generating_mvp），
    // 权威阶段判定才不会把这条消息误路由到引导路径。
    updateProject(project.project_id, { current_stage: 'generating_mvp' })

    await runAgent({
      request_id: 'role-c-history-req',
      session_id: 'role-c-history-session',
      project_id: project.project_id,
      content: '阶段验收消息',
      mode: 'quick',
      current_stage: 'generating_mvp',
      channel_id: 'test-channel',
    })

    // 会话索引已建立，且项目回填了最后活跃会话
    const sessions = listSessions({ request_id: 'role-c-history-list' }).sessions
    expect(sessions.some((s) => s.session_id === 'role-c-history-session')).toBe(true)
    expect(findProject(project.project_id).last_session_id).toBe('role-c-history-session')

    // 历史消息可读回，且默认排除 [terminal] 内部终态行
    const loaded = loadMessages({
      request_id: 'role-c-history-load',
      session_id: 'role-c-history-session',
    })
    const texts = loaded.messages.map((m) => m.content.map((b) => b.text ?? '').join(''))
    expect(texts).toContain('阶段验收消息')
    expect(texts).toContain('阶段验收完成')
    expect(loaded.messages.some((m) => m.content.some((b) => b.text?.startsWith('[terminal]')))).toBe(false)
  })

  it('[S0-STORE-005] Sprint 0 运行产物不得创建 SQLite 或数据库连接配置', async () => {
    environment = useTemporaryPromaHome('bloma-role-c-no-db-')
    createProject({ request_id: 'role-c-no-db-project', mode: 'quick' })
    setSDKQueryForTests(successfulQuery)
    await runAgent(agentInput('role-c-no-db-session'))

    const forbidden = listFilesRecursively(environment.home).filter((path) => {
      const extension = extname(path).toLowerCase()
      const name = basename(path).toLowerCase()
      return ['.sqlite', '.sqlite3', '.db'].includes(extension)
        || ['database.yml', 'database.yaml', 'docker-compose.yml'].includes(name)
    })
    expect(forbidden).toEqual([])
  })

  it('[S0-AGENT-004] SDK env 应继承宿主变量并由渠道变量覆盖同名值', () => {
    const previousPath = process.env.PATH
    const previousHome = process.env.USERPROFILE
    process.env.PATH = 'role-c-path'
    process.env.USERPROFILE = 'role-c-home'

    try {
      const env = buildSdkEnv('role-c-key', 'https://role-c.invalid', 'role-c-model')
      expect(env.PATH).toBe('role-c-path')
      expect(env.USERPROFILE).toBe('role-c-home')
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('role-c-key')
      expect(env.ANTHROPIC_BASE_URL).toBe('https://role-c.invalid')
      expect(env.ANTHROPIC_MODEL).toBe('role-c-model')
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousHome === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previousHome
    }
  })

  it('[S0-AGENT-005] 同一 session 正在运行时应拒绝第二个 Agent 请求', async () => {
    environment = useTemporaryPromaHome('bloma-role-c-concurrency-')
    let release!: () => void
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    setSDKQueryForTests(async function* (): AsyncGenerator<SDKMessage> {
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: '处理中' }] },
      }
      await hold
      yield { type: 'result', subtype: 'success' }
    })

    const first = runAgent(agentInput('role-c-busy'))
    await waitForCondition(() => isSessionActive('role-c-busy'))
    // message-queue（2026-08-27）：busy 不再 throw 丢消息——排队并返回 queued:true
    const second = await runAgent(agentInput('role-c-busy'))
    expect(second.queued).toBe(true)
    expect(second.stream_started).toBe(false)
    expect(isSessionActive('role-c-busy')).toBe(true) // 第一条仍在跑
    release()
    await first
    // 第一条完成 → 队列自动派发第二条（短暂占用后释放）
    await waitForCondition(() => !isSessionActive('role-c-busy'))
    expect(isSessionActive('role-c-busy')).toBe(false)
  })

  it('[S0-AGENT-006] 取消请求应终止迭代器并释放 activeSessions', async () => {
    environment = useTemporaryPromaHome('bloma-role-c-cancel-')
    let finalized = false
    setSDKQueryForTests(async function* (_prompt, options): AsyncGenerator<SDKMessage> {
      try {
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: '等待取消' }] },
        }
        await new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(new Error('AGENT_CANCELLED')),
            { once: true },
          )
        })
      } finally {
        finalized = true
      }
    })

    const running = runAgent(agentInput('role-c-cancel'))
    await waitForCondition(() => isSessionActive('role-c-cancel'))
    const cancelled = await cancelAgent({
      request_id: 'role-c-cancel-request',
      session_id: 'role-c-cancel',
      reason: 'user_cancelled',
    })

    expect(cancelled).toEqual({ cancelled: true, session_id: 'role-c-cancel' })
    await running.catch(() => undefined)
    expect(finalized).toBe(true)
    expect(isSessionActive('role-c-cancel')).toBe(false)
  })
})

function agentInput(sessionId: string) {
  return {
    request_id: `request-${sessionId}`,
    session_id: sessionId,
    project_id: 'role-c-project',
    content: '阶段验收消息',
    mode: 'quick' as const,
    current_stage: 'generating_mvp' as const,
    channel_id: 'test-channel',
  }
}

async function* successfulQuery(): AsyncGenerator<SDKMessage> {
  yield {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '阶段验收完成' }] },
  }
  yield { type: 'result', subtype: 'success' }
}
