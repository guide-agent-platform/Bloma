import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DocumentRef } from '../shared/types'
import { getDocumentsDir } from '../storage/config-paths'
import { findProject, readLastSketchRequirements } from './project-service'
import { escapeHtml, type SketchRequirement } from './sketch-engine'

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

/** 在预览上执行 GWT 场景，返回结构化结果（占位实现；C 的 GWTTestRunner 替换）。 */
export async function runGwtScenarios(input: RunGwtInput): Promise<GwtTestResult> {
  const project = findProject(input.project_id)
  const requirements = readLastSketchRequirements(input.project_id)
  const items = requirements.length ? requirements : [{ id: 'F-001', description: '核心功能页面可访问' }]
  const html = input.preview_url ? await fetchHtml(input.preview_url) : undefined

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
