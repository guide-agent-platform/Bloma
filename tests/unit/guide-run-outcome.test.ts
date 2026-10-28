import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../shared/types'

vi.mock('../../main/guide/guide-agent-service', () => ({ handleGuideMessage: vi.fn() }))
vi.mock('../../main/platform/llm/runtime-fallback', () => ({ resolveChannelEnv: () => ({ env: { ANTHROPIC_MODEL: 'fixture' } }) }))
import { handleGuideMessage } from '../../main/guide/guide-agent-service'
import { runAgent } from '../../main/orchestration/stages/agent-dispatch'
import { setAgentStreamPublisher } from '../../main/orchestration/stages/sdk-glue'
import { createProject } from '../../main/project/project-service'

let home: string, previous: string | undefined
beforeEach(() => {
  previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-guide-outcome-')); process.env.PROMA_HOME = home
})
afterEach(() => {
  setAgentStreamPublisher(() => undefined); vi.clearAllMocks()
  if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous
  rmSync(home, { recursive: true, force: true })
})
it.each(['incomplete', 'error', 'success'] as const)('preserves downstream %s after an earlier successful confirmation', async outcome => {
  const project = createProject({ request_id: 'create', mode: 'quick' },{workflowVersion:'software-v1'}), events: AgentEvent[] = []
  setAgentStreamPublisher(event => events.push(event))
  vi.mocked(handleGuideMessage).mockImplementationOnce(async (input, publish) => {
    for (const subtype of ['success', outcome, 'success']) publish({ event_id: 'event', session_id: input.session_id, project_id: input.project_id,
      type: 'message_completed', created_at: new Date().toISOString(), payload: { subtype } })
  })
  await runAgent({ request_id: 'confirm', project_id: project.project_id, session_id: 'session', mode: 'quick', current_stage: 'clarifying',
    content: '确认草图，开工', metadata: { source: 'card_option', selected_option_id: 'ux_confirm_go' } })
  expect(events.filter(event => event.type === 'completed').at(-1)?.payload.subtype).toBe(outcome === 'success' ? 'success' : 'incomplete')
})
