import { webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { validateCancel } from '../../../main/ipc/shared'
import { cancelExperimentProject } from '../../../scripts/dispatch-experiment-native-control.mjs'

describe('native STOP/timeout control uses the real cancellation schema', () => {
  it('serializes without module closures and cancels only the owned project with session and reason', async () => {
    const received: unknown[] = []
    const cancel = vi.fn(async input => {
      const valid = validateCancel(input)
      received.push(valid)
      return { ok: true, data: { cancelled: true, session_id: valid.session_id } }
    })
    const inRenderer = runInNewContext(`(${cancelExperimentProject.toString()})`, { window: { electronAPI: { agent: { cancel } } }, crypto: webcrypto })
    await expect(inRenderer({ projectId: 'owned-project', sessionId: 'parent-session' })).resolves.toMatchObject({ cancelled: true })
    expect(received).toEqual([expect.objectContaining({ project_id: 'owned-project', session_id: 'parent-session', reason: 'user_cancelled' })])
    // Both old driver branches failed IPC validation before any stop could occur.
    expect(() => validateCancel({ request_id: 'old-stop', project_id: 'owned-project' })).toThrow('session_id')
    expect(() => validateCancel({ request_id: 'old-timeout', session_id: 'parent-session' })).toThrow('reason')
  })
  it('refuses a missing owned session rather than pretending it stopped', async () => {
    await expect(cancelExperimentProject({ projectId: 'owned-project', sessionId: '' })).rejects.toThrow('EXPERIMENT_CANCEL_CONTEXT_MISSING')
  })
  it('reports IPC refusal instead of labelling the run user-stopped', async () => {
    const inRenderer = runInNewContext(`(${cancelExperimentProject.toString()})`, { window: { electronAPI: { agent: { cancel: async () => ({ ok: false, error: { code: 'VALIDATION_ERROR' } }) } } }, crypto: webcrypto })
    await expect(inRenderer({ projectId: 'owned-project', sessionId: 'parent-session' })).rejects.toThrow('EXPERIMENT_CANCEL_REJECTED: VALIDATION_ERROR')
  })
})
