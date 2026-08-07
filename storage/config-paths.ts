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
export function getProjectsIndexPath(): string { return join(getPromaHome(), 'projects.json') }
export function getAgentSessionsIndexPath(): string { return join(getPromaHome(), 'agent-sessions.json') }
export function getSettingsPath(): string { return join(getPromaHome(), 'settings.json') }
export function getUserProfilePath(): string { return join(getPromaHome(), 'user-profile.json') }

// 会话历史统一走 agent-sessions（历史遗留的 Conversation 命名已清理，见 data-model §5/§6）
export function getAgentSessionPath(sessionId: string): string {
  return join(ensureDir(join(getPromaHome(), 'agent-sessions')), `${sessionId}.jsonl`)
}

export function getWorkspacePath(workspaceSlug: string): string {
  return ensureDir(join(getPromaHome(), 'agent-workspaces', workspaceSlug))
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

/** 项目事件历史独立存放于 workspace 级别，不随项目文件回滚而丢失。 */
export function getProjectEventsPath(workspaceSlug: string, projectId: string): string {
  return join(ensureDir(join(getWorkspacePath(workspaceSlug), 'events')), `${projectId}.jsonl`)
}

export function getAnalyticsPath(workspaceSlug: string): string {
  return join(getWorkspacePath(workspaceSlug), 'analytics.jsonl')
}

export function getSdkBinaryPath(): string {
  return join(getPromaHome(), 'sdk-config', 'claude')
}
