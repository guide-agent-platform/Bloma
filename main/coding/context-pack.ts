/**
 * Phase 10 W1-3（2026-09-16，咨询 G 收口·真实项目交付体系）：项目侦察包 ContextPack。
 * 变更（迭代/修复）前的确定性事实速览——代码文件清单、后端契约⇄路由目录对账、
 * data/ 数据形状采样、可复用模块目录、上次终验基线、诉求关键词影响面提示。
 * 零 LLM 纯组装（零件复用：readPrdBackplane/readTestReport/fs 扫描），<1s；空态如实
 * 为空不编造（openQuestions v0 恒空占位，LLM 加厚留后续）。
 * 注入语义：侦察包是事实速览不是任务——定位仍以 grep/地图锚点为准（防「喂了包就
 * 不读代码」的反向退化）。
 * 依赖：shared/types（ContextPack 契约）+ model/prd-backplane（InterfaceEndpoint）
 * + document-engine（readPrdBackplane）+ gwt-service（readTestReport）+ project-service。
 * 开关 BLOMA_CONTEXT_PACK：'1'/'on'/'true'=开；未设/'0'/'off'/'false'=关（缺省 off，
 * appendContextPack 返回原 task 字节级）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { ContextPack, ContextPackDataFile, ContextPackRoute } from '../../shared/types'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/document-engine'
import { recordDecision } from '../project/decision-log'
import { readTestReport } from '../verification/gwt-service'
import type { InterfaceEndpoint, PrdBackplane } from '../model/prd-backplane'

/** 开关解析（与 iterationBriefEnabled 同风格，每次调用读取）。 */
export function contextPackEnabled(): boolean {
  const raw = (process.env.BLOMA_CONTEXT_PACK ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true'
}

const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.vue', '.svelte', '.html', '.css'])
const SCAN_SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'data', 'data-backups', 'test-results', 'coverage'])
const MAX_CODE_FILES = 60
const MAX_DATA_FILES = 5
const MAX_REUSABLE_MODULES = 12
const SECTION_CHAR_BUDGET = 2200

function scanCodeFiles(root: string): string[] {
  const acc: string[] = []
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
        if (!SCAN_SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full)
      } else if (SCAN_EXT.has(e.name.slice(e.name.lastIndexOf('.')))) {
        acc.push(relative(root, full).replace(/\\/g, '/'))
      }
      if (acc.length >= MAX_CODE_FILES * 2) return
    }
  }
  if (existsSync(root)) walk(root)
  return acc.sort().slice(0, MAX_CODE_FILES)
}

/** 契约⇄路由目录对账：spec 端点资源段 ↔ server/routes/<资源>.js 文件名。 */
function collectRoutes(root: string, spec: InterfaceEndpoint[]): { routes: ContextPackRoute[]; hints: string[] } {
  const routes: ContextPackRoute[] = []
  const hints: string[] = []
  const routesDir = join(root, 'server', 'routes')
  const dirFiles = new Set<string>()
  if (existsSync(routesDir)) {
    for (const f of readdirSync(routesDir)) {
      if (!f.endsWith('.js') || f.startsWith('_')) continue
      const name = f.replace(/\.js$/, '')
      dirFiles.add(name)
      routes.push({ label: `/api/${name}/*（来自 ${f}）`, source: 'routes_dir' })
    }
  }
  for (const ep of spec) {
    const path = ep.endpoint.trim()
    if (!path) continue
    const seg = path.split('/').filter(Boolean) // ['api','notes'] / ['api','notes','list']
    const resource = seg[1] ?? ''
    const label = `${(ep.method || 'GET').toUpperCase()} ${path}`
    if (dirFiles.has(resource)) {
      routes.push({ label: `${label}（契约+路由文件均在）`, source: 'both' })
      dirFiles.delete(resource)
    } else {
      routes.push({ label: `${label}（契约）`, source: 'backplane' })
      hints.push(`契约端点 ${path} 在 server/routes/ 无对应文件（可能未实现或挂载失败）`)
    }
  }
  for (const leftover of dirFiles) {
    hints.push(`路由文件 ${leftover}.js 不在 interface_spec 契约中（迭代时注意契约对齐）`)
  }
  return { routes, hints }
}

function collectDataFiles(root: string): ContextPackDataFile[] {
  const dataDir = join(root, 'data')
  if (!existsSync(dataDir)) return []
  const out: ContextPackDataFile[] = []
  for (const f of readdirSync(dataDir).sort().slice(0, MAX_DATA_FILES)) {
    const full = join(dataDir, f)
    let entry: ContextPackDataFile = { file: `data/${f}`, shape: 'file', sampleKeys: [] }
    try {
      if (f.endsWith('.json') && statSync(full).isFile() && statSync(full).size <= 512 * 1024) {
        const parsed: unknown = JSON.parse(readFileSync(full, 'utf8'))
        if (Array.isArray(parsed)) {
          const first = parsed[0]
          entry = {
            file: `data/${f}`,
            shape: 'array',
            sampleKeys: first && typeof first === 'object' ? Object.keys(first).slice(0, 8) : [],
          }
        } else if (parsed && typeof parsed === 'object') {
          entry = { file: `data/${f}`, shape: 'object', sampleKeys: Object.keys(parsed).slice(0, 8) }
        }
      }
    } catch {
      entry = { file: `data/${f}`, shape: 'unreadable', sampleKeys: [] }
    }
    out.push(entry)
  }
  return out
}

function collectReusableModules(root: string): string[] {
  const dir = join(root, 'src', 'official-modules')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
      .slice(0, MAX_REUSABLE_MODULES)
  } catch {
    return []
  }
}

/** 诉求关键词 → 文件名影响面（v0 确定性：query 分词命中相对路径）。 */
function collectAffectedHints(query: string | undefined, codeFiles: string[]): string[] {
  if (!query) return []
  const tokens = [...new Set(query.split(/[\s,，。;；、/|()（）]+/).map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2))]
  const hints: string[] = []
  for (const token of tokens.slice(0, 5)) {
    const hits = codeFiles.filter((f) => f.toLowerCase().includes(token)).slice(0, 5)
    if (hits.length > 0) hints.push(`诉求关键词「${token}」命中：${hits.join('、')}`)
  }
  return hints.slice(0, 6)
}

export interface BuildContextPackOptions {
  /** 测试注入背板（生产路径不传，读 readPrdBackplane；陷阱 19 同款口径）。 */
  backplaneOverride?: PrdBackplane
}

/** 确定性组装侦察包。任何零件缺失如实为空（不编造）。 */
export function buildContextPack(projectId: string, changeQuery?: string, options?: BuildContextPackOptions): ContextPack {
  const project = findProject(projectId)
  const root = project.root_path
  let backplane: PrdBackplane
  try {
    backplane = options?.backplaneOverride ?? readPrdBackplane(projectId)
  } catch {
    // 背板不可读（极早期项目）：空契约如实继续
    backplane = options?.backplaneOverride ?? ({ project_id: projectId, name: project.name ?? projectId, positioning: '', requirements: [], acceptance: {}, out_of_scope: [], assumptions: [] } as PrdBackplane)
  }
  const codeFiles = scanCodeFiles(root)
  const { routes, hints: routeHints } = collectRoutes(root, backplane.interface_spec ?? [])
  const baselineReport = (() => {
    try {
      return readTestReport(projectId)
    } catch {
      return null
    }
  })()
  const baseline = baselineReport
    ? {
        total: baselineReport.total_count,
        passed: baselineReport.passed_count,
        failed: baselineReport.failed_count,
        failedScenarios: (baselineReport.failure_summary ?? []).map((f) => f.scenario).slice(0, 8),
      }
    : null
  const affected = collectAffectedHints(changeQuery, codeFiles)
  return {
    codeFiles,
    routes,
    dataFiles: collectDataFiles(root),
    reusableModules: collectReusableModules(root),
    baseline,
    affectedHints: [...affected, ...routeHints].slice(0, 8),
    openQuestions: [],
  }
}

/** 渲染【项目侦察包】段（独立导出便于 A/B 与单测；确定性截断保预算）。 */
export function renderContextPackSection(pack: ContextPack): string {
  const lines: string[] = ['【项目侦察包（宿主确定性组装，事实速览非任务）】']
  const filesShown = pack.codeFiles.slice(0, 40)
  lines.push(`- 代码文件（${pack.codeFiles.length}${pack.codeFiles.length > 40 ? '，仅列前 40' : ''}）：${filesShown.join('、') || '无'}`)
  if (pack.routes.length > 0) {
    lines.push(`- 后端契约与路由：${pack.routes.map((r) => r.label).join('；')}`)
  } else {
    lines.push('- 后端契约与路由：无（纯前端/无 interface_spec）')
  }
  if (pack.dataFiles.length > 0) {
    lines.push(
      `- 数据文件：${pack.dataFiles
        .map((d) => `${d.file}（${d.shape}${d.sampleKeys.length > 0 ? `，键：${d.sampleKeys.join('/')}` : ''}）`)
        .join('；')}`,
    )
  }
  if (pack.reusableModules.length > 0) {
    lines.push(`- 可复用模块（只读参考）：${pack.reusableModules.map((m) => `official-modules/${m}`).join('、')}`)
  }
  if (pack.baseline) {
    const failedPart = pack.baseline.failed > 0 ? `；未过场景：${pack.baseline.failedScenarios.join('、') || '见测试报告'}` : ''
    lines.push(`- 基线测试（上次终验）：${pack.baseline.passed}/${pack.baseline.total} 过${failedPart}`)
  } else {
    lines.push('- 基线测试：无历史测试报告')
  }
  if (pack.affectedHints.length > 0) lines.push(`- 影响面提示：${pack.affectedHints.join('；')}`)
  lines.push('（侦察包是起点速览；动手前仍以 grep/地图锚点定位并 read 命中段，不要凭包内清单盲改）')
  let section = lines.join('\n')
  if (section.length > SECTION_CHAR_BUDGET) {
    section = `${section.slice(0, SECTION_CHAR_BUDGET - 3)}...（侦察包超预算截断，完整事实以项目地图为准）`
  }
  return section
}

/** 迭代/修复轮 task 头注入（开关 off=返回原 task 字节级；on=尾部追加侦察包段+决策留痕）。 */
export function appendContextPack(input: { projectId: string; sessionId: string; task: string; changeQuery?: string }): string {
  if (!contextPackEnabled()) return input.task
  try {
    const pack = buildContextPack(input.projectId, input.changeQuery)
    recordContextPackDecision(input.projectId, input.sessionId, pack)
    return `${input.task}\n\n${renderContextPackSection(pack)}`
  } catch {
    // fail-open：侦察包失败不影响任务本体
    return input.task
  }
}

function recordContextPackDecision(projectId: string, sessionId: string, pack: ContextPack): void {
  try {
    recordDecision({
      project_id: projectId,
      session_id: sessionId,
      entry: {
        type: 'context_pack',
        title: '项目侦察包已组装（变更轮注入）',
        why: `确定性事实速览进 task 头：${pack.codeFiles.length} 文件/${pack.routes.length} 路由条目/${pack.dataFiles.length} 数据文件/基线${pack.baseline ? `${pack.baseline.passed}/${pack.baseline.total}` : '无'}`,
        detail: {
          code_files: pack.codeFiles.length,
          routes: pack.routes.length,
          data_files: pack.dataFiles.length,
          reusable_modules: pack.reusableModules.length,
          baseline_failed: pack.baseline?.failed ?? null,
          affected_hints: pack.affectedHints.length,
        },
      },
    })
  } catch {
    // 决策日志失败不阻断
  }
}
