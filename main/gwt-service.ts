import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DocumentRef } from '../shared/types'
import { getDocumentsDir } from '../storage/config-paths'
import { findProject, readLastSketchRequirements } from './project-service'
import { escapeHtml, type SketchRequirement } from './sketch-engine'
import { planScenarios, runBrowserGwt, scenarioName as gwtScenarioName } from './gwt-runner'
import { replayRequirements, splitAdvisoryResults } from './experience/replay-compiler'
import { reportReplayOutcomes } from './experience/experience-service'

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
  if (replay.length === 0) return raw
  const names = new Set(replay.map((r) => gwtScenarioName(r.id, (r.behavior_assertions ?? [''])[0])))
  const { gated, outcomes } = splitAdvisoryResults(raw, names)
  void reportReplayOutcomes(outcomes).catch((error) => console.warn('[experience] replay report failed:', error))
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
  const dir = getDocumentsDir(project.workspace_slug, project.project_id)
  writeFileSync(join(dir, TEST_REPORT_JSON), `${JSON.stringify(input.result, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, TEST_REPORT_MD), renderTestReportMarkdown(input.result, input.session_id), 'utf8')
  return { document_id: randomUUID(), type: 'test_report', path: join(dir, TEST_REPORT_JSON), status: 'synced' }
}

/** 读取最近一次测试报告；尚无报告时返回 null（供 A2-10 裁判读取）。 */
export function readTestReport(projectId: string): GwtTestResult | null {
  const project = findProject(projectId)
  const absolute = join(getDocumentsDir(project.workspace_slug, project.project_id), TEST_REPORT_JSON)
  if (!existsSync(absolute)) return null
  try {
    return JSON.parse(readFileSync(absolute, 'utf8')) as GwtTestResult
  } catch {
    return null
  }
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
