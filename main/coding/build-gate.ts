/**
 * BuildGate — 验证性构建门禁（PR-2，vendor 预打包路线，2026-09-03）。
 *
 * loop 结束后由系统接管：用 Bloma 自带 esbuild（node_modules/esbuild，零网络
 * 零安装——vendor 路线原则：依赖不进沙箱、不进 npm install）把 manifest.build
 * 声明的入口 bundle 成产物，校验模块图完整性（import 解析错误、循环依赖等
 * 只有打包时暴露的结构缺陷在此拦截）。
 *
 * v1 口径（诚实不阻断）：passed → 产物落盘 dist/ + 决策日志；failed → 决策日志
 * 如实记录错误（不回喂 loop、不阻断终验——GWT dev 态已过，构建失败属结构缺陷，
 * 测试报告与 judge 可见）；esbuild 不可达 → skipped + 决策日志（fail-open=现状）。
 *
 * spawn 口径与 static-server（platform-services）一致：npm_node_execpath /
 * NODE / PATH node；Electron 下 process.execPath 是 electron.exe 不可直接用。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { recordDecision } from '../decision-log'
import type { ProjectSkeleton } from '../project-templates'

export type BuildGateStatus = 'passed' | 'failed' | 'skipped'

/** C2（P1，2026-09-11 审计⑩/J）：构建门禁接线校验开关——bundle 成功后解析 index.html，
 *  入口页零 <script src> 或未引用构建产物路径 → failed。缺省 off=字节级现状
 *  （440B 空壳 stub 照样 passed 的假绿保留）。与 A1 配合后正常产物必过。 */
export function buildGateWiringEnabled(): boolean {
  return process.env.BLOMA_BUILD_GATE_WIRING === '1' || process.env.BLOMA_BUILD_GATE_WIRING === 'true'
}

/** 入口页接线校验（纯函数）：index.html 缺失 → ok（上游 AGENT_LOOP_INCOMPLETE 已拦，
 *  门禁只管 bundle）；零 script src / 未引用构建产物 → 拒。 */
export function checkEntryWiring(rootPath: string, outfile: string): { ok: boolean; reason?: string } {
  const indexPath = join(rootPath, 'index.html')
  if (!existsSync(indexPath)) return { ok: true }
  const html = readFileSync(indexPath, 'utf8')
  const normalize = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '').split('?')[0].replace(/\/$/, '')
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)].map((m) => normalize(m[1] ?? ''))
  if (scripts.length === 0) {
    return { ok: false, reason: '入口页面 index.html 未加载任何脚本（零 <script src> 引用）——构建产物不会被页面使用，功能无法生效' }
  }
  const target = normalize(outfile)
  const hit = scripts.some((src) => src === target || src.endsWith(`/${target}`))
  if (!hit) {
    return { ok: false, reason: `入口页面未引用构建产物 ${target}（现有引用：${scripts.join('、').slice(0, 200)}）——构建产物不会被页面加载` }
  }
  return { ok: true }
}

export interface BuildGateResult {
  status: BuildGateStatus
  /** 产物绝对路径（passed） */
  outfile?: string
  /** 失败原因摘要（failed）/ 跳过原因（skipped） */
  detail?: string
  durationMs: number
}

/** 构建超时：esbuild bundle 单入口毫秒级，30s 是极端冗余上限（防挂死阻塞交付）。 */
const BUILD_GATE_TIMEOUT_MS = 30_000

/** 测试 seam：替换 node 可执行文件解析（避免单测依赖 PATH node）。 */
export function setNodeExecutableForTests(resolver?: () => string): void {
  nodeExecutableResolver = resolver ?? defaultNodeExecutable
}

function defaultNodeExecutable(): string {
  return process.env.npm_node_execpath || process.env.NODE || 'node'
}

let nodeExecutableResolver = defaultNodeExecutable

/** 测试 seam：替换 esbuild bin 定位（unavailable 分支注入）。 */
export function setEsbuildBinResolverForTests(resolver?: () => string): void {
  esbuildBinResolver = resolver ?? defaultEsbuildBin
}

function defaultEsbuildBin(): string {
  return join(process.cwd(), 'node_modules', 'esbuild', 'bin', 'esbuild')
}

let esbuildBinResolver = defaultEsbuildBin

/** esbuild bin 定位：Bloma 根 node_modules（开发态与 npm start 态 cwd 均为项目根）。 */
export function resolveEsbuildBin(): string {
  return esbuildBinResolver()
}

function spawnBuild(rootPath: string, entry: string, outfile: string, minify: boolean): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolvePromise) => {
    const args = [
      resolveEsbuildBin(),
      entry,
      '--bundle',
      `--outfile=${outfile}`,
      '--format=iife',
      ...(minify ? ['--minify'] : []),
      '--log-level=warning',
    ]
    const child = spawn(nodeExecutableResolver(), args, {
      cwd: rootPath,
      env: { PATH: process.env.PATH, Path: process.env.Path },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill()
        resolvePromise({ code: null, stderr: `${stderr}\n[build-gate] 构建超时（${BUILD_GATE_TIMEOUT_MS / 1000}s），已终止` })
      }
    }, BUILD_GATE_TIMEOUT_MS)
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk)
      if (stderr.length > 8000) stderr = stderr.slice(-8000) // 截尾保最近错误
    })
    child.once('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolvePromise({ code: null, stderr: `无法启动构建进程：${err.message}` })
      }
    })
    child.once('close', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolvePromise({ code, stderr: stderr.trim() })
      }
    })
  })
}

/**
 * 运行构建门禁：无 build 段（静态形态）→ 静默 skipped（不落决策行，行为=PR-1 现状）。
 * 决策日志失败不影响门禁结果返回（记录层容错）。
 */
export async function runBuildGate(opts: {
  projectId: string
  sessionId: string
  rootPath: string
  skeleton: ProjectSkeleton | null
}): Promise<BuildGateResult> {
  const startedAt = Date.now()
  const spec = opts.skeleton?.build
  if (!spec) return { status: 'skipped', detail: 'no-build-spec', durationMs: 0 }

  const esbuildBin = resolveEsbuildBin()
  if (!existsSync(esbuildBin)) {
    // fail-open：esbuild 不可达（打包环境缺依赖等）→ 跳过门禁，如实留痕
    tryLogDecision(opts.projectId, opts.sessionId, 'build_gate_unavailable', '构建门禁跳过（esbuild 不可达）', {
      entry: spec.entry,
      expected_bin: esbuildBin,
    })
    return { status: 'skipped', detail: 'esbuild-unavailable', durationMs: Date.now() - startedAt }
  }
  if (!existsSync(join(opts.rootPath, spec.entry))) {
    tryLogDecision(opts.projectId, opts.sessionId, 'build_gate_failed', '构建门禁失败（入口文件不存在）', {
      entry: spec.entry,
      error: `构建入口 ${spec.entry} 不存在（可能被删除或未生成）`,
    })
    return { status: 'failed', detail: `入口不存在：${spec.entry}`, durationMs: Date.now() - startedAt }
  }

  const { code, stderr } = await spawnBuild(opts.rootPath, spec.entry, spec.outfile, spec.minify)
  const durationMs = Date.now() - startedAt
  const outfileAbs = join(opts.rootPath, spec.outfile)

  if (code === 0 && existsSync(outfileAbs)) {
    // C2（P1）：接线校验——bundle 成功但入口页不加载构建产物 → failed（审计案 440B 空壳
    // 假绿的根治位；开关 off=字节级现状直接 passed）
    if (buildGateWiringEnabled()) {
      const wiring = checkEntryWiring(opts.rootPath, spec.outfile)
      if (!wiring.ok) {
        tryLogDecision(opts.projectId, opts.sessionId, 'build_gate_failed', '构建门禁失败（入口页面未加载构建产物）', {
          entry: spec.entry,
          outfile: spec.outfile,
          error: wiring.reason,
          duration_ms: durationMs,
        })
        return { status: 'failed', detail: wiring.reason, durationMs }
      }
    }
    tryLogDecision(opts.projectId, opts.sessionId, 'build_gate_passed', '构建门禁通过', {
      entry: spec.entry,
      outfile: spec.outfile,
      bytes: readFileSync(outfileAbs, 'utf8').length,
      duration_ms: durationMs,
    })
    return { status: 'passed', outfile: outfileAbs, durationMs }
  }

  tryLogDecision(opts.projectId, opts.sessionId, 'build_gate_failed', '构建门禁失败（如实记录，不阻断终验）', {
    entry: spec.entry,
    exit_code: code,
    error: stderr || '未知构建错误',
    duration_ms: durationMs,
  })
  return { status: 'failed', detail: stderr || `退出码 ${code}`, durationMs }
}

function tryLogDecision(
  projectId: string,
  sessionId: string,
  type: 'build_gate_passed' | 'build_gate_failed' | 'build_gate_unavailable',
  title: string,
  detail: Record<string, unknown>,
): void {
  try {
    recordDecision({
      project_id: projectId,
      session_id: sessionId,
      entry: { type, title, why: 'PR-2 验证性构建门禁：loop 后系统接管用内置 esbuild 打包校验模块图（vendor 路线：零网络零安装）', detail },
    })
  } catch {
    // 决策日志失败不影响门禁
  }
}
