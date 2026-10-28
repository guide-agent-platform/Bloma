import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../../main/project/project-service'
import { submitChat, resolveMessageReceipt } from '../../main/orchestration/stages/chat-submit'
import { readReceipt } from '../../main/platform/attachments/send-inbox'
import { setAgentStreamPublisher } from '../../main/orchestration/orchestrator'
import type { AgentEvent } from '../../shared/types'
const { handle } = vi.hoisted(() => ({ handle: vi.fn() }))
vi.mock('../../main/guide/guide-agent-service', () => ({ handleGuideMessage: handle }))
vi.mock('../../main/platform/llm/runtime-fallback', () => ({ resolveChannelEnv: () => ({ env: {}, channel: { id: 'local', max_tokens: 2048 } }) }))
afterEach(() => { setAgentStreamPublisher(() => {}); vi.unstubAllEnvs() })
describe('recovered run stream isolation', () => {
  it('suppresses delayed events from the previous generation while publishing the current one', async () => {
    vi.stubEnv('PROMA_HOME', mkdtempSync(join(tmpdir(), 'bloma-generation-events-')))
    const project = createProject({ request_id: 'r', mode: 'quick' },{workflowVersion:'software-v1'})
    const events: AgentEvent[] = [], publishers: Array<(event: AgentEvent) => void> = []
    let failOld!: (error: Error) => void, finishNew!: () => void
    handle.mockImplementationOnce((_input, publish) => { publishers.push(publish); return new Promise((_resolve, reject) => { failOld = reject }) })
      .mockImplementationOnce((_input, publish) => { publishers.push(publish); return new Promise<void>(resolve => { finishNew = resolve }) })
    setAgentStreamPublisher(event => events.push(event))
    submitChat({ request_id: 'r', project_id: project.project_id, session_id: 's', draft_id: 'draft-s', client_message_id: 'client', content: 'continue', attachment_refs: [], mode: 'quick', current_stage: 'clarifying' })
    failOld(new Error('old run failed'))
    await vi.waitFor(() => expect(readReceipt('client', 's')?.status).toBe('failed'))
    resolveMessageReceipt({ request_id: 'r2', project_id: project.project_id, session_id: 's', client_message_id: 'client', operation_id: 'retry', action: 'resume' })
    const event: AgentEvent = { event_id: 'event', session_id: 's', type: 'message_delta', payload: { text: 'late old text' }, created_at: new Date().toISOString() }
    publishers[0](event)
    expect(events.some(event => event.payload.text === 'late old text')).toBe(false)
    publishers[1]({ ...event, payload: { text: 'current text' } })
    expect(events.find(event => event.payload.text === 'current text')?.payload.run_generation).toBe(2)
    finishNew()
    await vi.waitFor(() => expect(readReceipt('client', 's')?.status).toBe('completed'))
  })
})
