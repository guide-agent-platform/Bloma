import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type {
  ConfirmSketchInput,
  PointCorrectionInput,
  Project,
  ProjectArchiveInput,
  ProjectCreateInput,
  ProjectDeleteInput,
  ProjectUnarchiveInput,
  ProjectUpgradeInput,
  RevisionAccepted,
  WorkflowStage,
} from '../shared/types'
import { WORKFLOW_STAGES } from '../shared/types'
import type { SketchRequirement } from './sketch-engine'
import {
  getAgentSessionPath,
  getAgentSessionsIndexPath,
  getDocumentsDir,
  getGeneratedProjectPath,
  getProjectEventsPath,
  getProjectsIndexPath,
  getSnapshotsDir,
  getWorkspacePath,
} from '../storage/config-paths'
import { appendJsonLine, readJsonFile, writeJsonFile } from '../storage/json-store'

/** 历史项目列表视角：active（默认，过滤归档）/ archived / all（对齐 Proma scope） */
export type ProjectListScope = 'active' | 'archived' | 'all'

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
    // 安全独立计数契约（PRD §10.5）：从 0 开始，上限 3 次强制修复，不计入普通退回
    security_repair_count: 0,
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

/** 取消归档：archived → active，重新出现在 active 视角（对齐 Proma archived toggle）。 */
export function unarchiveProject(input: ProjectUnarchiveInput): Project {
  return updateProject(input.project_id, { status: 'active' })
}

/**
 * 硬删除项目（对齐 Proma deleteAgentWorkspace / deleteConversation）：
 * 1) 路径安全防护——项目的一切文件必须落在 workspace 根内，否则拒绝删除；
 * 2) 先移除 projects.json 索引条目并落盘（先索引后文件，rm 失败只残留无引用文件，不产生孤儿索引）；
 * 3) 清理关联会话（agent-sessions.json 索引 + 会话 jsonl）；
 * 4) 物理清理项目/文档/快照/事件文件，任一失败 console.warn 容错不阻断。
 */
export function deleteProject(input: ProjectDeleteInput): { deleted: true } {
  const index = readProjects()
  const project = index.projects.find((item) => item.project_id === input.project_id)
  if (!project) throw new Error('PROJECT_NOT_FOUND')

  const targets = [
    project.root_path,
    getDocumentsDir(project.workspace_slug, project.project_id),
    getSnapshotsDir(project.workspace_slug, project.project_id),
    getProjectEventsPath(project.workspace_slug, project.project_id),
  ]
  for (const target of targets) assertInsideWorkspace(target)

  const projectIdx = index.projects.findIndex((item) => item.project_id === input.project_id)
  index.projects.splice(projectIdx, 1)
  writeProjects(index)

  removeProjectSessions(project.project_id)
  removeProjectFiles(project.workspace_slug, project.project_id)

  return { deleted: true }
}

export function listProjects(scope: ProjectListScope = 'active'): Project[] {
  const projects = readProjects().projects
  const visible =
    scope === 'active'
      ? projects.filter((item) => item.status !== 'archived')
      : scope === 'archived'
        ? projects.filter((item) => item.status === 'archived')
        : [...projects]
  // 活动项目优先排在前面，便于启动恢复取第一个（active/all 视角语义）。
  return visible.sort((a, b) => {
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
  appendJsonLine(getProjectEventsPath(WORKSPACE_SLUG, project.project_id), {
    event_id: randomUUID(),
    type,
    payload,
    created_at: new Date().toISOString(),
  })
}

/** 删除路径必须落在 workspace 根内，防越权删除用户其他目录（对齐 Proma 路径安全校验）。 */
function assertInsideWorkspace(target: string): void {
  const root = resolve(getWorkspacePath(WORKSPACE_SLUG))
  const resolved = resolve(target)
  const rel = relative(root, resolved)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`PROJECT_DELETE_PATH_SAFETY: path outside workspace root: ${target}`)
  }
}

/** 从 agent-sessions.json 移除该项目的会话索引，并删除对应 jsonl 文件。 */
function removeProjectSessions(projectId: string): void {
  const sessionsPath = getAgentSessionsIndexPath()
  const index = readJsonFile<{ version: number; sessions: Array<{ session_id: string; project_id: string }> }>(
    sessionsPath,
    { version: 1, sessions: [] },
  )
  const matched = index.sessions.filter((item) => item.project_id === projectId)
  if (matched.length === 0) return
  index.sessions = index.sessions.filter((item) => item.project_id !== projectId)
  writeJsonFile(sessionsPath, index)
  for (const session of matched) {
    const jsonl = getAgentSessionPath(session.session_id)
    if (existsSync(jsonl)) rmSync(jsonl, { force: true })
  }
}

/** 物理清理项目/文档/快照/事件文件；任一失败仅残留无引用文件（console.warn 容错）。 */
function removeProjectFiles(workspaceSlug: string, projectId: string): void {
  const targets = [
    getGeneratedProjectPath(workspaceSlug, projectId),
    getDocumentsDir(workspaceSlug, projectId),
    getSnapshotsDir(workspaceSlug, projectId),
    getProjectEventsPath(workspaceSlug, projectId),
  ]
  for (const target of targets) {
    try {
      if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    } catch (error) {
      console.warn(`[ProjectService] 删除项目文件失败，已残留无引用文件 (${projectId}):`, error)
    }
  }
}

/** 草图生成时记录需求清单，供 MVP 生成读取 P0 功能项（不经 IPC，纯内部 service 直连）。 */
export function recordSketchGenerated(projectId: string, requirements: SketchRequirement[]): void {
  appendProjectEvent(findProject(projectId), 'sketch_generated', { requirements })
}

/** 读取最近一次 `sketch_generated` 事件中的需求清单；无记录时返回空数组。 */
export function readLastSketchRequirements(projectId: string): SketchRequirement[] {
  const path = getProjectEventsPath(WORKSPACE_SLUG, projectId)
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim())
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]) as { type?: string; payload?: { requirements?: unknown } }
      if (event.type === 'sketch_generated' && Array.isArray(event.payload?.requirements)) {
        return event.payload.requirements as SketchRequirement[]
      }
    } catch {
      // 跳过损坏行
    }
  }
  return []
}
