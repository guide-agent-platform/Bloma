import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ shell: { openPath: vi.fn() }, app: { isPackaged: false }, BrowserWindow: class {} }))
import { registerProjectDeliverablesIpc } from '../../../main/ipc/project-deliverables'
import { createProject } from '../../../main/project/project-service'
import { saveSoftwareRunState } from '../../../main/software/run-state'
import { IPC_CHANNELS } from '../../../shared/types'
let home: string, previous: string | undefined
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-state-ipc-')); process.env.PROMA_HOME = home })
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) })
it('returns separate execution, verification and goal facts over the actual deliverables IPC', async () => {
  const project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' })
  saveSoftwareRunState({ projectId: project.project_id, sessionId: 's', runId: 'one', status: 'blocked', error: 'REQUEST_BUDGET_EXHAUSTED' })
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  registerProjectDeliverablesIpc({ handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, handler) } as never, {} as never)
  const result = await handlers.get(IPC_CHANNELS.PROJECT_DELIVERABLES)!({}, { request_id: 'r', project_id: project.project_id }) as { ok: boolean; data: { status_view: { execution: { status: string }; goal: { status: string } }; can_launch: boolean } }
  expect(result.ok).toBe(true); expect(result.data.status_view).toMatchObject({ execution: { status: 'blocked' }, goal: { status: 'not_delivered' } })
  expect(result.data.can_launch).toBe(false)
})
