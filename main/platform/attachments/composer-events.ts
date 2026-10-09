import { join } from 'node:path'
import { getPromaHome } from '../../../storage/config-paths'
import { appendJsonLine } from '../../../storage/json-store'

export function trackComposerEvent(event: string, projectId: string, sessionId: string, details: Record<string, unknown> = {}): void {
  try { appendJsonLine(join(getPromaHome(), 'bloma-composer', 'events.jsonl'), { event, project_id: projectId, session_id: sessionId, at: Date.now(), ...details }) }
  catch (error) { console.warn('[composer-events] 事件记录失败', error) }
}
