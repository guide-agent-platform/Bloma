import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function getPromaHome(): string {
  const env = process.env.PROMA_HOME
  // 防御 PROMA_HOME 被污染为字符串 "undefined"/"null"（Node 中 process.env.X = undefined/null
  // 会强制转成字符串）：此时若直接返回，join 会得到相对路径 `undefined/...`，mkdir/写入落到
  // cwd（项目根）下，产生 `./undefined/agent-sessions/` 等污染目录。统一 trim 后校验，
  // 带空格变体与正常值也按 trim 后语义处理。
  const trimmed = env ? env.trim() : ''
  if (trimmed && trimmed !== 'undefined' && trimmed !== 'null') return trimmed
  return join(homedir(), '.proma')
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true })
  return path
}

export function getChannelsPath(): string { return join(getPromaHome(), 'channels.json') }
/** Bloma 专属渠道存储（2026-08-26 独立化）：与 Proma 共用的 channels.json 分开存放——
 *  Proma(v9) 写入时会丢弃本项目 snake_case 条目，共用导致渠道反复被清空。 */
export function getBlomaChannelsPath(): string { return join(getPromaHome(), 'bloma-channels.json') }
/** M5 类别路由表（snake_case；与 Proma 共用的 channels.json 分开存放）。 */
export function getCategoryRoutingPath(): string { return join(getPromaHome(), 'category-routing.json') }
export function getProjectsIndexPath(): string { return join(getPromaHome(), 'projects.json') }
/** Bloma 专属会话索引（2026-09-04 独立化，陷阱 1/40 同模式：跨 App 状态一律分文件）：
 *  Proma 条目驼峰格式（id/title/createdAt），Bloma snake_case（session_id/status）；
 *  双开共用 agent-sessions.json 互读对方条目渲染成空标题+NaN 时间戳（实测 475 条混入，
 *  已人工分离备份 agent-sessions.bloma-sessions.json）。存量迁移见 session-service
 *  migrateLegacySessionsIndexOnce（启动幂等，只读旧写新不动 Proma 文件）。 */
export function getAgentSessionsIndexPath(): string { return join(getPromaHome(), 'bloma-agent-sessions.json') }
/** 经验库统一账本（2026-09-07 T-0：anti_pattern/pattern 两 kind 同文件，跨 App 状态
 *  分文件惯例同 bloma-channels/bloma-agent-sessions）。纯路径不建目录：写方自建，
 *  读方（空库回归锁）不该有落盘副作用。 */
export function getExperienceIndexPath(): string { return join(getPromaHome(), 'bloma-experience.jsonl') }

/** 引擎 system prompt 外置覆盖路径：{PROMA_HOME}/prompts/{name}.md（文件存在即覆盖内置默认）。 */
export function getPromptOverridePath(name: string): string {
  return join(getPromaHome(), 'prompts', `${name}.md`)
}

/** 工程模板外置覆盖路径（2026-09-02 周计划 §5 P4：~/.proma/templates/{type}.md，沿用 prompt-config 模式）。 */
export function getProjectTemplatePath(type: string): string {
  return join(getPromaHome(), 'templates', `${type}.md`)
}

/** 骨架包外置覆盖目录（PR-1 骨架先行：~/.proma/templates/skeletons/{dir}/，整目录覆盖内置）。 */
export function getSkeletonDirPath(dir: string): string {
  return join(getPromaHome(), 'templates', 'skeletons', dir)
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
