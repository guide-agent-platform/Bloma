import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { rmSyncWithRetry } from '../platform/storage/fs-retry'
import { cleanupPastedImages } from '../platform/shell/pasted-images'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type {
  ConfirmSketchInput,
  CorrectionContext,
  Project,
  ProjectAbandonInput,
  ProjectArchiveInput,
  ProjectCreateInput,
  ProjectDeleteInput,
  ProjectExportInput,
  ProjectExportResult,
  ProjectFinalizeInput,
  ProjectReopenInput,
  ProjectRenameInput,
  ProjectUnarchiveInput,
  ProjectUpgradeInput,
  RevisionAccepted,
  WorkflowStage,
} from '../../shared/types'
import { WORKFLOW_STAGES } from '../../shared/types'
import type { SketchRequirement } from '../coding/sketch-engine'
import { getAgentSessionPath,
  getAgentSessionsIndexPath,
  getDocumentsDir,
  getGeneratedProjectPath,
  getProjectEventsPath,
  getProjectsIndexPath,
  getSnapshotsDir,
  getWorkspacePath,
} from '../../storage/config-paths'
import { appendJsonLine, readJsonFile, writeJsonFile } from '../../storage/json-store'

/** 历史项目列表视角：active（默认，过滤归档）/ archived / all（对齐 Proma scope） */
export type ProjectListScope = 'active' | 'archived' | 'all'

interface ProjectsIndex {
  version: number
  projects: Project[]
}

const WORKSPACE_SLUG = 'default-software-builder'

/**
 * 从用户首条消息派生项目显示名（2026-10-05 命名修复）：剥引导语（帮我/请/做一个/
 * 我想要…），在首个句读处截断，最长 16 字。纯函数。
 */
export function deriveProjectDisplayName(message: string | undefined | null): string | undefined {
  if (!message) return undefined
  let text = message.trim()
  if (text.length < 4) return undefined
  text = text.replace(/^(帮我|请你?|我想要?|我需要|给我|麻烦你?)+/g, '')
  text = text.replace(/^(做|写|开发|生成|制作|建|弄)?(一个|一款|款|个|套)?/, '')
  const cut = text.search(/[。，,.！!？?；;：:]/)
  if (cut > 0) text = text.slice(0, cut)
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length < 2) return undefined
  return text.slice(0, 16)
}

/**
 * 未命名项目改名（2026-10-05 用户反馈修复）：「模式选择→建项目」路径创建时无
 * initial_message，全部落「未命名项目」——首条用户消息到达时补名。返回是否改名。
 */
export function maybeRenameUnnamedProject(projectId: string, message: string | undefined | null): boolean {
  try {
    const project = findProject(projectId)
    if (!project) return false
    if (project.name && project.name !== '未命名项目') return false
    const derived = deriveProjectDisplayName(message)
    if (!derived) return false
    updateProject(projectId, { name: derived })
    return true
  } catch {
    // 改名失败不阻断消息链路（陷阱 46：runAgent 分流处防御）
    return false
  }
}

export function createProject(input: ProjectCreateInput): Project {
  const now = new Date().toISOString()
  const projectId = randomUUID()
  const rootPath = getGeneratedProjectPath(WORKSPACE_SLUG, projectId)
  getDocumentsDir(WORKSPACE_SLUG, projectId)
  getSnapshotsDir(WORKSPACE_SLUG, projectId)

  const project: Project = {
    project_id: projectId,
    workspace_slug: WORKSPACE_SLUG,
    name: deriveProjectDisplayName(input.initial_message) ?? input.initial_message?.slice(0, 32) ?? '未命名项目',
    mode: input.mode,
    // 注入点①（周计划 §6 / PRD 12.2）：关键词自动推断，对用户透明；无命中兜底个人小工具（宽松级误判代价最小）
    template_type: 'desktop_tool',
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




export function upgradeProject(input: ProjectUpgradeInput): Project {
  // M-16：升级是瞬时状态切换，直接落在合法停留态 ready（mode 已 longterm）——
  // 此前置 upgrading 后 main 侧无任何流转消费点：打字修改诉求落无工具聊天路径
  // （迭代链不可达）、点选纠错话术与行为双落空，永久停留直至重启。
  // 渲染端话术「已升级为长期迭代模式…随时可以继续完善」与 ready+longterm 语义对齐。
  const project = updateProject(input.project_id, { mode: 'longterm', current_stage: 'ready' })
  appendProjectEvent(project, 'mode_upgraded', input)
  return project
}

/** U6：用户满意后「标记为完成」——项目收口到 completed，闭环产品最后一环。 */
export function finalizeProject(input: ProjectFinalizeInput): Project {
  const project = updateProject(input.project_id, { status: 'completed', current_stage: 'completed' })
  appendProjectEvent(project, 'project_finalized', input)
  return project
}

/** U15：标记为「已放弃」——active → abandoned（状态流转的另一半，与 U6 的 completed 对称）。 */
export function abandonProject(input: ProjectAbandonInput): Project {
  const project = updateProject(input.project_id, { status: 'abandoned' })
  appendProjectEvent(project, 'project_abandoned', input)
  return project
}

/** U15：放弃的项目「恢复进行」——abandoned → active（与取消归档对称）。 */
export function reopenProject(input: ProjectReopenInput): Project {
  return updateProject(input.project_id, { status: 'active' })
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
 * U13：项目重命名。清洗空白与非法字符，空名回退占位；截断到 32 字，
 * 与 createProject 的 initial_message 截断契约保持一致。
 */
export function renameProject(input: ProjectRenameInput): Project {
  const name = (input.name ?? '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 32)
  if (name.length === 0) throw new Error('VALIDATION_ERROR: name must not be empty')
  const project = updateProject(input.project_id, { name })
  appendProjectEvent(project, 'project_renamed', input)
  return project
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

/**
 * U10：手动导出项目（PRD §14.2）。
 * 把生成的项目代码（root_path）复制到用户选定目录下的同名子文件夹，
 * 不触碰索引/会话/快照——导出是只读复制，不改变任何项目状态。
 */
export function exportProject(input: ProjectExportInput, destination: string): ProjectExportResult {
  const project = findProject(input.project_id)
  const target = join(destination, sanitizeFolderName(project.name))
  copyDirRecursive(project.root_path, target)
  return { canceled: false, destination: target, file_count: countFiles(target) }
}

/**
 * 递归复制目录。Node 的 `fs.cpSync` 在 Windows 下对非 ASCII 目标路径会静默失败
 * （不抛错、也不复制），改用 mkdirSync + copyFileSync 手动复制，中文项目名也安全。
 */
function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  if (!existsSync(src)) return
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) copyDirRecursive(srcPath, destPath)
    else if (entry.isFile()) copyFileSync(srcPath, destPath)
  }
}

/** 把项目名清洗成可用的文件夹名：剔除 Windows/跨平台非法字符，空则回退占位名。 */
function sanitizeFolderName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim()
  return cleaned.length > 0 ? cleaned : '未命名项目'
}

/** 递归统计目录下文件数（只计普通文件，跳过子目录自身，防符号链接循环）。 */
function countFiles(dir: string): number {
  let count = 0
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (entry.isDirectory()) count += countFiles(join(dir, entry.name))
    else if (entry.isFile()) count += 1
  }
  return count
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
    if (existsSync(jsonl)) rmSyncWithRetry(jsonl, { force: true })
    // 粘贴图清理（clipboard-paste R1 挂点修复，r73）：项目删除时其全部会话的粘贴图同步回收
    cleanupPastedImages(session.session_id)
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
      if (existsSync(target)) rmSyncWithRetry(target, { recursive: true, force: true })
    } catch (error) {
      console.warn(`[ProjectService] 删除项目文件失败，已残留无引用文件 (${projectId}):`, error)
    }
  }
}

/** 草图生成时记录需求清单，供 MVP 生成读取 P0 功能项（不经 IPC，纯内部 service 直连）。 */
export function recordSketchGenerated(projectId: string, requirements: SketchRequirement[]): void {
  appendProjectEvent(findProject(projectId), 'sketch_generated', { requirements })
}

/**
 * normalizer 判定的范围声明（「不要 X」）持久化（§5.3 out_of_scope）：
 * 去重追加到 project.scope_exclusions，buildPrdBackplane 时并入 out_of_scope。
 */
export function addScopeExclusion(projectId: string, exclusion: string): void {
  const project = findProject(projectId)
  const merged = [...new Set([...(project.scope_exclusions ?? []), exclusion.trim()].filter(Boolean))]
  updateProject(projectId, { scope_exclusions: merged })
}

/**
 * 用户约束（T4-L1「不含登录」「必须离线可用」）持久化：去重追加到
 * project.constraints，buildPrdBackplane 时并入背板 constraints 常驻注入。
 * 返回实际新增的条目（供调用方只在「确有新约束」时落决策日志；重复声明不加噪声）。
 */
export function addConstraints(projectId: string, additions: string[]): string[] {
  const candidates = [...new Set(additions.map((value) => value.trim()).filter(Boolean))]
  if (candidates.length === 0) return []
  const project = findProject(projectId)
  const existing = project.constraints ?? []
  const added = candidates.filter((value) => !existing.includes(value))
  if (added.length === 0) return []
  updateProject(projectId, { constraints: [...existing, ...added] })
  return added
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

/**
 * U16：最近进展摘要——取最近一次 sketch_generated 需求的最后一条描述，
 * 供历史项目卡片展示「最近做了什么」。无草图记录时返回 undefined。
 * 纯读取，不经落盘；只依赖 project-service 自身数据，避免与 session-service 循环依赖。
 */
export function getProjectProgressSummary(projectId: string): string | undefined {
  const requirements = readLastSketchRequirements(projectId)
  if (requirements.length === 0) return undefined
  const last = (requirements[requirements.length - 1].description ?? '').trim()
  if (!last) return undefined
  return last.length > 40 ? `${last.slice(0, 40)}…` : last
}
