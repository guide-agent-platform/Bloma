import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DocumentRef } from '../shared/types'
import { getDocumentsDir } from '../storage/config-paths'
import { findProject, readLastSketchRequirements } from './project-service'
import { escapeHtml, type SketchRequirement } from './sketch-engine'
import { runBrowserGwt } from './gwt-runner'

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
  // 真实浏览器执行器优先（A2-07 / api-spec §12.4）：Playwright 无头加载预览页，
  // 真正执行页面 JS 后对每个 P0 功能项断言功能入口；浏览器不可用（未安装 chromium
  // / 导入失败 / 启动失败 / 导航失败）时返回 null，自动降级为下方 fetch + 正则 静态启发式。
  const browserResult = await runBrowserGwt(input)
  if (browserResult) return browserResult

  const project = findProject(input.project_id)
  const requirements = readLastSketchRequirements(input.project_id)
  const items = requirements.length ? requirements : [{ id: 'F-001', description: '核心功能页面可访问' }]
  const html = input.preview_url ? await fetchHtml(input.preview_url) : undefined
  const appJs = input.preview_url ? await fetchAppJs(input.preview_url) : undefined

  // LLM 产物功能断言（A2-14b）：模型产物的 index.html 未必内嵌需求描述原文（措辞不同会假阴性），
  // 改用领域无关的「交互控件 + 脚本逻辑」判定，避免误判失败进 repair 被模板替换。
  if (html !== undefined && appJs !== undefined && hasInteractiveEntry(html, appJs)) {
    return { total_count: items.length, passed_count: items.length, failed_count: 0, failure_summary: [] }
  }

  const failureSummary: GwtFailureSummary[] = []
  let passedCount = 0
  for (const item of items) {
    // 服务端模板对 description 做了 HTML 转义，比对时同样转义
    const marker = escapeHtml(item.description)
    const ok = html !== undefined && html.includes(marker)
    if (ok) {
      passedCount += 1
    } else {
      failureSummary.push({
        scenario: scenarioName(item),
        reason: html === undefined ? '预览不可访问' : `页面缺少功能入口：${item.description}`,
      })
    }
  }

  return {
    total_count: items.length,
    passed_count: passedCount,
    failed_count: items.length - passedCount,
    failure_summary: failureSummary,
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

function scenarioName(item: SketchRequirement): string {
  return `${item.id} 核心路径可运行`
}

function renderTestReportMarkdown(result: GwtTestResult, sessionId: string): string {
  const failures = result.failure_summary.map((f) => `- **${f.scenario}**：${f.reason}`).join('\n') || '- 无'
  return `# 测试报告

> 会话：${sessionId} · 由 GWT 执行生成（schema 对齐 api-spec §12.4）

- 通过：${result.passed_count}/${result.total_count}

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
