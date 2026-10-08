/**
 * 点选纠错会话编排（批11 MVP-E，2026-10-08；实施底稿 BLOMA《Bloma-点选纠错实施底稿-20261008.md》）。
 *
 * 方案 D 协作式纠错运行时：不劫持用户正在使用的实例——进入修改模式时平台用同一份
 * 产物拉起「纠错实例」（--correction-session + 可见窗口 + 页内点选层），数据目录经
 * APP_DATA_DIR 指向快照副本（原数据零接触）；选区经产物桥落盘 picks.jsonl（文件交接，
 * Bloma 惯例——Agent 间经文档目录交接），平台轮询读取；收口时把选区组装成结构化
 * 反馈文本，由渲染端作为普通用户消息发送（delivered 反馈回炉链消化——意图层持久化）。
 *
 * 旧产物兼容：app.py 不含 --correction-session 支持时如实返回 unsupported（入口置灰
 * 提示），不静默假装。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { findProject } from '../project/project-service'
import { parseLaunchDeclaration } from './launch-smoke'
import { violatesCommandBlacklist } from './contract-schema'
import { isMvpConfirmPending } from './mvp-confirm'

/** 会话目录相对项目根（00_ 前缀对齐工程目录惯例；picks/data/outputs 平铺其内）。 */
export const CORRECTION_DIR_REL = '00_CORRECTION'

export interface CorrectionPick {
  type?: string
  seq?: number
  ts?: string
  componentId?: string
  role?: string
  roleLabel?: string
  displayName?: string
  text?: string
  kind?: string
  note?: string
  rect?: { x?: number; y?: number; w?: number; h?: number }
  dpr?: number
  source?: string
  preview?: { applied?: string; detail?: string }
  received_at?: string
  count?: number
}

export interface CorrectionSessionInfo {
  sessionKey: string
  sessionDir: string
  drivePort: number
  dataSnapshotted: boolean
  startedAt: string
  pid?: number
}

export type CorrectionStartResult =
  | { ok: true; session: CorrectionSessionInfo }
  | { ok: false; error: string; reason: 'not-delivered' | 'launch-invalid' | 'unsupported' | 'already-running' | 'spawn-failed' }

interface ActiveSession {
  projectId: string
  sessionKey: string
  sessionDir: string
  drivePort: number
  child: ChildProcess
  startedAt: string
  finished: boolean
}

/** 进程内注册表（每项目至多一个活跃会话；teardown 兜底清理）。 */
const activeSessions = new Map<string, ActiveSession>()

/** 逐文件复制目录树（陷阱 27：cpSync recursive 对非 ASCII 目录段错误——中文项目名必踩）。 */
function copyTree(source: string, target: string): void {
  mkdirSync(target, { recursive: true })
  for (const name of readdirSync(source)) {
    const src = join(source, name)
    const dst = join(target, name)
    if (statSync(src).isDirectory()) copyTree(src, dst)
    else copyFileSync(src, dst)
  }
}

function randomPort(): number {
  return 21000 + Math.floor(Math.random() * 18000)
}

/**
 * 启动纠错会话（异步）：数据快照 → 可见纠错实例（--correction-session + --drive-port）→
 * 等 DRIVE_SERVER 就绪行（最长 15s，超时按启动失败处理并清理）。
 */
export async function startCorrectionSession(input: { projectId: string }): Promise<CorrectionStartResult> {
  const project = findProject(input.projectId)
  // 批11 ②：MVP 门挂起态也允许拉起（「先在程序里点点看」选项）——未交付且无挂起门才拦
  if (project.current_stage !== 'completed' && !isMvpConfirmPending(input.projectId)) {
    return { ok: false, reason: 'not-delivered', error: 'CORRECTION_NOT_DELIVERED: 项目尚未完成交付，不能进入修改预览' }
  }
  if (activeSessions.has(input.projectId)) {
    return { ok: false, reason: 'already-running', error: 'CORRECTION_ALREADY_RUNNING: 该项目已有一个修改预览在运行' }
  }
  let raw: string
  try {
    raw = readFileSync(join(project.root_path, 'LAUNCH.json'), 'utf8')
  } catch {
    return { ok: false, reason: 'launch-invalid', error: 'CORRECTION_LAUNCH_MISSING: LAUNCH.json 不存在' }
  }
  const parsed = parseLaunchDeclaration(raw)
  if (!parsed.ok) {
    return { ok: false, reason: 'launch-invalid', error: `CORRECTION_LAUNCH_INVALID: ${parsed.error}` }
  }
  const blacklistHit = violatesCommandBlacklist(parsed.launch.command)
  if (blacklistHit) {
    return { ok: false, reason: 'launch-invalid', error: `CORRECTION_LAUNCH_BLOCKED: ${blacklistHit}` }
  }
  // 旧产物兼容：入口脚本须支持 --correction-session（骨架 v2 批11 起新单自带）
  const entryRel = [...parsed.launch.command].reverse().find((part) => part.endsWith('.py'))
  if (!entryRel) {
    return { ok: false, reason: 'unsupported', error: 'CORRECTION_UNSUPPORTED: 入口不是 Python 脚本，修改预览暂不支持' }
  }
  const entryAbs = join(project.root_path, entryRel)
  let entrySource = ''
  try {
    entrySource = readFileSync(entryAbs, 'utf8')
  } catch {
    return { ok: false, reason: 'unsupported', error: 'CORRECTION_UNSUPPORTED: 入口脚本不可读' }
  }
  if (!entrySource.includes('--correction-session')) {
    return { ok: false, reason: 'unsupported', error: 'CORRECTION_UNSUPPORTED: 该应用由旧版骨架生成，暂不支持点选修改（可用文字反馈）' }
  }

  // 数据快照：项目 data/ 存在则整树复制到会话目录（原数据零接触；快照供纠错实例读写）
  const sessionKey = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const sessionDir = join(project.root_path, CORRECTION_DIR_REL, sessionKey)
  const dataDir = join(project.root_path, 'data')
  const dataSnapshotted = existsSync(dataDir) && statSync(dataDir).isDirectory()
  try {
    if (dataSnapshotted) copyTree(dataDir, join(sessionDir, 'data'))
    else mkdirSync(join(sessionDir, 'data'), { recursive: true })
    mkdirSync(join(sessionDir, 'outputs'), { recursive: true })
  } catch (error) {
    return { ok: false, reason: 'spawn-failed', error: `CORRECTION_SNAPSHOT_FAILED: ${error instanceof Error ? error.message : String(error)}` }
  }

  const drivePort = randomPort()
  const child = spawn(
    parsed.launch.command[0]!,
    [...parsed.launch.command.slice(1), '--correction-session', sessionDir, '--drive-port', String(drivePort)],
    {
      cwd: project.root_path,
      detached: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      env: { ...process.env, APP_DATA_DIR: join(sessionDir, 'data') },
    },
  )
  const session: ActiveSession = {
    projectId: input.projectId,
    sessionKey,
    sessionDir,
    drivePort,
    child,
    startedAt: new Date().toISOString(),
    finished: false,
  }
  activeSessions.set(input.projectId, session)
  // 就绪等待：DRIVE_SERVER 行（stdout pipe）；超时按启动失败清理（不留半死会话占位）
  return new Promise<CorrectionStartResult>((resolve) => {
    let out = ''
    const timer = setTimeout(() => {
      if (!session.finished) {
        cleanupSession(input.projectId, session)
        resolve({ ok: false, reason: 'spawn-failed', error: 'CORRECTION_START_TIMEOUT: 修改预览启动超时（15s 未见就绪信号）' })
      }
    }, 15_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      if (out.includes(`DRIVE_SERVER 127.0.0.1:${drivePort}`)) {
        clearTimeout(timer)
        if (!session.finished) {
          resolve({
            ok: true,
            session: {
              sessionKey,
              sessionDir,
              drivePort,
              dataSnapshotted,
              startedAt: session.startedAt,
              ...(child.pid ? { pid: child.pid } : {}),
            },
          })
        }
      }
    })
    child.on('exit', () => {
      clearTimeout(timer)
      if (!session.finished) {
        session.finished = true
        activeSessions.delete(input.projectId)
        resolve({ ok: false, reason: 'spawn-failed', error: 'CORRECTION_EXITED_EARLY: 修改预览进程提前退出（入口启动失败）' })
      }
    })
  })
}

/** 读选区（渲染端轮询）：picks.jsonl 逐行容错解析；done 行 → done=true。 */
export function readCorrectionPicks(input: { projectId: string }): { ok: boolean; picks: CorrectionPick[]; done: boolean; error?: string } {
  const session = activeSessions.get(input.projectId)
  if (!session) return { ok: false, picks: [], done: false, error: 'CORRECTION_NOT_RUNNING: 没有运行中的修改预览会话' }
  const picks: CorrectionPick[] = []
  let done = false
  try {
    const raw = readFileSync(join(session.sessionDir, 'picks.jsonl'), 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const pick = JSON.parse(line) as CorrectionPick
        if (pick.type === 'done') done = true
        else picks.push(pick)
      } catch {
        // 半行/脏行跳过（追加式写入的瞬时态）
      }
    }
  } catch {
    // 文件尚未创建：还没有选区，正常态
  }
  return { ok: true, picks, done }
}

/** 结束会话：kill 进程树（Windows taskkill /T /F——explorer 桥同款）+ 注册表清理。
 *  返回组装好的回炉反馈文本（buildCorrectionFeedback 单一来源——渲染端经
 *  AGENT_SEND_MESSAGE 代发，走 delivered 反馈回炉链）。 */
export function finishCorrectionSession(input: { projectId: string }): { ok: boolean; feedback?: string; pickCount: number; error?: string } {
  const session = activeSessions.get(input.projectId)
  if (!session) return { ok: false, pickCount: 0, error: 'CORRECTION_NOT_RUNNING' }
  const snapshot = readCorrectionPicks(input)
  const project = findProject(input.projectId)
  cleanupSession(input.projectId, session)
  pruneCorrectionSessions(input.projectId)
  return {
    ok: true,
    pickCount: snapshot.picks.length,
    feedback: snapshot.picks.length > 0 ? buildCorrectionFeedback(snapshot.picks, project.name ?? '这个应用') : undefined,
  }
}

function cleanupSession(projectId: string, session: ActiveSession): void {
  session.finished = true
  activeSessions.delete(projectId)
  try {
    if (session.child.pid) {
      spawn('taskkill', ['/PID', String(session.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    }
  } catch {
    // 已退出
  }
}

/** 应用重启兜底：清全部会话进程（注册表是内存态，重启即丢——进程须显式 kill）。 */
export function disposeAllCorrectionSessions(): void {
  for (const [projectId, session] of [...activeSessions.entries()]) {
    cleanupSession(projectId, session)
  }
}

/** 会话目录清理（保留最近 N 个历史会话供回炉参考；更早的删除）。 */
export function pruneCorrectionSessions(projectId: string, keep = 3): void {
  const project = findProject(projectId)
  const base = join(project.root_path, CORRECTION_DIR_REL)
  if (!existsSync(base)) return
  try {
    const dirs = readdirSync(base)
      .map((name) => join(base, name))
      .filter((dir) => statSync(dir).isDirectory())
      .sort()
    for (const dir of dirs.slice(0, Math.max(0, dirs.length - keep))) {
      rmSync(dir, { recursive: true, force: true })
    }
  } catch {
    // 清理失败不阻断
  }
}

/** 活跃纠错会话判定（MVP 门 pick 选项/渲染端入口提示用）。 */
export function hasActiveCorrectionSession(projectId: string): boolean {
  return activeSessions.has(projectId)
}

/**
 * 点选标记自动并入用户反馈（批11 ②，2026-10-08）：MVP 门挂起期用户打字反馈时，
 * 若存在活跃纠错会话且有选区——finish（kill 实例）+主进程组装反馈与用户文本拼接；
 * 无会话或零选区返回 undefined（用户纯文字意见照旧）。
 */
export function attachActiveCorrectionFeedback(projectId: string, userText: string): string | undefined {
  if (!activeSessions.has(projectId)) return undefined
  const snapshot = readCorrectionPicks({ projectId })
  if (snapshot.picks.length === 0) {
    finishCorrectionSession({ projectId })
    return undefined
  }
  const project = findProject(projectId)
  const correctionText = finishCorrectionSession({ projectId }).feedback
  if (!correctionText) return undefined
  const userPart = userText.trim()
  return userPart ? `${correctionText}\n（用户补充：${userPart}）` : correctionText
}

/** 组装回炉反馈文本（人话；组件定位信息内嵌供 implement 定位；走 delivered 反馈回炉链）。 */
export function buildCorrectionFeedback(picks: CorrectionPick[], projectName: string): string {
  const kindText: Record<string, string> = { guess: '让系统猜（按常见做法改）', visual: '外观/布局问题', function: '功能/操作问题' }
  const lines: string[] = []
  const total = picks.length
  picks.forEach((pick, index) => {
    const where = pick.displayName || pick.componentId || '某处界面'
    const kind = kindText[pick.kind ?? 'guess'] ?? '让系统猜'
    const note = pick.note ? `：${pick.note}` : ''
    const preview = pick.preview?.detail ? `（修改预览里已试过「${pick.preview.detail}」，方向是对的）` : ''
    lines.push(`${index + 1}. ${where}——${kind}${note}${preview}【组件定位 ${pick.componentId ?? '?'}】`)
  })
  return [
    `我在「${projectName}」的修改预览里点选了 ${total} 处要改的地方：`,
    ...lines,
    '请按上面的点选逐处修改（组件定位 id 供查找界面代码），其余功能与已验证行为保持不变；改完重新走验收再交付。',
  ].join('\n')
}
