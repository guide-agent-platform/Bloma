import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkDataMigrationDiscipline,
  dataMigrateContractSection,
  dataMigrateEnabled,
  runMigrationDrill,
} from '../../main/coding/data-migration'

/**
 * Phase 10 W1-5（2026-09-16）：数据迁移守卫——schema 版本 + _migrate.js 约定 + 终验
 * 迁移演练（临时副本，源数据零触碰）。关键语义：①开关缺省 off=纪律段空串零注入；
 * ②discipline 四态纯信息；③演练 pass/fail/skip 三态——版本到位/行数不减/标识不丢/
 * 无异常；④演练绝不改动真实 data/。
 */
describe('data-migration 开关与纪律段', () => {
  const originalSwitch = process.env.BLOMA_DATA_MIGRATE

  afterEach(() => {
    if (originalSwitch === undefined) delete process.env.BLOMA_DATA_MIGRATE
    else process.env.BLOMA_DATA_MIGRATE = originalSwitch
  })

  it('缺省 off；1/true 开；0/off/false 关；off 时纪律段为空串', () => {
    delete process.env.BLOMA_DATA_MIGRATE
    expect(dataMigrateEnabled()).toBe(false)
    expect(dataMigrateContractSection()).toBe('')
    process.env.BLOMA_DATA_MIGRATE = '1'
    expect(dataMigrateEnabled()).toBe(true)
    process.env.BLOMA_DATA_MIGRATE = 'false'
    expect(dataMigrateEnabled()).toBe(false)
    process.env.BLOMA_DATA_MIGRATE = 'true'
    expect(dataMigrateEnabled()).toBe(true)
    process.env.BLOMA_DATA_MIGRATE = '0'
    expect(dataMigrateEnabled()).toBe(false)
  })

  it('on 时纪律段含三条款（版本文件/迁移模块/禁弃数据）', () => {
    process.env.BLOMA_DATA_MIGRATE = '1'
    const section = dataMigrateContractSection()
    expect(section).toContain('【数据迁移纪律】')
    expect(section).toContain('schema-version')
    expect(section).toContain('_migrate.js')
    expect(section).toContain('禁止丢弃')
  })
})

interface ProjectFixture {
  root: string
  dataDir: string
}

function makeProject(opts: { version?: string; notes?: unknown[]; migrateJs?: string }): ProjectFixture {
  const root = mkdtempSync(join(tmpdir(), 'proma-dm-'))
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  if (opts.notes !== undefined) writeFileSync(join(dataDir, 'notes.json'), JSON.stringify(opts.notes), 'utf8')
  if (opts.version !== undefined) writeFileSync(join(dataDir, 'schema-version.json'), JSON.stringify(opts.version), 'utf8')
  if (opts.migrateJs !== undefined) {
    mkdirSync(join(root, 'server', 'routes'), { recursive: true })
    writeFileSync(join(root, 'server', 'routes', '_migrate.js'), opts.migrateJs, 'utf8')
  }
  return { root, dataDir }
}

const NOTES = [
  { id: 'n1', content: '第一条' },
  { id: 'n2', content: '第二条' },
  { id: 'n3', content: '第三条' },
]

describe('checkDataMigrationDiscipline 四态', () => {
  it('无目录/空目录（仅版本文件）=no_data；有数据无版本=unversioned；有版本无迁移=ok；有迁移=drill', () => {
    const empty = makeProject({})
    expect(checkDataMigrationDiscipline(empty.root).status).toBe('no_data')
    const onlyVersion = makeProject({ version: '1' })
    expect(checkDataMigrationDiscipline(onlyVersion.root).status).toBe('no_data')
    const unversioned = makeProject({ notes: NOTES })
    expect(checkDataMigrationDiscipline(unversioned.root).status).toBe('unversioned')
    const ok = makeProject({ notes: NOTES, version: '2' })
    const okResult = checkDataMigrationDiscipline(ok.root)
    expect(okResult.status).toBe('ok')
    expect(okResult.version).toBe('2')
    const drill = makeProject({ notes: NOTES, version: '1', migrateJs: 'module.exports={from:"1",to:"2",run:async(c)=>{}}' })
    expect(checkDataMigrationDiscipline(drill.root).status).toBe('drill')
  })
})

describe('runMigrationDrill 演练', () => {
  it('pass：加字段+写版本→行数与标识校验全过；源数据零触碰', async () => {
    const migrateJs = [
      'module.exports = {',
      "  from: '1', to: '2',",
      '  run: async (ctx) => {',
      "    const notes = ctx.readData('notes', [])",
      "    ctx.writeData('notes', notes.map((n) => ({ ...n, tag: '未分类' })))",
      "    ctx.writeData('.schema-version', '2')",
      '  },',
      '};',
    ].join('\n')
    const { root } = makeProject({ notes: NOTES, version: '1', migrateJs })
    const result = await runMigrationDrill(root)
    expect(result.status).toBe('pass')
    expect(result.summary).toContain('1→2')
    // 源数据零触碰：真实 notes.json 仍是原样、版本仍是 1
    expect(readFileSync(join(root, 'data', 'notes.json'), 'utf8')).toBe(JSON.stringify(NOTES))
    expect(readFileSync(join(root, 'data', 'schema-version.json'), 'utf8')).toBe(JSON.stringify('1'))
  })

  it('fail：迁移丢行（filter）→行数减少条目', async () => {
    const migrateJs = [
      'module.exports = {',
      "  from: '1', to: '2',",
      '  run: async (ctx) => {',
      "    const notes = ctx.readData('notes', [])",
      "    ctx.writeData('notes', notes.filter((n) => n.id !== 'n2'))",
      "    ctx.writeData('.schema-version', '2')",
      '  },',
      '};',
    ].join('\n')
    const { root } = makeProject({ notes: NOTES, version: '1', migrateJs })
    const result = await runMigrationDrill(root)
    expect(result.status).toBe('fail')
    expect(result.failures.some((f) => f.reason.includes('行数减少'))).toBe(true)
  })

  it('fail：run 未写目标版本→版本到位条目；fail：标识字段漂移', async () => {
    const noVersionWrite = 'module.exports = { from: "1", to: "2", run: async (ctx) => { ctx.readData("notes", []) } };'
    const p1 = makeProject({ notes: NOTES, version: '1', migrateJs: noVersionWrite })
    const r1 = await runMigrationDrill(p1.root)
    expect(r1.status).toBe('fail')
    expect(r1.failures.some((f) => f.scenario.includes('版本到位'))).toBe(true)

    const idDrift = [
      'module.exports = { from: "1", to: "2", run: async (ctx) => {',
      '  const notes = ctx.readData("notes", [])',
      '  ctx.writeData("notes", notes.map((n, i) => ({ ...n, id: "x" + i })))',
      '  ctx.writeData(".schema-version", "2")',
      '} };',
    ].join('\n')
    const p2 = makeProject({ notes: NOTES, version: '1', migrateJs: idDrift })
    const r2 = await runMigrationDrill(p2.root)
    expect(r2.status).toBe('fail')
    expect(r2.failures.some((f) => f.reason.includes('标识'))).toBe(true)
  })

  it('fail：版本覆盖不到（当前 5，迁移 1→2）；skip：已在目标版本', async () => {
    const migrateJs = 'module.exports = { from: "1", to: "2", run: async () => {} };'
    const gap = makeProject({ notes: NOTES, version: '5', migrateJs })
    const rGap = await runMigrationDrill(gap.root)
    expect(rGap.status).toBe('fail')
    expect(rGap.failures[0].reason.includes('覆盖不到')).toBe(true)

    const already = makeProject({ notes: NOTES, version: '2', migrateJs })
    const rAlready = await runMigrationDrill(already.root)
    expect(rAlready.status).toBe('skip')
    expect(rAlready.summary).toContain('已在目标版本')
  })

  it('fail：run 抛错；fail：模块契约不完整（缺 run）', async () => {
    const throws = 'module.exports = { from: "1", to: "2", run: async () => { throw new Error("迁移实现有 bug") } };'
    const p1 = makeProject({ notes: NOTES, version: '1', migrateJs: throws })
    const r1 = await runMigrationDrill(p1.root)
    expect(r1.status).toBe('fail')
    expect(r1.failures.some((f) => f.reason.includes('抛错'))).toBe(true)

    const incomplete = 'module.exports = { from: "1", to: "2" };'
    const p2 = makeProject({ notes: NOTES, version: '1', migrateJs: incomplete })
    const r2 = await runMigrationDrill(p2.root)
    expect(r2.status).toBe('fail')
    expect(r2.failures.some((f) => f.reason.includes('from, to, run'))).toBe(true)
  })

  it('skip：无 _migrate.js 或无版本文件', async () => {
    const noMigrate = makeProject({ notes: NOTES, version: '1' })
    expect((await runMigrationDrill(noMigrate.root)).status).toBe('skip')
    const noVersion = makeProject({ notes: NOTES, migrateJs: 'module.exports = { from: "1", to: "2", run: async () => {} };' })
    expect((await runMigrationDrill(noVersion.root)).status).toBe('skip')
    void existsSync
  })
})
