// Self-contained so Playwright can serialize it into the renderer without closures.
export async function cancelExperimentProject({ projectId, sessionId }) {
  if (typeof projectId !== 'string' || !projectId.trim() || typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new Error('EXPERIMENT_CANCEL_CONTEXT_MISSING')
  }
  const result = await window.electronAPI.agent.cancel({
    request_id: crypto.randomUUID(), session_id: sessionId, project_id: projectId, reason: 'user_cancelled',
  })
  if (!result.ok) throw new Error(`EXPERIMENT_CANCEL_REJECTED: ${result.error?.code ?? 'unknown'}`)
  return result.data
}
