import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../../../main/guide/guide-agent-service', () => ({ handleGuideMessage: vi.fn(async (input, publish) => {
  publish({ event_id: 'fixture', session_id: input.session_id, project_id: input.project_id, type: 'message_completed', payload: { subtype: 'incomplete' }, created_at: new Date().toISOString() })
}) }))
import { createProject } from '../../../main/project/project-service'
import { runAgent } from '../../../main/orchestration/stages/agent-dispatch'
import { getAgentSessionPath } from '../../../storage/config-paths'
let home: string, previous: string | undefined
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-guide-terminal-')); process.env.PROMA_HOME = home })
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) })
it('persists incomplete rather than completed when guide confirmation enters unfinished production', async () => {
  const project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' })
  await runAgent({ request_id: 'r', project_id: project.project_id, session_id: 's', mode: 'quick', content: 'fixture guidance', current_stage: project.current_stage })
  const log = readFileSync(getAgentSessionPath('s'), 'utf8')
  expect(log).toContain('[terminal] status=incomplete'); expect(log).not.toContain('[terminal] status=completed')
})
