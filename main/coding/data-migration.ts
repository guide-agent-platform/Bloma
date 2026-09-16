/**
 * Phase 10 W1-5（2026-09-16，咨询 G 收口·真实项目交付体系）：数据迁移守卫。
 * 「真实数据」承诺的最小闸门：改 data/ 结构必须带迁移，禁弃旧数据重建。
 * 产物侧约定（骨架只读样例 server/routes/_migrate.example.js）：data/.schema-version
 * 纯文本版本号 + server/routes/_migrate.js（CJS：{from,to,run(ctx)}，ctx 与路由同款
 * readData/writeData）。
 * 平台侧三件：①纪律段进 loop system（首次写 data/ 建版本文件/改结构必带迁移）；
 * ②checkDataMigrationDiscipline 磁盘扫描（no_data/unversioned/ok/drill 四态，纯信息
 * 不判败）；③runMigrationDrill 终验迁移演练——data/ 临时副本上执行 _migrate.run 并
 * 校验（版本到位/行数不减/标识字段不丢/无异常），失败以 GwtFailureSummary 并入
 * runGwtWithApiContract（api-reconcile 同款合并位）。
 * 依赖：node 标准库 + gwt-service（GwtFailureSummary 类型）。演练用 createRequire
 * 加载产物 CJS 模块；临时目录 finally 清理。
 * 开关 BLOMA_DATA_MIGRATE：'1'/'on'/'true'=开；未设/'0'/'off'/'false'=关（缺省 off，
 * 纪律段零注入、终验零接入，字节级现状）。
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import type { GwtFailureSummary } from '../gwt-service'

/** 开关解析（与 apiReconcileEnabled 同风格，每次调用读取）。 */
export function dataMigrateEnabled(): boolean {
  const raw = (process.env.BLOMA_DATA_MIGRATE ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true'
}

/** loop system 的【数据迁移纪律】段（off='' 零注入）。 */
export function dataMigrateContractSection(): string {
  if (!dataMigrateEnabled()) return ''
  return [
    '【数据迁移纪律】data/ 是用户真实数据：',
    '1. 首次写入 data/ 时创建版本文件：ctx.writeData(\'schema-version\', \'1\')（落盘为 data/schema-version.json，内容为 JSON 字符串）；此后每次改动数据结构（加字段/改语义/拆文件）把版本 +1。',
    '2. 改数据结构的变更必须同时提供 server/routes/_migrate.js（CJS：module.exports={from,to,run(ctx)}，ctx.readData/ctx.writeData 与路由同款；样例见 _migrate.example.js），迁移完 ctx.writeData(\'schema-version\', \'目标版本\')。',
    '3. 禁止丢弃/清空旧数据重建「迁移」；平台终验会在数据副本上演练迁移并校验行数与既有记录不丢。',
  ].join('\n')
}

export interface DataMigrationDiscipline {
  status: 'no_data' | 'unversioned' | 'ok' | 'drill'
  version?: string
  note: string
}

/** 磁盘扫描（纯信息四态，不判败；终验按态决定是否演练）。 */
export function checkDataMigrationDiscipline(projectRoot: string): DataMigrationDiscipline {
  const dataDir = join(projectRoot, 'data')
  if (!existsSync(dataDir)) return { status: 'no_data', note: '无 data/ 目录' }
  const dataEntries = readdirSync(dataDir).filter((f) => f !== 'schema-version.json')
  if (dataEntries.length === 0) return { status: 'no_data', note: 'data/ 为空' }
  const version = readVersionFile(dataDir)
  if (version === null) {
    return { status: 'unversioned', note: 'data/ 有数据但无 schema-version.json（首次写数据时应建版本文件，见【数据迁移纪律】）' }
  }
  const migratePath = join(projectRoot, 'server', 'routes', '_migrate.js')
  if (!existsSync(migratePath)) return { status: 'ok', version, note: `版本 ${version}，无待执行迁移` }
  return { status: 'drill', version, note: `版本 ${version}，存在 _migrate.js——执行迁移演练` }
}

/** 读版本文件 data/schema-version.json（JSON 字符串；宽容裸文本），缺失返回 null。 */
function readVersionFile(dataDir: string): string | null {
  try {
    const raw = readFileSync(join(dataDir, 'schema-version.json'), 'utf8').trim()
    if (raw === '') return null
    try {
      const parsed: unknown = JSON.parse(raw)
      return typeof parsed === 'string' ? parsed.trim() : String(parsed)
    } catch {
      return raw
    }
  } catch {
    return null
  }
}

/** 与产物 ctx 同款语义的临时副本读写（readData 自动补 .json；writeData 原子写）。 */
function buildDrillCtx(dataDir: string) {
  const dataPath = (name: string): string => {
    const safe = String(name ?? '').replace(/^([/\\.]+)+/, '')
    const withExt = /\.[a-z0-9]+$/i.test(safe) ? safe : `${safe}.json`
    const p = resolve(join(dataDir, withExt))
    if (!p.startsWith(dataDir + sep)) throw new Error('bad_data_path')
    return p
  }
  return {
    readData: (name: string, fallback: unknown): unknown => {
      try {
        return JSON.parse(readFileSync(dataPath(name), 'utf8'))
      } catch {
        return fallback
      }
    },
    writeData: (name: string, value: unknown): void => {
      const p = dataPath(name)
      mkdirSync(dirname(p), { recursive: true })
      const tmp = `${p}.tmp`
      writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
      renameSync(tmp, p)
    },
  }
}

interface DataSnapshot {
  arrays: Array<{ file: string; length: number; firstIds: Record<string, unknown> }>
  parseable: number
}

function snapshotData(dataDir: string): DataSnapshot {
  const arrays: DataSnapshot['arrays'] = []
  let parseable = 0
  for (const f of readdirSync(dataDir)) {
    if (!f.endsWith('.json') || f === 'schema-version.json') continue
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dataDir, f), 'utf8'))
      parseable += 1
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0] && typeof parsed[0] === 'object') {
        const first = parsed[0] as Record<string, unknown>
        const firstIds: Record<string, unknown> = {}
        for (const key of Object.keys(first)) {
          if (key === 'id' || /Id$/.test(key)) firstIds[key] = first[key]
        }
        arrays.push({ file: f, length: parsed.length, firstIds })
      }
    } catch {
      // 演练前就不可解析：如实跳过（不编造基线）
    }
  }
  return { arrays, parseable }
}

export interface MigrationDrillResult {
  status: 'pass' | 'fail' | 'skip'
  summary: string
  failures: GwtFailureSummary[]
  detail: Record<string, unknown>
}

/** 终验迁移演练：data/ 临时副本上执行 _migrate.run 并校验；任何异常/校验不过=失败。 */
export async function runMigrationDrill(projectRoot: string): Promise<MigrationDrillResult> {
  const migratePath = join(projectRoot, 'server', 'routes', '_migrate.js')
  const dataDir = join(projectRoot, 'data')
  if (!existsSync(migratePath)) {
    return { status: 'skip', summary: '无 _migrate.js，跳过演练', failures: [], detail: {} }
  }
  const currentVersion = readVersionFile(dataDir)
  if (currentVersion === null) {
    return { status: 'skip', summary: '无 schema-version.json，跳过演练', failures: [], detail: {} }
  }
  let migrate: { from?: string; to?: string; run?: (ctx: unknown) => unknown | Promise<unknown> }
  try {
    const req = createRequire(join(projectRoot, 'index.html'))
    delete req.cache[req.resolve(migratePath)]
    migrate = req(migratePath)
  } catch (err) {
    return {
      status: 'fail',
      summary: '_migrate.js 加载失败',
      failures: [{ scenario: '数据迁移演练：模块加载', reason: `server/routes/_migrate.js 无法加载（${String((err as Error)?.message ?? err).slice(0, 160)}）——CJS 格式 module.exports={from,to,run}，样例见 _migrate.example.js` }],
      detail: { load_error: true },
    }
  }
  const from = String(migrate.from ?? '').trim()
  const to = String(migrate.to ?? '').trim()
  if (typeof migrate.run !== 'function' || !from || !to) {
    return {
      status: 'fail',
      summary: '_migrate.js 契约不完整',
      failures: [{ scenario: '数据迁移演练：模块契约', reason: '_migrate.js 须导出 {from, to, run(ctx)}（均为必填，CJS），样例见 _migrate.example.js' }],
      detail: { contract_error: true },
    }
  }
  if (currentVersion === to) {
    return { status: 'skip', summary: `已在目标版本 ${to}，无需演练`, failures: [], detail: { already: to } }
  }
  if (currentVersion !== from) {
    return {
      status: 'fail',
      summary: `迁移覆盖不到当前版本（data/.schema-version=${currentVersion}，_migrate ${from}→${to}）`,
      failures: [{ scenario: '数据迁移演练：版本覆盖不到', reason: `覆盖不到：当前数据版本 ${currentVersion} 不在 _migrate.js 的 ${from}→${to} 区间——补齐迁移链或修正版本号` }],
      detail: { current: currentVersion, from, to },
    }
  }
  const tempData = mkdtempSync(join(tmpdir(), 'proma-migrate-drill-'))
  try {
    cpSync(dataDir, tempData, { recursive: true, force: true })
    const before = snapshotData(tempData)
    const ctx = buildDrillCtx(tempData)
    try {
      await migrate.run(ctx)
    } catch (err) {
      return {
        status: 'fail',
        summary: '_migrate.run 执行抛错',
        failures: [{ scenario: '数据迁移演练：执行', reason: `run(ctx) 抛错：${String((err as Error)?.message ?? err).slice(0, 200)}` }],
        detail: { run_error: true },
      }
    }
    const failures: GwtFailureSummary[] = []
    const afterVersion = readVersionFile(tempData) ?? ''
    if (afterVersion !== to) {
      failures.push({ scenario: '数据迁移演练：版本到位', reason: `迁移后 schema-version 应为 ${to}，实际为「${afterVersion || '（缺失）'}」——迁移完必须 ctx.writeData('schema-version', '${to}')` })
    }
    const after = snapshotData(tempData)
    for (const arr of before.arrays) {
      const afterArr = after.arrays.find((a) => a.file === arr.file)
      if (!afterArr) {
        failures.push({ scenario: `数据迁移演练：${arr.file}`, reason: '迁移后该数据文件缺失或不再是含记录的数组（禁止丢弃/重建旧数据）' })
        continue
      }
      if (afterArr.length < arr.length) {
        failures.push({ scenario: `数据迁移演练：${arr.file}`, reason: `行数减少：迁移前 ${arr.length} 条 → 迁移后 ${afterArr.length} 条（旧记录不可丢）` })
      }
      for (const [key, value] of Object.entries(arr.firstIds)) {
        if (afterArr.firstIds[key] !== value) {
          failures.push({ scenario: `数据迁移演练：${arr.file}`, reason: `首条记录标识字段 ${key} 迁移后改变（${String(value)} → ${String(afterArr.firstIds[key])}）——标识不可漂移` })
        }
      }
    }
    if (failures.length > 0) {
      return { status: 'fail', summary: `迁移演练 ${failures.length} 项不过`, failures, detail: { from, to, files: before.arrays.length } }
    }
    return {
      status: 'pass',
      summary: `迁移演练通过（${from}→${to}，${before.arrays.length} 个数据文件、行数与标识校验全过）`,
      failures: [],
      detail: { from, to, files: before.arrays.length, parseable: before.parseable },
    }
  } finally {
    rmSync(tempData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
