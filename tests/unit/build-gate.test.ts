import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildGateWiringEnabled,
  checkEntryWiring,
  resolveEsbuildBin,
  runBuildGate,
  setEsbuildBinResolverForTests,
  setNodeExecutableForTests,
} from '../../main/coding/build-gate'
import { getSkeletonDirPath } from '../../storage/config-paths'
import { loadSkeletonTemplate } from '../../main/project-templates'
import type { ProjectSkeleton } from '../../main/project-templates'

/**
 * PR-2 验证性构建门禁（vendor 预打包路线，2026-09-03）：
 * 真实 esbuild 实跑（项目 node_modules 自带，离线零安装）覆盖 passed/failed；
 * 无 build 段=静态形态静默跳过；入口缺失/esbuild 不可达分支如实留痕不阻断。
 * 决策日志 mock 断言类型与 detail（v1 口径：failed 也不阻断交付）。
 */

vi.mock('../../main/decision-log', () => ({ recordDecision: vi.fn() }))

import { recordDecision } from '../../main/decision-log'

describe('build-gate（PR-2：验证性构建门禁，真实 esbuild）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    vi.mocked(recordDecision).mockClear()
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-bg-'))
    setEsbuildBinResolverForTests() // 复位：用真实 resolveEsbuildBin
    setNodeExecutableForTests() // 复位：npm_node_execpath / NODE / node
  })

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    setEsbuildBinResolverForTests()
    setNodeExecutableForTests()
  })

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'bg-root-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    return root
  }

  function skeletonWithBuild(overrides?: Partial<NonNullable<ProjectSkeleton['build']>>): ProjectSkeleton | null {
    const base = loadSkeletonTemplate('web_fullstack')
    expect(base?.build).toBeTruthy() // manifest v2 内置带 build 段
    return { ...base!, build: { ...base!.build!, ...overrides } } as ProjectSkeleton
  }

  it('内置 manifest v2：build 段解析齐全（entry/outfile/format/minify）', () => {
    const skeleton = loadSkeletonTemplate('web_fullstack')!
    expect(skeleton.version).toBe(2)
    expect(skeleton.build).toEqual({
      tool: 'esbuild',
      entry: 'src/app.js',
      outfile: 'dist/app.js',
      format: 'iife',
      minify: true,
    })
  })

  it('passed：模块化入口（import 子模块）打包成功，产物落盘且 minify，决策日志 build_gate_passed', async () => {
    const root = makeRoot()
    writeFileSync(join(root, 'src', 'app.js'), "import { add } from './util.js'\nwindow.result = add(1, 2)\n", 'utf8')
    writeFileSync(join(root, 'src', 'util.js'), 'export function add(a, b) { return a + b }\n', 'utf8')

    const result = await runBuildGate({
      projectId: 'p1', sessionId: 's1', rootPath: root, skeleton: skeletonWithBuild(),
    })
    expect(result.status).toBe('passed')
    expect(result.outfile).toBe(join(root, 'dist', 'app.js'))
    expect(existsSync(result.outfile!)).toBe(true)
    const bundle = readFileSync(result.outfile!, 'utf8')
    expect(bundle).toContain('window.result') // bundle 语义保留（IIFE 包裹）
    expect(bundle).not.toMatch(/\n\s*\n/) // minify 压缩特征
    expect(vi.mocked(recordDecision)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(recordDecision).mock.calls[0][0].entry.type).toBe('build_gate_passed')
  }, 60_000)

  it('failed：import 解析错误（缺失模块）→ 构建失败如实记录，不抛错（v1 不阻断）', async () => {
    const root = makeRoot()
    writeFileSync(join(root, 'src', 'app.js'), "import { x } from './missing.js'\nconsole.log(x)\n", 'utf8')

    const result = await runBuildGate({
      projectId: 'p1', sessionId: 's1', rootPath: root, skeleton: skeletonWithBuild(),
    })
    expect(result.status).toBe('failed')
    expect(result.detail).toBeTruthy()
    expect(existsSync(join(root, 'dist', 'app.js'))).toBe(false)
    expect(vi.mocked(recordDecision).mock.calls[0][0].entry.type).toBe('build_gate_failed')
  }, 60_000)

  it('静态形态（无 build 段）→ 静默 skipped，不落决策行（行为=PR-1 现状）', async () => {
    const root = makeRoot()
    const skeleton = loadSkeletonTemplate('web_fullstack')!
    const { build, ...rest } = skeleton
    expect(build).toBeTruthy()
    void build

    const result = await runBuildGate({ projectId: 'p1', sessionId: 's1', rootPath: root, skeleton: rest as ProjectSkeleton })
    expect(result.status).toBe('skipped')
    expect(result.detail).toBe('no-build-spec')
    expect(recordDecision).not.toHaveBeenCalled()
  })

  it('入口文件不存在 → failed（入口不存在），决策日志如实', async () => {
    const root = makeRoot()
    const result = await runBuildGate({
      projectId: 'p1', sessionId: 's1', rootPath: root, skeleton: skeletonWithBuild(),
    })
    expect(result.status).toBe('failed')
    expect(result.detail).toContain('入口不存在')
    expect(vi.mocked(recordDecision).mock.calls[0][0].entry.type).toBe('build_gate_failed')
  })

  it('esbuild 不可达 → skipped + build_gate_unavailable（fail-open=现状，如实留痕）', async () => {
    const root = makeRoot()
    setEsbuildBinResolverForTests(() => join(tmpdir(), 'definitely-missing-esbuild-bin'))

    const result = await runBuildGate({
      projectId: 'p1', sessionId: 's1', rootPath: root, skeleton: skeletonWithBuild(),
    })
    expect(result.status).toBe('skipped')
    expect(result.detail).toBe('esbuild-unavailable')
    expect(vi.mocked(recordDecision).mock.calls[0][0].entry.type).toBe('build_gate_unavailable')
  })

  it('外置骨架坏 build 段（字段缺失）→ 整段丢弃降级静态，骨架本体仍可用', () => {
    const dir = getSkeletonDirPath('web-fullstack')
    mkdirSync(join(dir, 'src', 'examples'), { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      type: 'web_fullstack', version: 3,
      build: { tool: 'esbuild', entry: 'src/app.js' }, // 缺 outfile → 坏段
      files: [{ path: 'src/app.js' }],
    }), 'utf8')
    writeFileSync(join(dir, 'src', 'app.js'), 'var a = 1', 'utf8')

    const skeleton = loadSkeletonTemplate('web_fullstack')
    expect(skeleton).not.toBeNull()
    expect(skeleton!.source).toBe('override')
    expect(skeleton!.build).toBeUndefined() // 坏段丢弃=降级静态形态
    rmSync(dir, { recursive: true, force: true })
  })
})


describe('C2 构建门禁接线校验（BLOMA_BUILD_GATE_WIRING）', () => {
  const originalEnv = process.env.BLOMA_BUILD_GATE_WIRING
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    vi.mocked(recordDecision).mockClear()
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-bg-c2-'))
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.BLOMA_BUILD_GATE_WIRING
    else process.env.BLOMA_BUILD_GATE_WIRING = originalEnv
    process.env.PROMA_HOME = originalPromaHome
  })

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'bg-c2-root-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    return root
  }

  function skeletonWithBuild(): ProjectSkeleton | null {
    const base = loadSkeletonTemplate('web_fullstack')
    expect(base?.build).toBeTruthy()
    return base
  }

  it('checkEntryWiring 纯函数：零 script / 未引用产物 / 承接位命中 / index.html 缺失四态', () => {
    const root = makeRoot()
    // 零 script（审计案形态：骨架外产物零 <script src>）
    writeFileSync(join(root, 'index.html'), '<html><body><p>空</p></body></html>', 'utf8')
    expect(checkEntryWiring(root, 'dist/app.js')).toMatchObject({ ok: false })
    expect(checkEntryWiring(root, 'dist/app.js').reason).toContain('未加载任何脚本')
    // 有 script 但引用的是源文件非构建产物
    writeFileSync(join(root, 'index.html'), '<html><body><script src="src/app.js"></script></body></html>', 'utf8')
    expect(checkEntryWiring(root, 'dist/app.js')).toMatchObject({ ok: false })
    expect(checkEntryWiring(root, 'dist/app.js').reason).toContain('未引用构建产物')
    // A1 承接位形态命中（./dist/app.js defer / 绝对路径 / 带查询参数）
    writeFileSync(join(root, 'index.html'), '<html><body><script src="./dist/app.js" defer></script></body></html>', 'utf8')
    expect(checkEntryWiring(root, 'dist/app.js').ok).toBe(true)
    writeFileSync(join(root, 'index.html'), '<html><body><script src="/dist/app.js?v=2"></script></body></html>', 'utf8')
    expect(checkEntryWiring(root, 'dist/app.js').ok).toBe(true)
    // index.html 缺失 → ok（上游 AGENT_LOOP_INCOMPLETE 已拦，门禁只管 bundle）
    const bare = makeRoot()
    expect(checkEntryWiring(bare, 'dist/app.js').ok).toBe(true)
  })

  it('开关 off=字节级现状：无 index.html 的空壳 bundle 照样 passed（440B 假绿保留）', async () => {
    delete process.env.BLOMA_BUILD_GATE_WIRING
    expect(buildGateWiringEnabled()).toBe(false)
    const root = makeRoot()
    writeFileSync(join(root, 'src', 'app.js'), '// TODO 空壳' + String.fromCharCode(10), 'utf8')
    const result = await runBuildGate({ projectId: 'p1', sessionId: 's1', rootPath: root, skeleton: skeletonWithBuild() })
    expect(result.status).toBe('passed')
    expect(vi.mocked(recordDecision).mock.calls[0][0].entry.type).toBe('build_gate_passed')
  }, 60_000)

  it('开关 on：骨架 index.html（A1 承接位在）→ passed；抹掉 script → failed 附真实原因', async () => {
    process.env.BLOMA_BUILD_GATE_WIRING = '1'
    const root = makeRoot()
    writeFileSync(join(root, 'src', 'app.js'), 'window.ok = true' + String.fromCharCode(10), 'utf8')
    // A1 骨架 index.html 真实渲染（承接位 <script src="./dist/app.js" defer>）
    const skeleton = skeletonWithBuild()!
    for (const entry of skeleton.files) {
      if (entry.path === 'index.html') {
        mkdirSync(join(root, 'src'), { recursive: true })
        writeFileSync(join(root, 'index.html'), readFileSync(join(skeleton.baseDir, 'index.html'), 'utf8'), 'utf8')
      }
    }
    let result = await runBuildGate({ projectId: 'p1', sessionId: 's1', rootPath: root, skeleton })
    expect(result.status).toBe('passed')
    // 审计案形态：入口页零 script 引用 → 空壳 bundle 被接线门拦截
    writeFileSync(join(root, 'index.html'), '<html><body><p>无脚本页面</p></body></html>', 'utf8')
    result = await runBuildGate({ projectId: 'p1', sessionId: 's1', rootPath: root, skeleton })
    expect(result.status).toBe('failed')
    expect(result.detail).toContain('未加载任何脚本')
    const decisions = vi.mocked(recordDecision).mock.calls.map((call) => call[0].entry)
    expect(decisions.some((entry) => entry.type === 'build_gate_failed' && entry.title.includes('入口页面未加载构建产物'))).toBe(true)
  }, 60_000)
})
