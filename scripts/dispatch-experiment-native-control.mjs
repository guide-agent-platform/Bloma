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

// Deliberate field allowlists: telemetry never copies prompts, process env or argv.
export function nativeProcessReceipt({ at, driver_pid, driver_ppid, electron_pid, home, run_id }) {
  return { at, driver_pid, driver_ppid, electron_pid, home, run_id: run_id ?? null }
}

export function nativeHeartbeat({ at, project_id, run_id, current_stage, desktop_phase, state,
  electron_exit_code, electron_killed, driver_pid, electron_pid }) {
  return { at, project_id: project_id ?? null, run_id: run_id ?? null,
    current_stage: current_stage ?? null, desktop_phase: desktop_phase ?? null, state: state ?? null,
    electron_exit_code: electron_exit_code ?? null, electron_killed, driver_pid, electron_pid }
}

export function nativeProcessEvent({ at, event, exit_code, signal, driver_pid, electron_pid }) {
  return { at, event, exit_code: exit_code ?? null, signal: signal ?? null, driver_pid, electron_pid }
}
