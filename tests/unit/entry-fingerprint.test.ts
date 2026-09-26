import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computeEntryFingerprint } from '../../main/verification/gwt-service'

/**
 * 入口指纹覆盖面（2026-09-26 运行审计 P1-07）：原口径只覆盖 index.html + src/** +
 * dist/app.js——后端 server/** 与依赖清单改动不使指纹失效，会放行「验证后被改」。
 */

describe('computeEntryFingerprint 覆盖面（P1-07）', () => {
  function setupProject(): string {
    const root = mkdtempSync(join(tmpdir(), 'proma-fp-'))
    writeFileSync(join(root, 'index.html'), '<html><body><button>go</button></body></html>', 'utf8')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'app.js'), 'console.log(1)', 'utf8')
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'dist', 'app.js'), 'console.log("built")', 'utf8')
    return root
  }

  it('后端 server/** 改动使指纹失效（原口径漏面）', () => {
    const root = setupProject()
    const before = computeEntryFingerprint(root)
    expect(before).not.toBeNull()
    mkdirSync(join(root, 'server', 'routes'), { recursive: true })
    writeFileSync(join(root, 'server', 'routes', 'records.js'), 'module.exports = () => {}', 'utf8')
    const withServer = computeEntryFingerprint(root)
    expect(withServer?.sha256).not.toBe(before?.sha256)
    // 再改后端内容 → 再次失效
    writeFileSync(join(root, 'server', 'routes', 'records.js'), 'module.exports = () => { return 1 }', 'utf8')
    expect(computeEntryFingerprint(root)?.sha256).not.toBe(withServer?.sha256)
  })

  it('依赖清单 package.json / package-lock.json 改动使指纹失效', () => {
    const root = setupProject()
    const before = computeEntryFingerprint(root)
    writeFileSync(join(root, 'package.json'), '{"name":"x","dependencies":{}}', 'utf8')
    const withPkg = computeEntryFingerprint(root)
    expect(withPkg?.sha256).not.toBe(before?.sha256)
    writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}', 'utf8')
    expect(computeEntryFingerprint(root)?.sha256).not.toBe(withPkg?.sha256)
  })

  it('src/dist 既有覆盖面不变；无关文件（README）不影响', () => {
    const root = setupProject()
    const before = computeEntryFingerprint(root)
    writeFileSync(join(root, 'README.md'), '# 说明', 'utf8')
    expect(computeEntryFingerprint(root)?.sha256).toBe(before?.sha256)
    writeFileSync(join(root, 'src', 'app.js'), 'console.log(2)', 'utf8')
    expect(computeEntryFingerprint(root)?.sha256).not.toBe(before?.sha256)
    const afterSrc = computeEntryFingerprint(root)
    writeFileSync(join(root, 'dist', 'app.js'), 'console.log("built2")', 'utf8')
    expect(computeEntryFingerprint(root)?.sha256).not.toBe(afterSrc?.sha256)
  })

  it('无 index.html → null（不误报）', () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-fp-empty-'))
    expect(computeEntryFingerprint(root)).toBeNull()
  })
})

describe('后端变更 → 历史验证结论失效（P2-04 故障注入基准）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    if (originalPromaHome === undefined) delete process.env.PROMA_HOME
    else process.env.PROMA_HOME = originalPromaHome
  })

  it('checkEntryFingerprintFresh：改后端 server/ 文件 → 历史全绿结论失效（旧口径漏面）', async () => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-fp-fresh-'))
    const { createProject } = await import('../../main/project/project-service')
    const { writeTestReport, checkEntryFingerprintFresh } = await import('../../main/verification/gwt-service')
    const project = createProject({ request_id: 'req-fresh', mode: 'quick' })
    writeFileSync(join(project.root_path, 'index.html'), '<html><body><button>go</button></body></html>', 'utf8')
    mkdirSync(join(project.root_path, 'src'), { recursive: true })
    writeFileSync(join(project.root_path, 'src', 'app.js'), 'console.log(1)', 'utf8')
    mkdirSync(join(project.root_path, 'server', 'routes'), { recursive: true })
    writeFileSync(join(project.root_path, 'server', 'routes', 'records.js'), 'module.exports = () => {}', 'utf8')
    // 验证时点：落报告（含指纹）
    writeTestReport({
      request_id: 'req-fresh',
      session_id: 's-fresh',
      project_id: project.project_id,
      result: { total_count: 1, passed_count: 1, failed_count: 0, failure_summary: [] },
    })
    expect(checkEntryFingerprintFresh(project.project_id)).toBe(true)
    // 后端被改（验证后）→ 结论失效
    writeFileSync(join(project.root_path, 'server', 'routes', 'records.js'), 'module.exports = () => { return 1 }', 'utf8')
    expect(checkEntryFingerprintFresh(project.project_id)).toBe(false)
  })
})
