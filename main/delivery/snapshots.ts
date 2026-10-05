// 快照/回滚（PR3a 自 platform-services 拆出）：创建/列表/截图/文档回看/容量治理/回滚/恢复。
import { runSandbox, stopSandbox } from './sandbox'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createServer } from 'node:net'
import type {
  AnalyticsTrackInput,
  AnalyticsTrackResult,
  RollbackResult,
  SandboxRunInput,
  SandboxRunResult,
  SandboxStopInput,
  SandboxStopResult,
  Snapshot,
  SnapshotCreateInput,
  SnapshotDocumentEntry,
  SnapshotDocumentListResult,
  SnapshotRollbackInput,
} from '../../shared/types'
import { getAnalyticsPath, getDocumentsDir, getSnapshotsDir } from '../../storage/config-paths'
import { appendJsonLine, readJsonFile, writeJsonFile } from '../../storage/json-store'
import { readDocumentsManifest } from '../project/document-engine'
import { findProject, updateProject } from '../project/project-service'
import { PRODUCT_CSP } from '../coding/product-csp'

type SnapshotCaptureProvider = () => Promise<{ buffer: Buffer; extension: 'png' | 'jpg' | 'svg' } | undefined>
/** 快照容量策略（A2-16，闭环 ATK3-G-001，architecture §14）：单项目活跃快照上限。 */
export const MAX_SNAPSHOTS_PER_PROJECT = 100

/** 快照上限解析（2026-09-26 专项）：BLOMA_SNAPSHOT_CAP 正整数覆盖，缺省 100。
 *  可注入的价值：① 容量门禁可运维调参；② 容量回归测试用小上限，避免 100+ 次
 *  快照递归复制在全量并发下拖爆 60s 超时（长期红噪音）。 */
export function resolveSnapshotCap(): number {
  const raw = (process.env.BLOMA_SNAPSHOT_CAP ?? '').trim()
  if (!raw) return MAX_SNAPSHOTS_PER_PROJECT
  const parsed = Number(raw)
  return Number.isFinite(parsed) && Math.floor(parsed) > 0 ? Math.floor(parsed) : MAX_SNAPSHOTS_PER_PROJECT
}
/** 归档保护集：保留最近 N 个 + 每种 kind 最新一个，即使超限也不归档。 */
export const SNAPSHOT_RECENT_KEEP = 20
let snapshotCaptureProvider: SnapshotCaptureProvider = defaultSnapshotCapture

async function defaultSnapshotCapture(): Promise<{ buffer: Buffer; extension: 'svg' }> {
  return {
    extension: 'svg',
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#f7f5fb"/><text x="48" y="72" fill="#1d1d1f" font-family="Arial" font-size="28">Bloma sketch snapshot</text><text x="48" y="118" fill="#6e6e73" font-family="Arial" font-size="18">Preview capture placeholder</text></svg>',
      'utf8',
    ),
  }
}

export async function createSnapshot(input: SnapshotCreateInput): Promise<Snapshot> {
  const project = findProject(input.project_id)
  const snapshotId = randomUUID()
  const snapshotDir = getSnapshotsDir(project.workspace_slug, project.project_id)
  const snapshotRoot = `${snapshotDir}/${snapshotId}`
  const filesArchivePath = `${snapshotRoot}/files`
  const documentsArchivePath = input.include_documents ? `${snapshotRoot}/documents` : undefined

  // 半成品防护（全链路审查 P1-6，2026-10-01）：cpSync 中途失败（杀毒锁/磁盘错）不得留下
  // 无 metadata 的孤儿目录——它会被当成合法快照目录参与未来回滚（恢复出残缺产物，
  // 静默数据损坏）。失败即清理半成品目录，抛结构化错误码。
  let effectiveDocumentsArchivePath = documentsArchivePath
  try {
    mkdirSync(snapshotRoot, { recursive: true })
    cpSync(project.root_path, filesArchivePath, {
      recursive: true,
      force: true,
      // Phase 10 W1-1：归档排除受保护顶层目录（.git 版本史 / data-backups 备份）——
      // 回滚不回退它们（见 restoreSnapshotFiles 的挪出/挪回）；不存在时零影响。
      // venv 排除（2026-10-05 误报根治同族）：名字集 + pyvenv.cfg 标记（异名 venv 兑底）——
      // 否则每次 checkpoint 把 539+ 个 pip/setuptools 文件拷进快照（膨胀+拖慢）。
      filter: (src: string) =>
        !isPreservedToplevel(project.root_path, src)
        && !isExcludedEnvironmentDir(src),
    })
    // 文档冻结（T7）：documents 目录整份归档（prd.json/decisions.md/sketch.html 都在其中；
    // T2 落盘即导出保证 decisions.md 不是过期聚合）。目录尚不存在（如草图阶段的早期快照）
    // 时归档路径置 undefined——metadata 不谎报有归档，回看/回滚据此如实提示。
    if (documentsArchivePath) {
      const documentsDir = getDocumentsDir(project.workspace_slug, project.project_id)
      if (existsSync(documentsDir)) {
        cpSync(documentsDir, documentsArchivePath, { recursive: true, force: true })
      } else {
        effectiveDocumentsArchivePath = undefined
      }
    }
  } catch (error) {
    try {
      if (existsSync(snapshotRoot)) rmSync(snapshotRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (cleanupError) {
      console.error('[snapshot] 半成品目录清理失败（下次容量治理可回收）：', cleanupError)
    }
    throw new Error(`SNAPSHOT_CREATE_FAILED: ${error instanceof Error ? error.message : String(error)}`)
  }

  const capture = await snapshotCaptureProvider()
  const screenshotPath = capture ? `${snapshotRoot}/screenshot.${capture.extension}` : undefined
  if (capture && screenshotPath) writeFileSync(screenshotPath, capture.buffer)

  const snapshot: Snapshot = {
    snapshot_id: snapshotId,
    project_id: project.project_id,
    kind: input.kind,
    name: input.display_name
      ? `${input.display_name}·${snapshotId.slice(0, 4)}`
      : `${input.kind}-${snapshotId.slice(0, 8)}`,
    summary: input.summary,
    screenshot_path: screenshotPath,
    files_archive_path: filesArchivePath,
    documents_archive_path: effectiveDocumentsArchivePath,
    health_status: input.health_status,
    ...(input.verification ? { verification: input.verification } : {}),
    ...(input.derived_from ? { derived_from: input.derived_from } : {}),
    created_at: new Date().toISOString(),
  }
  writeJsonFile(`${snapshotRoot}/metadata.json`, snapshot)
  writeJsonFile(`${snapshotDir}/${snapshotId}.json`, snapshot)
  // A2-16 快照容量门禁：创建后立即执行归档策略
  enforceSnapshotCapacity(project.workspace_slug, project.project_id)
  return snapshot
}

export interface SnapshotCapacityResult {
  active_count: number
  archived: string[]
}

/**
 * 列出项目的活跃快照（读取 `…/snapshots/<project_id>/<snapshot_id>/metadata.json`），
 * 按创建时间升序（时间轴胶片条从旧到新）。供 `snapshot:list` IPC 与时间轴回填。
 */
export function listSnapshots(projectId: string): Snapshot[] {
  const project = findProject(projectId)
  const snapshotDir = getSnapshotsDir(project.workspace_slug, project.project_id)
  const snapshots: Snapshot[] = []
  if (!existsSync(snapshotDir)) return snapshots
  for (const entry of readdirSync(snapshotDir)) {
    const full = join(snapshotDir, entry)
    if (!statSync(full).isDirectory() || entry === 'archive') continue
    const meta = readJsonFile<Snapshot | null>(join(full, 'metadata.json'), null)
    if (!meta?.snapshot_id) continue
    snapshots.push(meta)
  }
  return snapshots.sort((a, b) => a.created_at.localeCompare(b.created_at))
}

const SCREENSHOT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
}

/**
 * U9：读取某快照的截图文件，转成 base64 data URL 回传渲染端（缩略图）。
 * 渲染进程受 CSP `img-src 'self' data: blob:` 约束，无法直接加载磁盘 file:// 截图；
 * 主进程读文件转 data URL 后，`<img>` 可安全展示。无截图/读失败返回 null（前端回退纯色块）。
 */
export async function loadSnapshotScreenshot(projectId: string, snapshotId: string): Promise<string | null> {
  const project = findProject(projectId)
  const snapshotDir = getSnapshotsDir(project.workspace_slug, project.project_id)
  const meta = readJsonFile<Snapshot | null>(join(snapshotDir, snapshotId, 'metadata.json'), null)
  const screenshotPath = meta?.screenshot_path
  if (!screenshotPath || !existsSync(screenshotPath)) return null

  const ext = screenshotPath.split('.').pop()?.toLowerCase() ?? ''
  const mime = SCREENSHOT_MIME[ext]
  if (!mime) return null

  try {
    const base64 = readFileSync(screenshotPath).toString('base64')
    return `data:${mime};base64,${base64}`
  } catch {
    return null
  }
}

// =========================================================================
// T7 文档版本化：快照冻结文档的回看（「当时的想法」与代码快照对齐）
// =========================================================================

export type { SnapshotDocumentEntry, SnapshotDocumentListResult } from '../../shared/types'

/** 读快照元数据（回看/回滚共用；不存在抛 SNAPSHOT_NOT_FOUND）。 */
function readSnapshotMeta(projectId: string, snapshotId: string): Snapshot {
  const project = findProject(projectId)
  const snapshotDir = getSnapshotsDir(project.workspace_slug, project.project_id)
  const meta = readJsonFile<Snapshot | null>(`${snapshotDir}/${snapshotId}.json`, null)
  if (!meta?.snapshot_id) throw new Error('SNAPSHOT_NOT_FOUND')
  return meta
}

/** 解析快照文档归档目录；快照无文档归档（include_documents=false / 当时无文档）返回 undefined。 */
function snapshotDocumentsDir(meta: Snapshot): string | undefined {
  if (!meta.documents_archive_path || !existsSync(meta.documents_archive_path)) return undefined
  return meta.documents_archive_path
}

/**
 * 列出某快照冻结的文档。manifest 从归档读取（path 按 basename 重锚定归档目录——
 * manifest 存的是冻结时的绝对路径，直接用会读错地方）；归档在而 manifest 缺失时，
 * 按已知固定文件名（prd.json/decisions.md）探测实际冻结的文件（读出事实，非补造历史）。
 */
/**
 * manifest 存的是冻结时的绝对路径（锚在项目 documents 目录下）。读取按「相对
 * documents 根的相对路径」重锚定归档目录——必须保留 features/ 等合法子目录
 * （2026-08-29 线上：basename 压平子目录导致回看 features/F-001.feature、
 * plantuml/architecture.puml 必 DOCUMENT_NOT_FOUND，live 文档面板用完整路径不受影响）。
 * manifest 被篡改/路径越出 documents 根时回退 basename，行为交由
 * readSnapshotDocument 的防御校验兜底（与旧逻辑一致）。
 */
function reanchorRelativePath(projectId: string, absolutePath: string): string {
  const project = findProject(projectId)
  const documentsDir = getDocumentsDir(project.workspace_slug, project.project_id)
  const rel = relative(resolve(documentsDir), resolve(absolutePath))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return basename(absolutePath)
  return rel.split(/[\\/]/).join('/')
}

export function listSnapshotDocuments(projectId: string, snapshotId: string): SnapshotDocumentListResult {
  const meta = readSnapshotMeta(projectId, snapshotId)
  const archiveDir = snapshotDocumentsDir(meta)
  if (!archiveDir) return { snapshot_id: snapshotId, frozen: false, documents: [] }

  const manifest = readDocumentsManifest(archiveDir)
  const documents: SnapshotDocumentEntry[] = manifest
    .filter((entry) => entry.status !== 'stale')
    .map((entry) => ({
      document_id: entry.document_id,
      type: entry.type,
      status: entry.status,
      file: reanchorRelativePath(projectId, entry.path),
    }))
  if (documents.length > 0) return { snapshot_id: snapshotId, frozen: true, documents }

  // 归档在但 manifest 缺失/为空：探测已知文档文件（老快照兜底，仍只读实际存在的文件）
  const known: Array<{ document_id: string; type: SnapshotDocumentEntry['type']; file: string }> = [
    { document_id: 'prd-frozen', type: 'prd', file: 'prd.json' },
    { document_id: 'decisions-log', type: 'decisions', file: 'decisions.md' },
  ]
  const probed = known.filter((item) => existsSync(join(archiveDir, item.file)))
  return {
    snapshot_id: snapshotId,
    frozen: true,
    documents: probed.map((item) => ({ ...item, status: 'synced' })),
  }
}

/**
 * 读取某快照冻结的文档内容（时间轴回看「当时的想法」）。路径安全：文件必须落在
 * 归档目录内（manifest 可能被篡改，重锚定为归档内相对路径后仍做防御校验；
 * 合法子目录 features/ 等由 reanchorRelativePath 保留）。
 */
export function readSnapshotDocument(
  projectId: string,
  snapshotId: string,
  documentId: string,
): { snapshot_id: string; document: SnapshotDocumentEntry; content: string } {
  const meta = readSnapshotMeta(projectId, snapshotId)
  const archiveDir = snapshotDocumentsDir(meta)
  if (!archiveDir) throw new Error('SNAPSHOT_DOCUMENTS_NOT_FROZEN: 该快照没有冻结文档（存量快照），无法回看当时的想法')
  const entry = listSnapshotDocuments(projectId, snapshotId).documents.find((item) => item.document_id === documentId)
  if (!entry) throw new Error('DOCUMENT_NOT_FOUND')

  const path = resolve(archiveDir, entry.file)
  const rel = relative(resolve(archiveDir), path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`DOCUMENT_PATH_SAFETY: path outside snapshot documents archive: ${entry.file}`)
  }
  if (!existsSync(path)) throw new Error('DOCUMENT_NOT_FOUND')
  return { snapshot_id: snapshotId, document: entry, content: readFileSync(path, 'utf8') }
}

/**
 * 快照容量策略（A2-16）：单项目活跃快照超上限（100）时，按
 * 「保留最近 N + 每 kind 最新」保护集，把最旧的其余快照归档到 archive/。
 * 归档仅移出活跃集、不删除数据；归档合并/清理留给后续迭代。
 */
export function enforceSnapshotCapacity(workspaceSlug: string, projectId: string): SnapshotCapacityResult {
  const snapshotDir = getSnapshotsDir(workspaceSlug, projectId)
  const active = listActiveSnapshots(snapshotDir)
  const cap = resolveSnapshotCap()
  if (active.length <= cap) return { active_count: active.length, archived: [] }

  // 保护集：最近 SNAPSHOT_RECENT_KEEP 个 + 每种 kind 最新一个
  const byNewest = [...active].sort((a, b) => b.created_at.localeCompare(a.created_at))
  const protectedIds = new Set<string>()
  for (const snap of byNewest.slice(0, SNAPSHOT_RECENT_KEEP)) protectedIds.add(snap.snapshot_id)
  const seenKinds = new Set<string>()
  for (const snap of byNewest) {
    if (seenKinds.has(snap.kind)) continue
    seenKinds.add(snap.kind)
    protectedIds.add(snap.snapshot_id)
  }

  // 最旧优先归档，直到活跃数回落到上限；保护集内永不归档
  const oldestFirst = [...active].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const archiveDir = join(snapshotDir, 'archive')
  const archived: string[] = []
  for (const snap of oldestFirst) {
    if (active.length - archived.length <= cap) break
    if (protectedIds.has(snap.snapshot_id)) continue
    const source = join(snapshotDir, snap.snapshot_id)
    if (!existsSync(source)) continue
    mkdirSync(archiveDir, { recursive: true })
    renameSync(source, join(archiveDir, snap.snapshot_id))
    const indexSource = `${source}.json`
    if (existsSync(indexSource)) renameSync(indexSource, join(archiveDir, `${snap.snapshot_id}.json`))
    archived.push(snap.snapshot_id)
  }
  return { active_count: active.length - archived.length, archived }
}

interface ActiveSnapshotMeta {
  snapshot_id: string
  kind: string
  created_at: string
}

function listActiveSnapshots(snapshotDir: string): ActiveSnapshotMeta[] {
  const result: ActiveSnapshotMeta[] = []
  for (const entry of readdirSync(snapshotDir)) {
    const full = join(snapshotDir, entry)
    if (!statSync(full).isDirectory() || entry === 'archive') continue
    const meta = readJsonFile<Snapshot | null>(join(full, 'metadata.json'), null)
    if (!meta?.snapshot_id) continue
    result.push({ snapshot_id: meta.snapshot_id, kind: meta.kind, created_at: meta.created_at })
  }
  return result
}

/** 归档回滚支持（全链路审查 P1-14，2026-10-01）：容量治理把超限快照 rename 进
 *  archive/ 后，回滚/恢复入口只查活跃索引会报 SNAPSHOT_NOT_FOUND——数据物理保留但
 *  产品内永久不可达（「归档不删除」对用户等价于丢失）。本 helper 在活跃索引未命中时
 *  查 archive/，命中则把目录与索引原子搬回活跃集再继续（搬回后重新受容量治理管理）。 */
function ensureSnapshotActive(snapshotDir: string, snapshotId: string): void {
  const activeIndex = `${snapshotDir}/${snapshotId}.json`
  if (existsSync(activeIndex)) return
  const archiveIndex = join(snapshotDir, 'archive', `${snapshotId}.json`)
  if (!existsSync(archiveIndex)) throw new Error('SNAPSHOT_NOT_FOUND')
  const archiveDir = join(snapshotDir, 'archive', snapshotId)
  if (!existsSync(archiveDir)) throw new Error('SNAPSHOT_NOT_FOUND')
  console.warn(`[snapshot] 目标快照 ${snapshotId.slice(0, 8)} 已被容量治理归档，从 archive 搬回活跃集后回滚`)
  renameSync(archiveDir, join(snapshotDir, snapshotId))
  renameSync(archiveIndex, activeIndex)
}

export async function rollbackSnapshot(input: SnapshotRollbackInput): Promise<RollbackResult> {
  const project = findProject(input.project_id)

  // 1. 校验目标快照存在（含元数据读取，详见 restoreSnapshotFiles）；归档快照自动搬回
  const snapshotDir = getSnapshotsDir(project.workspace_slug, project.project_id)
  ensureSnapshotActive(snapshotDir, input.snapshot_id)

  // 2. 回滚前拍 guard 快照（保留回滚前状态）
  const guard = await createSnapshot({
    request_id: input.request_id,
    project_id: input.project_id,
    kind: 'rollback_guard',
    summary: `回滚前保护快照：${input.reason}`,
    include_documents: true,
    health_status: project.current_snapshot_id ? 'healthy' : 'unhealthy',
  })

  // 文档是否随回滚（T7）：目标快照有文档归档才恢复——存量快照（T7 前无冻结）
  // 如实报告 documents_restored=false，渲染端提示「该快照无冻结文档」，绝不补造。
  const target = readJsonFile<Snapshot | null>(`${snapshotDir}/${input.snapshot_id}.json`, null)
  const documentsRestored = Boolean(target?.documents_archive_path && existsSync(target.documents_archive_path))

  // 3~7. 停沙箱 → 恢复文件/文档 → 更新指针（与启动对账共用的恢复原语）
  const restored = await restoreSnapshotFiles(input)

  // 8. 重启 sandbox
  const sandbox = await runSandbox({ request_id: input.request_id, project_id: input.project_id })

  // 9. Phase 7 U3 I6（BLOMA_RESTORE_AS_VERSION on）：恢复即新版本——恢复后的状态拍
  // restored 快照（derived_from 指向源版本），时间线上「恢复」是前进动作而非后退；
  // 后续新版本从恢复点继续，源版本到恢复前之间的版本由 guard 快照保留可找回。
  // off = 不拍（字节级现状：回滚后无新版本记录）。
  let restoredSnapshotId: string | undefined
  if (restoreAsVersionEnabled()) {
    try {
      const restored = await createSnapshot({
        request_id: input.request_id,
        project_id: input.project_id,
        kind: 'restored',
        summary: `从「${target?.name ?? input.snapshot_id.slice(0, 8)}」恢复的版本：应用与它在 Bloma 内保存的数据一起回到那一版；恢复前的状态已由保护快照保留`,
        include_documents: true,
        health_status: 'healthy',
        derived_from: input.snapshot_id,
      })
      restoredSnapshotId = restored.snapshot_id
      // 指针前移到恢复点（restoreSnapshotFiles 先指回源版本，restored 拍完后指新版本）
      updateProject(input.project_id, { current_snapshot_id: restored.snapshot_id })
    } catch (error) {
      console.error('[snapshot] restored 快照创建失败（不影响回滚结果）:', error)
    }
  }

  return {
    rolled_back: true,
    project_id: project.project_id,
    current_snapshot_id: restoredSnapshotId ?? input.snapshot_id,
    guard_snapshot_id: guard.snapshot_id,
    preview_url: sandbox.preview_url,
    documents_restored: documentsRestored,
    ...(restored.dataBackupDir ? { data_backup_dir: restored.dataBackupDir } : {}),
  }
}

/** Phase 7 U3 I6 开关：BLOMA_RESTORE_AS_VERSION 缺省 off（回滚不拍 restored 快照）。 */
export function restoreAsVersionEnabled(): boolean {
  const raw = (process.env.BLOMA_RESTORE_AS_VERSION ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true'
}

/**
 * Phase 10 W1-2 开关：BLOMA_ROLLBACK_CODE_ONLY 缺省 off（data/ 随快照精确回滚=现状）。
 * on：回滚只回代码与文档——data/ 先备份到 data-backups/<快照短id>-<时间戳>/ 再保护性
 * 保留（真实使用语义：用户数据不因代码回滚而丢失）；沙箱实验语义仍可用 off 回现状。
 */
export function rollbackCodeOnlyEnabled(): boolean {
  const raw = (process.env.BLOMA_ROLLBACK_CODE_ONLY ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true'
}

/**
 * 快照文件恢复原语（不含 guard / 沙箱重启）：
 * 停掉运行中的沙箱并等待退出（Windows 句柄锁）→ 清空项目目录 → 复制快照文件 →
 * 恢复文档归档（如有）→ 更新 current_snapshot_id 指针。
 * rollbackSnapshot（完整事务）与启动对账 T1（崩溃残留恢复，不重启沙箱）共用。
 */
/** Phase 10 W1-1：快照/恢复双侧排除的顶层目录（基础设施常开，与 BLOMA_PROJECT_GIT 开关无关）。
 *  W2（2026-09-18）：增 node_modules——vendor 钉版供货确定性可重建（回滚后预览引擎幂等补拷），
 *  归档含它只会膨胀快照（Express 依赖树 MB 级）。旧项目无此目录零影响。 */
export const SNAPSHOT_PRESERVED_TOPLEVEL = ['.git', 'data-backups', 'node_modules'] as const

/** venv/缓存目录排除（快照归档不携带环境产物；标记法同 security-scan 根治口径）。 */
const SNAPSHOT_EXCLUDED_DIR_NAMES = new Set(['.venv', 'venv', 'env', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox', '.gradle'])

function isExcludedEnvironmentDir(src: string): boolean {
  const name = basename(src)
  if (SNAPSHOT_EXCLUDED_DIR_NAMES.has(name)) return true
  try {
    return existsSync(join(src, 'pyvenv.cfg'))
  } catch {
    return false
  }
}

function isPreservedToplevel(rootPath: string, src: string): boolean {
  const rel = relative(rootPath, src)
  if (!rel || rel.startsWith('..')) return false
  const first = rel.split(sep)[0]
  return (SNAPSHOT_PRESERVED_TOPLEVEL as readonly string[]).includes(first)
}

/** R0.6：恢复原语返回值——目标快照 + 回滚前 data/ 备份目录（存在时）。 */
export interface RestoreSnapshotOutcome {
  snapshot: Snapshot
  /** 回滚前 data/ 存在时无条件备份的目录（data-backups/<短id>-<ts>，绝对路径） */
  dataBackupDir?: string
}

export async function restoreSnapshotFiles(input: {
  request_id: string
  project_id: string
  snapshot_id: string
}): Promise<RestoreSnapshotOutcome> {
  const project = findProject(input.project_id)
  const snapshotDir = getSnapshotsDir(project.workspace_slug, project.project_id)

  // 归档快照支持：与 rollbackSnapshot 同源（全链路审查 P1-14）
  ensureSnapshotActive(snapshotDir, input.snapshot_id)
  const targetPath = `${snapshotDir}/${input.snapshot_id}.json`
  if (!existsSync(targetPath)) throw new Error('SNAPSHOT_NOT_FOUND')
  const target = readJsonFile<Snapshot>(targetPath, null as never)
  if (!target) throw new Error('SNAPSHOT_NOT_FOUND')

  // 停掉正在运行的 sandbox 并等待其真正退出（Windows：进程 cwd/句柄锁住项目目录，
  // 不等退出就 rmSync 会 EBUSY/EPERM——2026-08-15 赛车项目回滚报障的根因）
  await stopSandbox({ request_id: input.request_id, project_id: project.project_id })

  // 恢复项目文件（先清空再复制，确保与快照完全一致）。
  // maxRetries/retryDelay 兜底瞬态锁（杀毒/索引器/句柄异步释放）：
  // Node 原生对 EBUSY/EPERM/ENOTEMPTY 自动重试，避免一次撞锁让整个回滚失败。
  // Phase 10 W1-1：恢复前把受保护顶层目录挪出（同盘 rename 零拷贝）——.git 是产物
  // 版本史（回滚不回退历史）、data-backups 是回滚前用户数据备份（W1-2）。归档本就
  // 不含它们（createSnapshot filter）；挪回前若归档带回同名目录（历史遗留）让位删除。
  // Phase 10 W1-2（BLOMA_ROLLBACK_CODE_ONLY on）：data/ 同样保护——先整份备份到
  // data-backups/ 再随受保护目录一起挪出，回滚只回代码与文档（用户数据不丢）。
  // R0.6（2026-09-19 狗粮 7601e5ae）：备份无条件化——off 语义下 data/ 虽随快照回滚
  // （目录被清空重建），但回滚前的数据先整份备份到 data-backups/（狗粮实锤四次熔断
  // 后 data/ 无声消失且话术称「内容都还在」；备份让数据可找回，话术据此如实）。
  const codeOnly = rollbackCodeOnlyEnabled()
  const dataPath = join(project.root_path, 'data')
  let dataBackupDir: string | undefined
  if (existsSync(dataPath)) {
    dataBackupDir = join(project.root_path, 'data-backups', `${input.snapshot_id.slice(0, 8)}-${Date.now()}`)
    mkdirSync(dataBackupDir, { recursive: true })
    cpSync(dataPath, dataBackupDir, { recursive: true, force: true })
  }
  const preservedNames: string[] = codeOnly
    ? [...SNAPSHOT_PRESERVED_TOPLEVEL, 'data']
    : [...SNAPSHOT_PRESERVED_TOPLEVEL]
  const preserved: Array<{ temp: string; dest: string }> = []
  for (const name of preservedNames) {
    const dest = join(project.root_path, name)
    if (!existsSync(dest)) continue
    const temp = `${project.root_path}.__preserve_${name}_${Date.now()}`
    renameSync(dest, temp)
    preserved.push({ temp, dest })
  }
  try {
    // 原子切换（全链路审查 P1-7/P1-6，2026-10-01）：旧实现「rm 项目根 → mkdir → cpSync」
    // 在 cpSync 失败（归档损坏/杀毒锁/磁盘错）时项目根已被清空且无备份层——快照之后的
    // agent 进度永久丢失。改为「先完整复制到同级临时目录，成功后才切换」：任何一步
    // 失败都保持旧根原样（无损）；切换用同盘 rename（原子），旧根延迟删除。
    const restoreTmp = `${project.root_path}.__restore_${Date.now()}`
    const rootOld = `${project.root_path}.__old_${Date.now()}`
    try {
      mkdirSync(restoreTmp, { recursive: true })
      cpSync(target.files_archive_path, restoreTmp, { recursive: true, force: true })
      renameSync(project.root_path, rootOld)
      try {
        renameSync(restoreTmp, project.root_path)
      } catch (swapError) {
        // 切换失败：把旧根换回来（恢复到操作前状态），再向上抛
        renameSync(rootOld, project.root_path)
        throw swapError
      }
      rmSync(rootOld, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch (restoreError) {
      // 复制阶段失败：清理临时目录，项目根未动（无损）
      try {
        if (existsSync(restoreTmp)) rmSync(restoreTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        /* 清理失败随目录回收 */
      }
      throw restoreError
    }
  } finally {
    for (const p of preserved) {
      if (existsSync(p.dest)) rmSync(p.dest, { recursive: true, force: true })
      renameSync(p.temp, p.dest)
    }
  }

  // 恢复文档（如果有）
  if (target.documents_archive_path && existsSync(target.documents_archive_path)) {
    const docDir = getDocumentsDir(project.workspace_slug, project.project_id)
    rmSync(docDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    cpSync(target.documents_archive_path, docDir, { recursive: true, force: true })
  }

  updateProject(project.project_id, { current_snapshot_id: input.snapshot_id })
  return { snapshot: target, ...(dataBackupDir ? { dataBackupDir } : {}) }
}

export function setSnapshotCaptureProvider(provider?: SnapshotCaptureProvider): void {
  snapshotCaptureProvider = provider ?? defaultSnapshotCapture
}

export function setSnapshotCaptureProviderForTests(provider?: SnapshotCaptureProvider): void {
  snapshotCaptureProvider = provider ?? defaultSnapshotCapture
}

