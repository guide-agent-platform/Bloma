import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DocumentRef } from '../../shared/types'
import { getAnalyticsPath, getDocumentsDir } from '../../storage/config-paths'
import { findProject, readLastSketchRequirements } from '../project/project-service'
import { escapeHtml, type SketchRequirement } from '../coding/sketch-engine'
import { planScenarios, runBrowserGwt, scenarioName as gwtScenarioName } from './gwt-runner'
import { replayRequirements, splitAdvisoryResults } from '../experience/replay-compiler'
import { reportReplayOutcomes } from '../experience/experience-service'

/**
 * GWT 服务（A2-07，方案A拆分：A 写骨架 / C 执行）。
 *
 * - 骨架写盘由 DocumentEngine（A2-05 `mvp_before_generation`）产出 `features/*.feature`；
 * - 本模块提供 **测试结果解析与报告写盘**：解析 `{ total_count, passed_count,
 *   failed_count, failure_summary }`（对齐 api-spec §12.4 `run_gwt_tests`），
 *   `test-report.json`/`test-report.md` 由本模块**唯一写盘**（供 A2-10 裁判读取）；
 * - `runGwtScenarios` 为 **A 侧占位执行**（无浏览器）：拉取预览 HTML，校验每个
 *   P0 功能项在 MVP 产物中有对应入口。C 的 GWTTestRunner 交付后替换本占位实现，
 *   报告的 schema 保持不变，JudgeEngine 无需改动。
 */

export interface GwtFailureSummary {
  scenario: string
  reason: string
  /**
   * 失败归类（2026-09-26 照抄批·对方 AC L-001 回炉分流）：product=产品类（进修复轮）；
   * precondition=前置缺失（不可自动验证——不烧修复预算）；selector=映射类（找不到控件，
   * 失败原因带控件清单可修——修复轮处理）。缺省（存量/静态兜底路径）按 product 对待。
   */
  kind?: 'product' | 'precondition' | 'selector'
}

export interface GwtTestResult {
  total_count: number
  passed_count: number
  failed_count: number
  failure_summary: GwtFailureSummary[]
  /**
   * 待评估断言（§8.1）：行为断言解析出了效果词表但产物未现关键词（可能走
   * SVG/canvas/@keyframes 等不落关键词的合法实现）→ 静态模式无法判定，不计失败，
   * 由行为脚本/LLM 裁判兜底。信息性字段，裁判不作硬约束依据。
   */
  unverified?: string[]
  /**
   * 产物入口聚合指纹（2026-09-25 挂账②，对方 entryFingerprint 直译——多文件聚合口径）：
   * index.html + src/** 递归 + dist/app.js 逐文件 sha256 组合。报告落盘时计算；
   * 消费侧（checkEntryFingerprintFresh）比对当前产物——验证后被改可检测。
   */
  entry_fingerprint?: EntryFingerprint
  /**
   * 探针降级标记（2026-09-25 对齐批·环境豁免）：true = 浏览器探针不可用，结果是
   * 静态启发式兜底判定——失败不可归因产物缺陷（静态口径的假红/待评估），
   * 修复轮据此不烧预算（对齐 Proma-Easy「环境类不入修复循环」铁律）。
   */
  probe_degraded?: boolean
}

/** 产物入口聚合指纹（多文件口径）。 */
export interface EntryFingerprint {
  /** 关键产物文件内容的组合 sha256（hex） */
  sha256: string
  /** 关键产物文件总字节数 */
  size: number
  /** 参与指纹的文件数 */
  files: number
}

/**
 * 计算产物入口聚合指纹：index.html + src/**（递归）+ dist/app.js。
 * 逐文件读内容进 hash 流（内容 + 相对路径，防同名挪位），返回组合指纹；
 * index.html 不存在返回 null（无入口可指纹——消费侧按无可比处理，不误报）。
 */
export function computeEntryFingerprint(projectRoot: string): EntryFingerprint | null {
  const entry = join(projectRoot, 'index.html')
  if (!existsSync(entry)) return null
  const hash = createHash('sha256')
  let size = 0
  let files = 0
  const absorb = (abs: string, rel: string): void => {
    const content = readFileSync(abs)
    hash.update(rel)
    hash.update(content)
    size += content.length
    files += 1
  }
  absorb(entry, 'index.html')
  const srcRoot = join(projectRoot, 'src')
  const walk = (dir: string, prefix: string): void => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const abs = join(dir, name)
      if (statSync(abs).isDirectory()) walk(abs, `${prefix}${name}/`)
      else absorb(abs, `${prefix}${name}`)
    }
  }
  walk(srcRoot, 'src/')
  const distEntry = join(projectRoot, 'dist', 'app.js')
  if (existsSync(distEntry)) absorb(distEntry, 'dist/app.js')
  return { sha256: hash.digest('hex'), size, files }
}

/**
 * 报告新鲜度校验（消费侧，对方 checkGwtDeliveryFacts b 道直译的最小版）：
 * 比对最近测试报告的 entry_fingerprint 与当前产物指纹。
 * true=一致（历史结论仍有效）/ false=验证后产物被修改（历史全绿结论失效）/
 * null=无可比（旧报告无指纹字段，或产物入口缺失——不误报）。
 */
export function checkEntryFingerprintFresh(projectId: string): boolean | null {
  const report = readTestReport(projectId)
  if (!report?.entry_fingerprint) return null
  const project = findProject(projectId)
  if (!project) return null
  const current = computeEntryFingerprint(project.root_path)
  if (!current) return null
  return current.sha256 === report.entry_fingerprint.sha256
}

export interface RunGwtInput {
  project_id: string
  session_id: string
  preview_url?: string
}

const TEST_REPORT_JSON = 'test-report.json'
const TEST_REPORT_MD = 'test-report.md'

/** 在预览上执行 GWT 场景，返回结构化结果。 */
export async function runGwtScenarios(input: RunGwtInput): Promise<GwtTestResult> {
  // T-5 重放场景（advisory）：合成项随真实执行器跑（浏览器/静态两条路都经
  // planScenarios 追加），但结果从返回的 gated 计数中剔除——错误经验指导测试
  // 而不碰交付门禁；账本回流 fire-and-forget，开关 off 时零差异。
  const replay = replayRequirements(input.project_id)
  const browserResult = await runBrowserGwt(input)
  const raw = browserResult ?? (await runStaticScenarios(input))
  // 环境豁免标记：探针缺席走静态兜底时置位（修复轮消费——环境类不烧预算）
  if (!browserResult) raw.probe_degraded = true
  if (replay.length === 0) return raw
  const names = new Set(replay.map((r) => gwtScenarioName(r.id, (r.behavior_assertions ?? [''])[0])))
  const { gated, outcomes } = splitAdvisoryResults(raw, names)
  void reportReplayOutcomes(outcomes, input.project_id).catch((error) => console.warn('[experience] replay report failed:', error))
  return gated
}

/**
 * 静态启发式兜底（无浏览器环境）：逐条断言判定（§8.1 有界静态启发式）。
 *
 * - 存在性断言（默认断言/解析不出触发与效果）：需求原文转义后出现在 HTML，或
 *   产物整体具备「交互控件 + 脚本逻辑」（hasInteractiveEntry 一票语义，与改造前同构）；
 * - 行为断言：效果词表关键词出现在产物全文（HTML+JS）→ 静态确认通过；未现关键词 →
 *   **待评估不计失败**（防 SVG/canvas/@keyframes 等不落关键词的合法实现被误退回，
 *   真实行为判定交给浏览器行为脚本——它不可用时宁可放过不可误杀）。
 */
async function runStaticScenarios(input: RunGwtInput): Promise<GwtTestResult> {
  const requirements = [...readLastSketchRequirements(input.project_id), ...replayRequirements(input.project_id)]
  const html = input.preview_url ? await fetchHtml(input.preview_url) : undefined
  const appJs = input.preview_url ? await fetchAppJs(input.preview_url) : undefined
  const artifact = `${html ?? ''}\n${appJs ?? ''}`
  const functionalEntry = html !== undefined && appJs !== undefined && hasInteractiveEntry(html, appJs)

  const failureSummary: GwtFailureSummary[] = []
  const unverified: string[] = []
  let passedCount = 0
  for (const scenario of planScenarios(requirements)) {
    const name = gwtScenarioName(scenario.item.id, scenario.assertion)
    const { plan } = scenario
    if (plan.presenceFallback || !plan.effect) {
      // 存在性断言：需求原文转义匹配（模板产物）或整体交互入口（LLM 产物）一票通过
      const marker = escapeHtml(scenario.item.description)
      const ok = html !== undefined && (html.includes(marker) || functionalEntry)
      if (ok) {
        passedCount += 1
      } else {
        failureSummary.push({
          scenario: name,
          reason: html === undefined ? '预览不可访问' : `页面缺少功能入口：${scenario.item.description}`,
        })
      }
      continue
    }
    // 行为断言：关键词静态确认；未命中 → 待评估（不计失败，不触发修复循环）
    const keywordHit = plan.effect.keywords.some((keyword) => artifact.includes(keyword))
    if (keywordHit) {
      passedCount += 1
    } else {
      unverified.push(name)
      passedCount += 1
    }
  }

  return {
    total_count: failureSummary.length + passedCount,
    passed_count: passedCount,
    failed_count: failureSummary.length,
    failure_summary: failureSummary,
    ...(unverified.length ? { unverified } : {}),
  }
}

/** 同源拉取预览项目的 src/app.js（static-server 以项目目录为根，与 preview_url 同源可取）。 */
async function fetchAppJs(previewUrl: string): Promise<string | undefined> {
  try {
    const origin = new URL(previewUrl).origin
    const response = await fetch(`${origin}/src/app.js`, { signal: AbortSignal.timeout(2_000) })
    if (!response.ok) return undefined
    return await response.text()
  } catch {
    return undefined
  }
}

/**
 * LLM 产物功能断言（领域无关）：判定页面是否提供可交互的功能入口，供 gwt 与 judge 共用。
 * 不依赖具体领域（计算器/待办/音乐合成器等），只要 index.html 含交互控件且 src/app.js 有脚本逻辑，
 * 即视为功能入口存在。模板产物通常直接内嵌需求原文、走原文匹配；此断言兜底覆盖
 * 「LLM 措辞与需求原文不同」导致的假阴性。占位实现（无浏览器）下的启发式，C 的 GWTTestRunner 交付后替换。
 */
export function hasInteractiveEntry(html: string, appJs: string): boolean {
  if (!html || !appJs) return false
  const hasControl = /<(button|input|select|textarea|a|form)\b/i.test(html)
  const hasLogic = /\b(addEventListener|onclick|oninput|onchange|onsubmit|function)\b/i.test(appJs)
  return hasControl && hasLogic
}

/** 将 GWT 执行结果写为测试报告（本模块唯一写盘，供裁判读取）。 */
export function writeTestReport(input: {
  request_id: string
  session_id: string
  project_id: string
  result: GwtTestResult
}): DocumentRef {
  const project = findProject(input.project_id)
  // 挂账②：报告附带产物指纹（落盘时点口径——消费侧据此检测验证后篡改）
  const fingerprint = computeEntryFingerprint(project.root_path)
  if (fingerprint) input.result.entry_fingerprint = fingerprint
  const dir = getDocumentsDir(project.workspace_slug, project.project_id)
  writeFileSync(join(dir, TEST_REPORT_JSON), `${JSON.stringify(input.result, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, TEST_REPORT_MD), renderTestReportMarkdown(input.result, input.session_id), 'utf8')
  return { document_id: randomUUID(), type: 'test_report', path: join(dir, TEST_REPORT_JSON), status: 'synced' }
}

/** 读取最近一次测试报告；尚无报告时返回 null（供 A2-10 裁判读取）。
 *  W5（2026-09-18 本月流水账案）：熔断回滚会清掉 documents/ 下的 test-report.json，
 *  「生成完整程序」定向修复判据与修复轮据此双双断粮（文件缺席≠无失败）。回退链：
 *  文件 → analytics 的 test_completed 事件（append-only，回滚不影响，09-09 落的
 *  证据源）——按项目取最近一条，失败清单从事件 payload 还原。 */
export function readTestReport(projectId: string): GwtTestResult | null {
  const project = findProject(projectId)
  const absolute = join(getDocumentsDir(project.workspace_slug, project.project_id), TEST_REPORT_JSON)
  if (existsSync(absolute)) {
    try {
      return JSON.parse(readFileSync(absolute, 'utf8')) as GwtTestResult
    } catch {
      /* 损坏文件继续走事件回退 */
    }
  }
  return readLastTestCompletedEvent(project.workspace_slug, projectId)
}

/** 从 analytics JSONL 取项目最近一条 test_completed 事件，还原最小测试报告。 */
function readLastTestCompletedEvent(workspaceSlug: string, projectId: string): GwtTestResult | null {
  const analyticsPath = getAnalyticsPath(workspaceSlug)
  if (!existsSync(analyticsPath)) return null
  try {
    const lines = readFileSync(analyticsPath, 'utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim()
      if (!line) continue
      let parsed: { event_type?: string; project_id?: string; payload?: {
        total_count?: number; passed_count?: number; failed_count?: number
        failures?: Array<{ scenario?: unknown; reason?: unknown }>
      } }
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (parsed.event_type !== 'test_completed' || parsed.project_id !== projectId) continue
      const payload = parsed.payload ?? {}
      const failed = typeof payload.failed_count === 'number' ? payload.failed_count : 0
      return {
        total_count: typeof payload.total_count === 'number' ? payload.total_count : 0,
        passed_count: typeof payload.passed_count === 'number' ? payload.passed_count : 0,
        failed_count: failed,
        failure_summary: (Array.isArray(payload.failures) ? payload.failures : [])
          .filter((f): f is { scenario: string; reason: string } => typeof f?.scenario === 'string' && typeof f?.reason === 'string')
          .map((f) => ({ scenario: f.scenario, reason: f.reason })),
      }
    }
  } catch {
    /* 读不了事件就如实 null */
  }
  return null
}

function renderTestReportMarkdown(result: GwtTestResult, sessionId: string): string {
  const failures = result.failure_summary.map((f) => `- **${f.scenario}**：${f.reason}`).join('\n') || '- 无'
  // m-8：静态兑底「预览不可达/关键词未命中」的 unverified 不得呈现为全绿——
  // 此前 N/N 通过的报告实际可能零验证，测试全绿语义失真（不变式 10 口径）
  const unverifiedCount = result.unverified?.length ?? 0
  const unverifiedSection = unverifiedCount
    ? [
        '',
        '## 待评估（未验证）',
        '',
        `以下 ${unverifiedCount} 条静态启发式未命中关键词，按待评估放行（不计失败、未做行为验证）：`,
        ...result.unverified!.map((name) => `- ${name}`),
        '',
      ].join('\n')
    : ''
  const passLine =
    unverifiedCount > 0
      ? `- 通过：${result.passed_count}/${result.total_count}（其中 ${unverifiedCount} 条为待评估放行，未经行为验证）`
      : `- 通过：${result.passed_count}/${result.total_count}`
  return `# 测试报告

> 会话：${sessionId} · 由 GWT 执行生成（schema 对齐 api-spec §12.4）

${passLine}
${unverifiedSection}
## 未通过项

${failures}
`
}

async function fetchHtml(previewUrl: string): Promise<string | undefined> {
  try {
    const response = await fetch(previewUrl, { signal: AbortSignal.timeout(2_000) })
    if (!response.ok) return undefined
    return await response.text()
  } catch {
    return undefined
  }
}
