import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDocumentsDir } from '../../storage/config-paths'
import { createProject, updateProject } from '../../main/project/project-service'
import { exportProjectHandoff } from '../../main/delivery/project-export'

/**
 * PR-3 导出移交增强（2026-09-03）：排除非产物目录、README.md（prd.json 驱动）与
 * .gitignore 生成、幂等不覆盖已有文件、prd.json 缺失/损坏容错。
 * 陷阱 42 精神：导出是只读复制（不触碰索引/会话/快照），结果字段如实。
 */

describe('project-export（PR-3：移交增强导出）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-exp-'))
  })

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  function seedProject(): { project_id: string; root_path: string; workspace_slug: string; name: string } {
    const project = createProject({
      request_id: 'req-export',
      mode: 'quick',
      initial_message: '做一个测试项目 abc/def?<>',
    })
    writeFileSync(join(project.root_path, 'index.html'), '<html><body>hi</body></html>', 'utf8')
    mkdirSync(join(project.root_path, 'src'), { recursive: true })
    writeFileSync(join(project.root_path, 'src', 'app.js'), 'var a = 1', 'utf8')
    writeFileSync(join(project.root_path, 'package.json'), '{}', 'utf8')
    // 排除目录：不应出现在导出产物中
    mkdirSync(join(project.root_path, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(project.root_path, 'node_modules', 'pkg', 'i.js'), 'x', 'utf8')
    return project
  }

  function writePrd(project: { workspace_slug: string; project_id: string }): void {
    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    writeFileSync(join(dir, 'prd.json'), JSON.stringify({
      project_id: project.project_id,
      name: '测试项目',
      positioning: '面向个人的测试工具，快速记录与查看',
      requirements: [
        { id: 'F-001', description: '记录条目：点击保存后列表新增一条' },
        { id: 'F-002', description: '月度汇总：新增支出后结余更新' },
      ],
      out_of_scope: ['多用户协作'],
    }), 'utf8')
  }

  it('导出产物：项目文件复制 + README（定位/功能清单/范围外/启动方式）+ .gitignore 生成', () => {
    const project = seedProject()
    writePrd(project)
    const dest = mkdtempSync(join(tmpdir(), 'exp-dest-'))

    const result = exportProjectHandoff({ request_id: 'r1', project_id: project.project_id }, dest)
    expect(result.canceled).toBe(false)
    expect(result.destination).toBeTruthy()
    const target = result.destination!

    expect(existsSync(join(target, 'index.html'))).toBe(true)
    expect(existsSync(join(target, 'src', 'app.js'))).toBe(true)
    expect(existsSync(join(target, 'node_modules'))).toBe(false) // 排除目录不导出

    const readme = readFileSync(join(target, 'README.md'), 'utf8')
    expect(readme).toContain('Bloma')
    expect(readme).toContain('面向个人的测试工具')
    expect(readme).toContain('[F-001] 记录条目')
    expect(readme).toContain('多用户协作')
    expect(readme).toContain('npm start')

    expect(readFileSync(join(target, '.gitignore'), 'utf8')).toContain('node_modules/')
    // file_count 如实统计：index.html + src/app.js + package.json + README + .gitignore + export-info.json（I8）= 6
    expect(result.file_count).toBe(6)
  })

  it('幂等：目标已有 README/.gitignore 不覆盖（重复导出不改写用户侧文件）', () => {
    const project = seedProject()
    writePrd(project)
    const dest = mkdtempSync(join(tmpdir(), 'exp-dest-'))
    const first = exportProjectHandoff({ request_id: 'r1', project_id: project.project_id }, dest)
    const actual = first.destination!

    writeFileSync(join(actual, 'README.md'), '# 用户手写 README', 'utf8')

    const second = exportProjectHandoff({ request_id: 'r3', project_id: project.project_id }, dest)
    expect(second.destination).toBe(actual) // 两次导出同名目录一致
    expect(readFileSync(join(actual, 'README.md'), 'utf8')).toBe('# 用户手写 README')
  })

  it('prd.json 缺失：README 回退极简版（项目名 + 空清单占位），导出不失败', () => {
    const project = seedProject()
    const dest = mkdtempSync(join(tmpdir(), 'exp-dest-'))

    const result = exportProjectHandoff({ request_id: 'r1', project_id: project.project_id }, dest)
    expect(result.canceled).toBe(false)
    const readme = readFileSync(join(result.destination!, 'README.md'), 'utf8')
    expect(readme).toContain('见源码实现') // 空功能清单占位
    expect(readme).toContain('npm start')
  })

  it('prd.json 损坏（坏 JSON）：容错回退极简 README，不抛错', () => {
    const project = seedProject()
    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    writeFileSync(join(dir, 'prd.json'), '{broken', 'utf8')
    const dest = mkdtempSync(join(tmpdir(), 'exp-dest-'))

    const result = exportProjectHandoff({ request_id: 'r1', project_id: project.project_id }, dest)
    expect(result.canceled).toBe(false)
    expect(existsSync(join(result.destination!, 'README.md'))).toBe(true)
  })

  it('中文项目名：目标目录名清洗非法字符且复制成功（Windows 非 ASCII 路径口径）', () => {
    const project = seedProject()
    const dest = mkdtempSync(join(tmpdir(), 'exp-dest-'))
    const result = exportProjectHandoff({ request_id: 'r1', project_id: project.project_id }, dest)
    expect(result.destination).toMatch(/测试项目/)
    expect(existsSync(join(result.destination!, 'index.html'))).toBe(true)
  })
})

// ===========================================================================
// Phase 7 U3 I8（2026-09-10）：导出包带版本标识与已知限制
// ===========================================================================
describe('project-export · I8 导出版本标识（export-info.json）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let outDir: string

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-exp-i8-'))
    outDir = mkdtempSync(join(tmpdir(), 'exp-out-'))
  })

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  /** I8 专用最小项目（不依赖 PRD 夹具）：一个可导出的产物页即可 */
  function seedMinimal(): { project_id: string; root_path: string } {
    const project = createProject({ request_id: 'req-export-i8', mode: 'quick', initial_message: '导出标识测试' })
    writeFileSync(join(project.root_path, 'index.html'), '<html><body>i8</body></html>', 'utf8')
    return { project_id: project.project_id, root_path: project.root_path }
  }

  it('导出写 export-info.json：源版本+导出时间+未评估态说明（线上状态未知口径）', () => {
    const project = seedMinimal()
    const result = exportProjectHandoff({ request_id: 'req', project_id: project.project_id }, outDir)
    expect(result.canceled).toBe(false)
    const infoPath = join(result.destination ?? '', 'export-info.json')
    expect(existsSync(infoPath)).toBe(true)
    const info = JSON.parse(readFileSync(infoPath, 'utf8')) as Record<string, unknown>
    expect(typeof info.exported_at).toBe('string')
    expect(info.delivery_status).toBe('not_evaluated')
    expect(String(info.note)).toContain('平台无法观测线上环境')
  })

  it('delivery_status 随导出时点如实记录（partial 时说明存在未通过部分）', () => {
    const project = seedMinimal()
    updateProject(project.project_id, { delivery_status: 'partial' })
    const result = exportProjectHandoff({ request_id: 'req', project_id: project.project_id }, outDir)
    const info = JSON.parse(readFileSync(join(result.destination!, 'export-info.json'), 'utf8')) as Record<string, unknown>
    expect(info.delivery_status).toBe('partial')
    expect(String(info.note)).toContain('未通过或未验证')
  })
})
