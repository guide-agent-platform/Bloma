import { updateProject } from '../project/project-service'

/** All delivery policies commit the same lifecycle fields. Gate owners must
 * establish current evidence before calling; cancellation is checked again here. */
export function commitDesktopDelivery(projectId: string, signal?: AbortSignal): ReturnType<typeof updateProject> {
  signal?.throwIfAborted()
  return updateProject(projectId, { desktop_phase: 'delivered', status: 'completed', current_stage: 'completed',
    desktop_blocked: undefined, blocked_action: undefined })
}
