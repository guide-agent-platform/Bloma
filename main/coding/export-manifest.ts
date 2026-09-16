/**
 * Phase 10 W1-6（2026-09-16，咨询 G 收口·真实项目交付体系）：导出清单与升级导出。
 * 交付模式的最小升级链：①导出包带文件 manifest（sha256 相对路径清单，export-manifest.json）
 * 与 export-info v2 字段（project_id/git 基线）——落地产物手改可检测（漂移对账）；
 * ②upgradeExport 升级导出：新代码（项目树）+ 携带落地产物旧 data/（先备份到
 * data-backups/pre-upgrade/）+ 真实执行 _migrate 迁移（复用 data-migration 的
 * executeMigration）+ upgrade-report.json 校验报告 + 重建 manifest。
 * 责任边界：manifest 只检测手改不合并手改（诚实提示）；升级失败如实写入报告。
 * 依赖：node 标准库 + data-migration（executeMigration）。manifest 范围与导出排除集
 * 同构（node_modules/.git/dist/dist-main 之外全部入册，data/ 含在内——升级要认数据）。
 * 开关 BLOMA_EXPORT_V2：'1'/'on'/'true'=开（导出写 manifest+v2 字段）；未设/'0'/
 * 'off'/'false'=关（缺省 off，exportProjectHandoff 行为字节级现状；upgradeExport
 * 函数级能力，IPC/UI 接线登记待办 v1）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { executeMigration } from './data-migration'

/** 开关解析（与 dataMigrateEnabled 同风格）。 */
export function exportManifestEnabled(): boolean {
  const raw = (process.env.BLOMA_EXPORT_V2 ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true'
}

const MANIFEST_EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-main'])
export const MANIFEST_FILE = 'export-manifest.json'

export type ExportManifest = Record<string, string>

/** 递归复制目录（逐文件 copyFileSync）——Windows Node 22 实测：fs.cpSync(recursive)
 *  源目录名含非 ASCII 时段错误（中文项目名必踩），故本模块一律逐文件复制。 */
function copyTree(source: string, target: string): void {
  mkdirSync(target, { recursive: true })
  for (const e of readdirSync(source, { withFileTypes: true })) {
    if (e.isDirectory()) copyTree(join(source, e.name), join(target, e.name))
    else if (e.isFile()) copyFileSync(join(source, e.name), join(target, e.name))
  }
}

/** 构建目录清单（相对路径 → sha256；排除集与导出复制同构）。 */
export function buildExportManifest(root: string): ExportManifest {
  const manifest: ExportManifest = {}
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!MANIFEST_EXCLUDE_DIRS.has(e.name)) walk(full)
      } else if (e.isFile()) {
        const rel = relative(root, full).replace(/\\/g, '/')
        if (rel === MANIFEST_FILE) continue
        try {
          manifest[rel] = createHash('sha256').update(readFileSync(full)).digest('hex').slice(0, 16)
        } catch {
          // 不可读文件跳过（不编造哈希）
        }
      }
    }
  }
  if (existsSync(root)) walk(root)
  return manifest
}

export function writeExportManifest(root: string, manifest: ExportManifest): void {
  writeFileSync(join(root, MANIFEST_FILE), JSON.stringify({ algorithm: 'sha256-16', files: manifest }, null, 2), 'utf8')
}

export function readExportManifest(root: string): ExportManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(join(root, MANIFEST_FILE), 'utf8')) as { files?: ExportManifest }
    return parsed.files && typeof parsed.files === 'object' ? parsed.files : null
  } catch {
    return null
  }
}

export interface DriftResult {
  clean: boolean
  changed: string[]
  missing: string[]
  extra: string[]
}

/** 漂移对账：落地产物 vs 导出清单（手改/缺失/新增）。无 manifest → clean=true + 空。 */
export function detectDrift(landedRoot: string): DriftResult {
  const baseline = readExportManifest(landedRoot)
  if (!baseline) return { clean: true, changed: [], missing: [], extra: [] }
  const current = buildExportManifest(landedRoot)
  const changed: string[] = []
  const missing: string[] = []
  for (const [file, hash] of Object.entries(baseline)) {
    if (!(file in current)) missing.push(file)
    else if (current[file] !== hash) changed.push(file)
  }
  const extra = Object.keys(current).filter((f) => !(f in baseline))
  return { clean: changed.length === 0 && missing.length === 0 && extra.length === 0, changed, missing, extra }
}

/** 产物 git 基线（W1-1 开启时有值；git 不可用/无提交 → undefined，如实标 absent）。 */
export function readProjectGitCommit(projectRoot: string): string | undefined {
  try {
    const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: projectRoot, timeout: 5000, windowsHide: true, encoding: 'utf8' })
    if (r.status !== 0) return undefined
    const hash = String(r.stdout ?? '').trim()
    return hash || undefined
  } catch {
    return undefined
  }
}

export interface UpgradeExportResult {
  target: string
  migration: 'ran' | 'none' | 'failed'
  summary: string
  drift: DriftResult
}

/**
 * 升级导出 v0（函数级；IPC/UI 接线 v1）：新代码 + 旧数据携带 + 真实迁移 + 报告。
 * landedRoot 为已落地运行的旧版导出包（data/ 是真实数据源）；drift 先对账并在报告中
 * 如实呈现（手改文件不合并不覆盖数据侧文件——数据以落地方为准）。
 */
export async function upgradeExport(input: { projectRoot: string; landedRoot: string; destination: string; projectName: string }): Promise<UpgradeExportResult> {
  const safeName = input.projectName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || '未命名项目'
  const target = join(input.destination, `${safeName}-upgraded`)
  const drift = detectDrift(input.landedRoot)

  // 1) 新代码树（排除集同导出；先清目标防陈旧残留）
  if (existsSync(target)) rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  copyCodeTree(input.projectRoot, target)

  // 2) 旧数据携带：项目侧 data/ 让位，落地产物 data/ 为准；升级前备份进 data-backups/pre-upgrade/
  const landedData = join(input.landedRoot, 'data')
  if (existsSync(landedData)) {
    const targetData = join(target, 'data')
    if (existsSync(targetData)) rmSync(targetData, { recursive: true, force: true })
    copyTree(landedData, join(target, 'data-backups', 'pre-upgrade'))
    copyTree(landedData, targetData)
  }

  // 3) 真实迁移（executeMigration 直接作用于目标包 data/；失败如实入报告）
  const migration = await executeMigration(target, join(target, 'data'))

  // 4) 报告 + 新 manifest
  const report = {
    upgraded_at: new Date().toISOString(),
    source: { project: input.projectName, git_commit: readProjectGitCommit(input.projectRoot) ?? null },
    drift_before_upgrade: drift,
    migration: { status: migration.status, summary: migration.summary, failures: migration.failures },
    note: drift.clean
      ? '落地产物与导出清单一致（无手改痕迹）。'
      : `检测到落地产物与导出清单不一致（手改 ${drift.changed.length}、缺失 ${drift.missing.length}、新增 ${drift.extra.length}）——本次升级以平台项目代码与落地产物数据为准，手改内容不合并，请自行复核。`,
  }
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'upgrade-report.json'), JSON.stringify(report, null, 2), 'utf8')
  const manifest = buildExportManifest(target)
  writeExportManifest(target, manifest)

  return {
    target,
    migration: migration.status === 'pass' ? 'ran' : migration.status === 'fail' ? 'failed' : 'none',
    summary: migration.summary,
    drift,
  }
}

/** 代码树复制（排除 data/ 与清单排除集——数据由落地方携带）。 */
function copyCodeTree(source: string, target: string): void {
  mkdirSync(target, { recursive: true })
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (MANIFEST_EXCLUDE_DIRS.has(e.name) || e.name === 'data' || e.name === 'data-backups') continue
        mkdirSync(join(target, rel, e.name), { recursive: true })
        walk(join(dir, e.name), join(rel, e.name))
      } else if (e.isFile()) {
        copyFileSync(join(dir, e.name), join(target, rel, e.name))
      }
    }
  }
  walk(source, '')
}
