import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
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
