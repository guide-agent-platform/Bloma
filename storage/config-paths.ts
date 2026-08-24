import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function getPromaHome(): string {
  return process.env.PROMA_HOME || join(homedir(), '.proma')
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true })
  return path
}

export function getChannelsPath(): string { return join(getPromaHome(), 'channels.json') }
/** M5 类别路由表（snake_case；与 Proma 共用的 channels.json 分开存放）。 */
export function getCategoryRoutingPath(): string { return join(getPromaHome(), 'category-routing.json') }
export function getProjectsIndexPath(): string { return join(getPromaHome(), 'projects.json') }
export function getAgentSessionsIndexPath(): string { return join(getPromaHome(), 'agent-sessions.json') }
export function getSettingsPath(): string { return join(getPromaHome(), 'settings.json') }
export function getUserProfilePath(): string { return join(getPromaHome(), 'user-profile.json') }

/** 引擎 system prompt 外置覆盖路径：{PROMA_HOME}/prompts/{name}.md（文件存在即覆盖内置默认）。 */
export function getPromptOverridePath(name: string): string {
  return join(getPromaHome(), 'prompts', `${name}.md`)
}

// 会话历史统一走 agent-sessions（历史遗留的 Conversation 命名已清理，见 data-model §5/§6）
export function getAgentSessionPath(sessionId: string): string {
  return join(ensureDir(join(getPromaHome(), 'agent-sessions')), `${sessionId}.jsonl`)
}

/**
 * 工作区根路径的纯拼接版（不建目录）。只读路径必须走这里：
 * 经 `getWorkspacePath` 会顺手 mkdir，使「读事件/读埋点」也产生落盘副作用
 * （PROMA_HOME 被污染时甚至会在 cwd 下建出 `undefined/agent-workspaces/...`）。
 */
function workspaceRoot(workspaceSlug: string): string {
  return join(getPromaHome(), 'agent-workspaces', workspaceSlug)
}

export function getWorkspacePath(workspaceSlug: string): string {
  return ensureDir(workspaceRoot(workspaceSlug))
}

export function getWorkspaceMcpConfigPath(workspaceSlug: string): string {
  return join(getWorkspacePath(workspaceSlug), 'mcp.json')
}

export function getWorkspaceSkillsDir(workspaceSlug: string): string {
  return ensureDir(join(getWorkspacePath(workspaceSlug), 'skills'))
}

export function getWorkspaceFilesDir(workspaceSlug: string): string {
  return ensureDir(join(getWorkspacePath(workspaceSlug), 'workspace-files'))
}

export function getGeneratedProjectsDir(workspaceSlug: string): string {
  return ensureDir(join(getWorkspacePath(workspaceSlug), 'generated-projects'))
}

export function getGeneratedProjectPath(workspaceSlug: string, projectId: string): string {
  return ensureDir(join(getGeneratedProjectsDir(workspaceSlug), projectId))
}

export function getDocumentsDir(workspaceSlug: string, projectId: string): string {
  return ensureDir(join(getWorkspacePath(workspaceSlug), 'documents', projectId))
}

export function getSnapshotsDir(workspaceSlug: string, projectId: string): string {
  return ensureDir(join(getWorkspacePath(workspaceSlug), 'snapshots', projectId))
}

/**
 * 项目事件历史独立存放于 workspace 级别，不随项目文件回滚而丢失。
 * 纯路径（不建目录）：写入方 `appendJsonLine` 自建父目录，读取方不该有副作用。
 */
export function getProjectEventsPath(workspaceSlug: string, projectId: string): string {
  return join(workspaceRoot(workspaceSlug), 'events', `${projectId}.jsonl`)
}

/** 纯路径（不建目录），同 `getProjectEventsPath`。 */
export function getAnalyticsPath(workspaceSlug: string): string {
  return join(workspaceRoot(workspaceSlug), 'analytics.jsonl')
}

export function getSdkBinaryPath(): string {
  return join(getPromaHome(), 'sdk-config', 'claude')
}
