import { randomUUID } from 'node:crypto'
import type { AgentEvent, ProjectMode, Snapshot } from '../shared/types'
import { createSnapshot, runSandbox, trackAnalytics } from './platform-services'
import { updateProject } from './project-service'
import { generateSketch, type SketchRequirement } from './sketch-engine'

type ProgrammingEventPublisher = (event: AgentEvent) => void

export interface SketchTaskInput {
  request_id: string
  session_id: string
  project_id: string
  mode: ProjectMode
  prompt: string
  requirements?: SketchRequirement[]
}

export interface SketchTaskResult {
  preview_url: string
  snapshot: Snapshot
  summary: string
}

let programmingEventPublisher: ProgrammingEventPublisher = () => undefined

export function setProgrammingEventPublisher(publisher: ProgrammingEventPublisher): void {
  programmingEventPublisher = publisher
}

export async function runSketchTask(input: SketchTaskInput): Promise<SketchTaskResult> {
  publish(input, 'stage_changed', { stage: 'generating_sketch' })
  updateProject(input.project_id, { current_stage: 'generating_sketch' })

  const requirements = input.requirements?.length
    ? input.requirements
    : [{ id: 'F-001', description: input.prompt }]
  const sketch = generateSketch({ project_id: input.project_id, requirements, max_pages: 3 })
  const sandbox = await runSandbox({ request_id: input.request_id, project_id: input.project_id })
  if (sandbox.status !== 'running' || !sandbox.preview_url) {
    publish(input, 'error', {
      code: 'SANDBOX_RUN_FAILED',
      message: sandbox.error_summary?.user_visible_summary ?? '预览暂时没有启动成功，我正在修复。',
    })
    const category = sandbox.error_summary?.category ?? 'unknown'
    throw new Error(`SANDBOX_RUN_FAILED:${category}`)
  }

  const snapshot = await createSnapshot({
    request_id: input.request_id,
    project_id: input.project_id,
    kind: 'sketch',
    summary: sketch.summary,
    include_documents: false,
    health_status: 'healthy',
  })

  trackAnalytics({
    request_id: input.request_id,
    event: {
      event_type: 'sketch_generated',
      project_id: input.project_id,
      session_id: input.session_id,
      payload: {
        mode: input.mode,
        snapshot_id: snapshot.snapshot_id,
        file_count: sketch.files.length,
      },
      privacy_level: 'research_safe',
    },
  })

  updateProject(input.project_id, {
    current_stage: 'sketch_ready',
    current_snapshot_id: snapshot.snapshot_id,
  })
  publish(input, 'stage_changed', { stage: 'sketch_ready' })
  publish(input, 'sketch_ready', {
    preview_url: sandbox.preview_url,
    snapshot_id: snapshot.snapshot_id,
    summary: sketch.summary,
  })

  return { preview_url: sandbox.preview_url, snapshot, summary: sketch.summary }
}

function publish(input: SketchTaskInput, type: AgentEvent['type'], payload: Record<string, unknown>): void {
  programmingEventPublisher({
    event_id: randomUUID(),
    session_id: input.session_id,
    project_id: input.project_id,
    type,
    payload,
    created_at: new Date().toISOString(),
  })
}
