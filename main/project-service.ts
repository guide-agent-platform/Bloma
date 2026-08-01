import { randomUUID } from 'node:crypto'
import type {
  ConfirmSketchInput,
  PointCorrectionInput,
  Project,
  ProjectArchiveInput,
  ProjectCreateInput,
  ProjectUpgradeInput,
  RevisionAccepted,
  WorkflowStage,
} from '../shared/types'
import { WORKFLOW_STAGES } from '../shared/types'
import {
  getDocumentsDir,
  getGeneratedProjectPath,
  getProjectsIndexPath,
  getSnapshotsDir,
} from '../storage/config-paths'
import { appendJsonLine, readJsonFile, writeJsonFile } from '../storage/json-store'

interface ProjectsIndex {
  version: number
  projects: Project[]
}

const WORKSPACE_SLUG = 'default-software-builder'

export function createProject(input: ProjectCreateInput): Project {
  const now = new Date().toISOString()
  const projectId = randomUUID()
  const rootPath = getGeneratedProjectPath(WORKSPACE_SLUG, projectId)
  getDocumentsDir(WORKSPACE_SLUG, projectId)
  getSnapshotsDir(WORKSPACE_SLUG, projectId)

  const project: Project = {
    project_id: projectId,
    workspace_slug: WORKSPACE_SLUG,
    name: input.initial_message?.slice(0, 32) || '未命名项目',
    mode: input.mode,
    template_type: 'web_fullstack',
    status: 'active',
    current_stage: 'clarifying',
    root_path: rootPath,
    created_at: now,
    updated_at: now,
  }

  const index = readProjects()
  index.projects.push(project)
  writeProjects(index)
  return project
}

export function confirmSketch(input: ConfirmSketchInput): Project {
  const project = updateProject(input.project_id, {
    current_stage: input.decision === 'accepted' ? 'generating_mvp' : 'clarifying',
    current_snapshot_id: input.snapshot_id,
  })
  appendProjectEvent(project, 'sketch_decision', input)
  return project
}

export function submitCorrection(input: PointCorrectionInput): RevisionAccepted {
  const taskId = randomUUID()
  const project = findProject(input.project_id)
  appendProjectEvent(project, 'point_correction', { ...input, task_id: taskId })
  return { accepted: true, task_id: taskId }
}

export function upgradeProject(input: ProjectUpgradeInput): Project {
  const project = updateProject(input.project_id, { mode: 'longterm', current_stage: 'upgrading' })
  appendProjectEvent(project, 'mode_upgraded', input)
  return project
}

export function archiveProject(input: ProjectArchiveInput): Project {
  const project = updateProject(input.project_id, { status: 'archived' })
  appendProjectEvent(project, 'project_archived', input)
  return project
}

export function listProjects(): Project[] {
  const projects = readProjects().projects
  // 只返回未归档的项目；活动项目优先排在前面，便于启动恢复取第一个。
  return projects
    .filter((item) => item.status !== 'archived')
    .sort((a, b) => {
      const order = (status: string) => (status === 'active' ? 0 : 1)
      return order(a.status) - order(b.status)
    })
}

export function findProject(projectId: string): Project {
  const project = readProjects().projects.find((item) => item.project_id === projectId)
  if (!project) throw new Error('PROJECT_NOT_FOUND')
  return project
}

export function updateProject(projectId: string, patch: Partial<Project>): Project {
  const index = readProjects()
  const current = index.projects.find((item) => item.project_id === projectId)
  if (!current) throw new Error('PROJECT_NOT_FOUND')
  if (patch.current_stage && !isWorkflowStage(patch.current_stage)) {
    throw new Error('VALIDATION_ERROR: current_stage must be one of WORKFLOW_STAGES')
  }
  Object.assign(current, patch, { updated_at: new Date().toISOString() })
  writeProjects(index)
  return current
}

export function isWorkflowStage(stage: string): stage is WorkflowStage {
  return WORKFLOW_STAGES.includes(stage as WorkflowStage)
}

function readProjects(): ProjectsIndex {
  return readJsonFile<ProjectsIndex>(getProjectsIndexPath(), { version: 1, projects: [] })
}

function writeProjects(index: ProjectsIndex): void {
  writeJsonFile(getProjectsIndexPath(), index)
}

function appendProjectEvent(project: Project, type: string, payload: unknown): void {
  appendJsonLine(`${project.root_path}/events.jsonl`, {
    event_id: randomUUID(),
    type,
    payload,
    created_at: new Date().toISOString(),
  })
}
