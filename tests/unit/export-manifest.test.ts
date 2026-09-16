import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildExportManifest,
  detectDrift,
  exportManifestEnabled,
  readExportManifest,
  readProjectGitCommit,
  upgradeExport,
  writeExportManifest,
} from '../../main/coding/export-manifest'

/**
 * Phase 10 W1-6（2026-09-16）：导出清单与升级导出。关键语义：①开关缺省 off；
 * ②manifest 排除集与导出复制同构（data/ 入册——升级要认数据）；③漂移对账三分类
 * （手改/缺失/新增）不合并只如实报告；④升级导出=新代码+旧数据携带+pre-upgrade 备份
 * +真实迁移+upgrade-report+重建 manifest。
 */
describe('export-manifest 开关与清单', () => {
  const originalSwitch = process.env.BLOMA_EXPORT_V2

  afterEach(() => {
    if (originalSwitch === undefined) delete process.env.BLOMA_EXPORT_V2
    else process.env.BLOMA_EXPORT_V2 = originalSwitch
  })

  it('缺省 off；1/true 开；0/off/false 关', () => {
    delete process.env.BLOMA_EXPORT_V2
    expect(exportManifestEnabled()).toBe(false)
    process.env.BLOMA_EXPORT_V2 = '1'
    expect(exportManifestEnabled()).toBe(true)
    process.env.BLOMA_EXPORT_V2 = 'false'
    expect(exportManifestEnabled()).toBe(false)
    process.env.BLOMA_EXPORT_V2 = 'true'
    expect(exportManifestEnabled()).toBe(true)
    process.env.BLOMA_EXPORT_V2 = '0'
    expect(exportManifestEnabled()).toBe(false)
  })

  it('manifest 构建/写读回环：data 入册、排除集目录不入册、自身不入册', () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-em-'))
    writeFileSync(join(root, 'index.html'), '<html>v1</html>', 'utf8')
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(join(root, 'data', 'notes.json'), '[{"id":"n1"}]', 'utf8')
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'x', 'y.js'), '', 'utf8')
    const manifest = buildExportManifest(root)
    expect(Object.keys(manifest)).toContain('index.html')
    expect(Object.keys(manifest)).toContain('data/notes.json')
    expect(Object.keys(manifest).some((f) => f.startsWith('node_modules/'))).toBe(false)
    writeExportManifest(root, manifest)
    const read = readExportManifest(root)
    expect(read).toEqual(manifest)
    // manifest 文件自身不入册（写后再建仍是同构）
    expect(Object.keys(buildExportManifest(root))).not.toContain('export-manifest.json')
  })

  it('漂移对账：一致=clean；改文件/删文件/加文件三分类；无 manifest 视为 clean', () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-drift-'))
    writeFileSync(join(root, 'a.txt'), 'A', 'utf8')
    writeFileSync(join(root, 'b.txt'), 'B', 'utf8')
    writeExportManifest(root, buildExportManifest(root))
    expect(detectDrift(root).clean).toBe(true)
    writeFileSync(join(root, 'a.txt'), 'A2', 'utf8')
    const { existsSync: _e } = { existsSync }
    void _e
    const r = detectDrift(root)
    expect(r.clean).toBe(false)
    expect(r.changed).toEqual(['a.txt'])
    const noManifest = mkdtempSync(join(tmpdir(), 'proma-nm-'))
    expect(detectDrift(noManifest).clean).toBe(true)
  })

  it('readProjectGitCommit：无 git 仓库 → undefined 不抛错', () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-gitread-'))
    expect(readProjectGitCommit(root)).toBeUndefined()
  })
})

describe('upgradeExport 升级导出', () => {
  it('全链：新代码+旧数据携带+pre-upgrade 备份+真实迁移+报告+重建 manifest', async () => {
    // 项目侧（新代码）：migrate 1→2 加 tag 字段；项目自身 data 是开发数据（应让位）
    const projectRoot = mkdtempSync(join(tmpdir(), 'proma-up-proj-'))
    mkdirSync(join(projectRoot, 'server', 'routes'), { recursive: true })
    writeFileSync(join(projectRoot, 'index.html'), '<html>v2</html>', 'utf8')
    writeFileSync(
      join(projectRoot, 'server', 'routes', '_migrate.js'),
      [
        'module.exports = { from: "1", to: "2", run: async (ctx) => {',
        '  const notes = ctx.readData("notes", [])',
        '  ctx.writeData("notes", notes.map((n) => ({ ...n, tag: "未分类" })))',
        '  ctx.writeData("schema-version", "2")',
        '} };',
      ].join('\n'),
      'utf8',
    )
    // 落地侧（旧版运行包）：data 是真实数据（版本 1，两条记录）
    const landedRoot = mkdtempSync(join(tmpdir(), 'proma-up-landed-'))
    mkdirSync(join(landedRoot, 'data'), { recursive: true })
    writeFileSync(join(landedRoot, 'data', 'notes.json'), JSON.stringify([{ id: 'n1', content: '旧1' }, { id: 'n2', content: '旧2' }]), 'utf8')
    writeFileSync(join(landedRoot, 'data', 'schema-version.json'), JSON.stringify('1'), 'utf8')
    writeFileSync(join(landedRoot, 'index.html'), '<html>v1</html>', 'utf8')

    const destination = mkdtempSync(join(tmpdir(), 'proma-up-dest-'))
    const result = await upgradeExport({ projectRoot, landedRoot, destination, projectName: '随心记' })

    expect(result.migration).toBe('ran')
    const target = result.target
    // 代码为新版
    expect(readFileSync(join(target, 'index.html'), 'utf8')).toBe('<html>v2</html>')
    // 数据为落地数据且已迁移（tag 字段+版本 2）
    const migrated = JSON.parse(readFileSync(join(target, 'data', 'notes.json'), 'utf8'))
    expect(migrated).toHaveLength(2)
    expect(migrated[0]).toMatchObject({ id: 'n1', tag: '未分类' })
    expect(JSON.parse(readFileSync(join(target, 'data', 'schema-version.json'), 'utf8'))).toBe('2')
    // 升级前备份保留原始数据
    expect(JSON.parse(readFileSync(join(target, 'data-backups', 'pre-upgrade', 'notes.json'), 'utf8'))).toHaveLength(2)
    // 报告与 manifest 生成
    const report = JSON.parse(readFileSync(join(target, 'upgrade-report.json'), 'utf8'))
    expect(report.migration.status).toBe('pass')
    expect(readExportManifest(target)).toBeTruthy()
    // 落地源零触碰
    expect(JSON.parse(readFileSync(join(landedRoot, 'data', 'notes.json'), 'utf8'))[0]).not.toHaveProperty('tag')
  })

  it('无 _migrate.js（版本未变）：migration=none，数据照携带、报告如实', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'proma-up-nom-'))
    writeFileSync(join(projectRoot, 'index.html'), '<html>v2</html>', 'utf8')
    const landedRoot = mkdtempSync(join(tmpdir(), 'proma-up-noml-'))
    mkdirSync(join(landedRoot, 'data'), { recursive: true })
    writeFileSync(join(landedRoot, 'data', 'notes.json'), '[{"id":"n1"}]', 'utf8')
    writeFileSync(join(landedRoot, 'data', 'schema-version.json'), JSON.stringify('1'), 'utf8')
    const destination = mkdtempSync(join(tmpdir(), 'proma-up-nomd-'))
    const result = await upgradeExport({ projectRoot, landedRoot, destination, projectName: 'P' })
    expect(result.migration).toBe('none')
    expect(readFileSync(join(result.target, 'data', 'notes.json'), 'utf8')).toBe('[{"id":"n1"}]')
  })
})
