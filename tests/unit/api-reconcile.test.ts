/**
 * API 三方对账单测（Phase 9 W1.3，2026-09-12）。
 *
 * 用 B 站播放器案（项目 214397c3）的真实形态做验收：前端 src/bilibili.js 调
 * /api/bili/view、/api/bili/playurl，产物无 server/routes/ 目录 → 反向对账必须红。
 * 该案当天以 9/9 断言假绿交付，本开关开启后同款产物不可能再绿（Phase 9 验收第 5 条）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { apiReconcileEnabled, checkMediaSourceDiscipline, collectFrontendApiPrefixes, listRoutePrefixes, reconcileApiUsage } from '../../main/coding/api-reconcile'

const roots: string[] = []
const mkRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'bloma-reconcile-'))
  roots.push(root)
  return root
}
afterAll(() => {
  for (const r of roots) {
    try { rmSync(r, { recursive: true, force: true }) } catch { /* Windows 句柄容忍 */ }
  }
})

describe('API 三方对账（BLOMA_API_RECONCILE）', () => {
  const previous = process.env.BLOMA_API_RECONCILE
  beforeEach(() => { process.env.BLOMA_API_RECONCILE = '1' })
  afterAll(() => {
    if (previous === undefined) delete process.env.BLOMA_API_RECONCILE
    else process.env.BLOMA_API_RECONCILE = previous
  })

  it('B 站案形态：前端调 /api/bili、无 server/routes → 反向对账红（主死因拦截）', () => {
    const root = mkRoot()
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'bilibili.js'), `const url = \`/api/bili\${path}\`; fetch('/api/bili/playurl')`, 'utf8')
    writeFileSync(join(root, 'index.html'), '<html></html>', 'utf8')
    expect(collectFrontendApiPrefixes(root)).toContain('bili')
    expect(listRoutePrefixes(root).size).toBe(0)
    const failures = reconcileApiUsage({ projectRoot: root })
    expect(failures.some((f) => f.scenario.includes('/api/bili'))).toBe(true)
    expect(failures.find((f) => f.scenario.includes('/api/bili'))!.reason).toContain('server/routes')
  })

  it('前端引用与路由齐备 → 对账绿（含占位 external 有路由目录即履行）', () => {
    const root = mkRoot()
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'server', 'routes'), { recursive: true })
    writeFileSync(join(root, 'src', 'app.js'), `fetch('/api/bili/view')`, 'utf8')
    writeFileSync(join(root, 'server', 'routes', 'bili.js'), `module.exports = {}`, 'utf8')
    const failures = reconcileApiUsage({ projectRoot: root, specPrefixes: ['external'] })
    expect(failures).toEqual([])
  })

  it('正向：spec 端点无路由实现 → 红；占位 external 且路由目录整体缺失 → 红', () => {
    const root = mkRoot()
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'app.js'), `// 无 api 调用`, 'utf8')
    // 场景 A：具体契约端点无路由
    const a = reconcileApiUsage({ projectRoot: root, specPrefixes: ['records'] })
    expect(a.some((f) => f.scenario.includes('正向') && f.scenario.includes('records'))).toBe(true)
    // 场景 B：占位 external，路由目录不存在（外部服务需求零路由 = 必红）
    const b = reconcileApiUsage({ projectRoot: root, specPrefixes: ['external'] })
    expect(b.some((f) => f.scenario.includes('/api/external'))).toBe(true)
  })

  it('豁免：/api/llm 平台内置与 official-modules 只读参考目录不进对账', () => {
    const root = mkRoot()
    mkdirSync(join(root, 'src', 'official-modules', 'storage-state'), { recursive: true })
    writeFileSync(join(root, 'src', 'official-modules', 'storage-state', 'storage-state.js'), `fetch('/api/llm')`, 'utf8')
    expect(collectFrontendApiPrefixes(root).size).toBe(0)
    const failures = reconcileApiUsage({ projectRoot: root })
    expect(failures).toEqual([])
  })

  it('开关 off：零注入字节级现状', () => {
    delete process.env.BLOMA_API_RECONCILE
    expect(apiReconcileEnabled()).toBe(false)
    const root = mkRoot()
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.js'), `fetch('/api/ghost')`, 'utf8')
    expect(reconcileApiUsage({ projectRoot: root })).toEqual([])
  })
})

describe('W1.4 静态媒体源纪律（外链直连检查）', () => {
  it('硬编码外链 <video src="https://… → 红（B 站案第三死因：CSP+防盗链）', () => {
    process.env.BLOMA_API_RECONCILE = '1'
    const root = mkRoot()
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'player.js'), `video.src = 'https://upos-sample.bilivideo.com/upgcx/xx.mp4'`, 'utf8')
    writeFileSync(join(root, 'index.html'), `<video src="https://cdn.example.com/a.mp4"></video>`, 'utf8')
    const failures = checkMediaSourceDiscipline(root)
    expect(failures.length).toBe(2)
    expect(failures[0].reason).toContain('同源代理')
    expect(failures[1].reason).toContain('cdn.example.com')
  })

  it('blob:/同源/运行时变量赋值不误伤；开关 off 零注入', () => {
    const root = mkRoot()
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'ok.js'), `video.src = URL.createObjectURL(file); other.src = someVar; audio.src = '/static/a.mp3'`, 'utf8')
    process.env.BLOMA_API_RECONCILE = '1'
    expect(checkMediaSourceDiscipline(root)).toEqual([])
    delete process.env.BLOMA_API_RECONCILE
    expect(checkMediaSourceDiscipline(root)).toEqual([])
  })
})
