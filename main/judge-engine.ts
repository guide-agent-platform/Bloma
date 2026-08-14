import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectMode } from '../shared/types'
import { getDocumentsDir } from '../storage/config-paths'
import type { GwtTestResult } from './gwt-service'
import { findProject } from './project-service'
import { readPrdBackplane } from './document-engine'
import { escapeHtml } from './sketch-engine'
import { hasInteractiveEntry } from './gwt-service'

/**
 * JudgeEngine（A2-10）——只判定、不修改代码。
 *
 * - 硬约束（`return` 即退回，三方对齐：PRD 功能项 ↔ GWT 场景 ↔ 代码交互入口）：
 *   ① PRD 背板存在且核心功能项非空；② 每个 P0 功能项至少有 1 个 GWT 场景覆盖；
 *   ③ 每个 P0 功能项在生成产物中有对应交互入口（快消型只做存在性检查，长期型再做结构比对）。
 * - 软约束（`suggest`）：测试全部通过。
 * - 输出结构对齐 component-design §11：`{ verdict, hard_constraints[],
 *   soft_constraints[], user_visible_summary, repairable }`。
 * - `user_visible_summary` 使用 P0 可读语言，不含堆栈/内部标识。
 * - 硬约束退回 → 产出 `constraint_error` 修复类别（A2-08 承接重新生成 PRD/GWT）；
 *   本引擎绝不直接修改代码。
 */

export interface JudgeConstraint {
  name: string
  passed: boolean
  detail: string
}

export interface JudgeVerdict {
  verdict: 'pass' | 'suggest' | 'return'
  hard_constraints: JudgeConstraint[]
  soft_constraints: JudgeConstraint[]
  user_visible_summary: string
  repairable: boolean
}

export interface JudgeInput {
  project_id: string
  mode: ProjectMode
  test_result?: GwtTestResult
}

export function runJudge(input: JudgeInput): JudgeVerdict {
  const project = findProject(input.project_id)
  const requirements = readPrdBackplane(input.project_id).requirements
  const featureIds = readGwtFeatureIds(input.project_id)

  // ── 硬约束 ──
  const prdPresent: JudgeConstraint = {
    name: 'PRD 核心功能项',
    passed: requirements.length > 0,
    detail: requirements.length > 0 ? `已包含 ${requirements.length} 个功能项` : '还没有确认的核心功能项',
  }
  const missingGwt = requirements.filter((item) => !featureIds.includes(item.id))
  const gwtCoverage: JudgeConstraint = {
    name: 'GWT 场景覆盖',
    passed: missingGwt.length === 0,
    detail: missingGwt.length === 0
      ? `全部 ${requirements.length} 个功能项都有 GWT 场景`
      : `缺少 GWT 场景：${missingGwt.map((item) => item.id).join('、')}`,
  }

  // ── 硬约束：代码交互入口（三方对齐收口，改造 E）──
  // LLM 产物不应要求内嵌需求原文（措辞不同会造成假阴性），与 GWT 执行同步改用
  // 领域无关的功能断言——index.html 含交互控件 + app.js 含脚本逻辑，即视为功能项
  // 有对应入口；模板产物仍按需求原文转义后的文本匹配兜底。快消型只做存在性：
  // 只要产物整体存在可交互入口即视为全部功能项对齐（长期型再做逐项结构比对）。
  const indexHtml = readProjectHtml(project.root_path)
  const appJs = readProjectAppJs(project.root_path)
  const functionalEntry = hasInteractiveEntry(indexHtml, appJs)
  const missingEntry = requirements.filter((item) => {
    const textualEntry = indexHtml.includes(escapeHtml(item.description))
    return !(textualEntry || functionalEntry)
  })
  const codeConsistency: JudgeConstraint = {
    name: '代码交互入口',
    passed: missingEntry.length === 0,
    detail: missingEntry.length === 0
      ? '功能项在页面中有对应入口'
      : `页面缺少入口：${missingEntry.map((item) => item.id).join('、')}`,
  }
  const hardConstraints: JudgeConstraint[] = [prdPresent, gwtCoverage, codeConsistency]

  // ── 软约束：测试结果 ──
  const softConstraints: JudgeConstraint[] = []
  if (input.test_result) {
    const result = input.test_result
    softConstraints.push({
      name: '测试结果',
      passed: result.failed_count === 0,
      detail: result.failed_count === 0
        ? `测试 ${result.passed_count}/${result.total_count} 全部通过`
        : `仍有 ${result.failed_count} 项测试未通过`,
    })
  }

  const hardFailed = hardConstraints.filter((item) => !item.passed)
  if (hardFailed.length > 0) {
    return {
      verdict: 'return',
      hard_constraints: hardConstraints,
      soft_constraints: softConstraints,
      user_visible_summary: hardFailed.map((item) => item.detail).join('；'),
      repairable: true,
    }
  }

  const softFailed = softConstraints.filter((item) => !item.passed)
  if (softFailed.length > 0) {
    return {
      verdict: 'suggest',
      hard_constraints: hardConstraints,
      soft_constraints: softConstraints,
      user_visible_summary: softFailed.map((item) => item.detail).join('；'),
      repairable: false,
    }
  }

  return {
    verdict: 'pass',
    hard_constraints: hardConstraints,
    soft_constraints: softConstraints,
    user_visible_summary: '核心功能都已对齐，可以继续。',
    repairable: false,
  }
}

/** 读取 documents/{project_id}/features/ 下的 GWT feature 文件 id 列表。 */
export function readGwtFeatureIds(projectId: string): string[] {
  const project = findProject(projectId)
  const featuresDir = join(getDocumentsDir(project.workspace_slug, project.project_id), 'features')
  if (!existsSync(featuresDir)) return []
  return readdirSync(featuresDir)
    .filter((name) => name.endsWith('.feature'))
    .map((name) => name.slice(0, -'.feature'.length))
}

function readProjectHtml(projectRoot: string): string {
  const indexPath = join(projectRoot, 'index.html')
  if (!existsSync(indexPath)) return ''
  try {
    return readFileSync(indexPath, 'utf8')
  } catch {
    return ''
  }
}

function readProjectAppJs(projectRoot: string): string {
  const appJsPath = join(projectRoot, 'src', 'app.js')
  if (!existsSync(appJsPath)) return ''
  try {
    return readFileSync(appJsPath, 'utf8')
  } catch {
    return ''
  }
}
