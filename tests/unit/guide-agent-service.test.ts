import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAgent, setAgentStreamPublisher, setSDKQueryForTests } from '../../main/orchestrator'

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
import { createProject, findProject } from '../../main/project-service'
import {
  clearSandboxRuntimeForTests,
  setSandboxRuntimeForTests,
  setSnapshotCaptureProviderForTests,
} from '../../main/platform-services'
import type { AgentEvent, SDKMessage } from '../../shared/types'

describe('GuideAgentService through AgentOrchestrator', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    setAgentStreamPublisher(() => undefined)
    setSDKQueryForTests(defaultTestQuery)
    clearSandboxRuntimeForTests()
    setSnapshotCaptureProviderForTests()
  })

  it('emits up to three clarification cards using user_decision_required', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-guide-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))

    await runAgent({
      request_id: 'req-guide',
      session_id: 'session-guide',
      project_id: project.project_id,
      content: '记账',
      mode: 'quick',
      current_stage: 'clarifying',
      channel_id: 'test-channel',
    })

    const decision = events.find((event) => event.type === 'user_decision_required')
    expect(decision?.payload.kind).toBe('clarification')
    expect(decision?.payload.options).toHaveLength(3)
    expect(findProject(project.project_id).current_stage).toBe('blocked_for_user_decision')
  })

  it('generates a sketch and emits sketch_ready when the requirement is clear', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-guide-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSandboxRuntimeForTests({
      portAllocator: async () => 3100,
      healthCheck: async () => true,
      processFactory: () => makeChildProcess(),
    })
    setSnapshotCaptureProviderForTests(async () => ({
      extension: 'png',
      buffer: Buffer.from('fake-png'),
    }))

    await runAgent({
      request_id: 'req-guide',
      session_id: 'session-guide',
      project_id: project.project_id,
      content: '做一个家庭记账工具，记录收入支出并展示月度结余',
      mode: 'quick',
      current_stage: 'clarifying',
      channel_id: 'test-channel',
    })

    const ready = events.find((event) => event.type === 'sketch_ready')
    expect(ready?.payload.preview_url).toBe('http://localhost:3100')
    expect(ready?.payload.snapshot_id).toBeTruthy()
    expect(findProject(project.project_id).current_stage).toBe('sketch_ready')
  })
})

async function* defaultTestQuery(): AsyncGenerator<SDKMessage> {
  yield {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'test' }] },
  }
  yield { type: 'result', subtype: 'success' }
}

function makeChildProcess(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess
  Object.assign(emitter, { kill: vi.fn(() => true), pid: 1000 })
  return emitter
}
