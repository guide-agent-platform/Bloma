import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentSendMessageInput } from '../shared/types'
import { routeDialogue } from './dialogue-router'
import { trackAnalytics } from './platform-services'
import { runSketchTask, setProgrammingEventPublisher } from './programming-orchestrator'
import { findProject, updateProject } from './project-service'

type GuideEventPublisher = (event: AgentEvent) => void

export async function handleGuideMessage(
  input: AgentSendMessageInput,
  publish: GuideEventPublisher,
): Promise<void> {
  const project = findProject(input.project_id)
  setProgrammingEventPublisher(publish)
  trackAnalytics({
    request_id: input.request_id,
    event: {
      event_type: 'conversation_submitted',
      project_id: input.project_id,
      session_id: input.session_id,
      payload: { mode: input.mode, source: input.metadata?.source ?? 'chat' },
      privacy_level: 'research_safe',
    },
  })

  const route = routeDialogue(input.content, project)
  if (route.action === 'ask_clarification') {
    updateProject(input.project_id, { current_stage: 'blocked_for_user_decision' })
    publish(makeGuideEvent(input, 'stage_changed', { stage: 'blocked_for_user_decision' }))
    publish(makeGuideEvent(input, 'message_delta', {
      text: '我需要再确认几个关键点，这样草图会更接近你的想法。',
    }))
    publish(makeGuideEvent(input, 'user_decision_required', {
      kind: 'clarification',
      title: '先确认方向',
      options: route.questions.slice(0, 3),
    }))
    return
  }

  await runSketchTask({
    request_id: input.request_id,
    session_id: input.session_id,
    project_id: input.project_id,
    mode: input.mode,
    prompt: input.content,
    requirements: route.requirements,
  })
}

function makeGuideEvent(
  input: AgentSendMessageInput,
  type: AgentEvent['type'],
  payload: Record<string, unknown>,
): AgentEvent {
  return {
    event_id: randomUUID(),
    session_id: input.session_id,
    project_id: input.project_id,
    type,
    payload,
    created_at: new Date().toISOString(),
  }
}
