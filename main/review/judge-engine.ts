import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentLoopJudgeMetadata, ProjectMode } from '../../shared/types'
import { getDocumentsDir } from '../../storage/config-paths'
import type { GwtTestResult } from '../gwt-service'
import { findProject } from '../project-service'
import { TEMPLATE_META_VERSION } from '../sketch-engine'
import { isInjectionEnabled } from '../template-injection'
import { readPrdBackplane, readUxContractSketch } from '../document-engine'
import { escapeHtml, requirementAssertions, requirementPriority, backplaneAiCapabilities, type SketchRequirement } from '../sketch-engine'
import { hasInteractiveEntry } from '../gwt-service'
import { parseBehaviorAssertion } from '../behavior-assertions'
import { antidegradeEnabled, detectAntidegrade } from './judge-antidegrade'
import { recordFailureCards } from '../experience/error-card'

/**
 * JudgeEngine（A2-10 + 2026-08-17 §8.1 行为门禁）——只判定、不修改代码。
 *
 * - 硬约束（`return` 即退回）：
 *   ① PRD 背板存在且核心功能项非空；
 *   ② 每个功能项至少有 1 个 GWT 场景覆盖（P0 严格要求）；
 *   ③ P0 行为断言可满足性（从「存在性」升级为「行为性」）：
 *     - 存在性基线保留：产物整体具备交互入口（控件 + 脚本），模板产物按原文匹配兜底；
 *     - **运行证据优先**（§7.4 行为脚本就绪时）：GWT 测试报告里该断言的场景失败 → 退回；
 *     - 有界静态启发式兜底（无浏览器环境）：断言效果关键词出现在产物全文 → 确认；
 *       词表未命中或产物未现关键词 → **待评估不退回**（防 SVG/canvas/@keyframes 等
 *       不落关键词的合法实现被误杀，由行为脚本/人工确认兜底）。
 * - 软约束（`suggest`）：测试全部通过；精致度代理（UX 契约存在时：MVP 产物规模与
 *   草图 class 覆盖率不低于粗粒度下界，防体验倒挂 P4）。
 * - 输出结构对齐 component-design §11；`user_visible_summary` 用 P0 可读语言。
 * - 硬约束退回 → 产出 `constraint_error` 修复类别；本引擎绝不直接修改代码。
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
  /** Agent Loop 结果元数据（M4-B，loop-aware）：loop 异常终止态判「不达标/让渡」，不信模型自述 */
  loop?: AgentLoopJudgeMetadata
}

export function runJudge(input: JudgeInput): JudgeVerdict {
  // M4-B loop-aware 分支（在磁盘读判之前）：loop 未正常收尾（turn_limit / budget_exhausted /
  // cancelled）→ 硬约束失败且 repairable=false——产物即使「能跑」也不放行，绝不凭模型自述放行。
  if (input.loop && input.loop.status !== 'completed') {
    const loopConstraint: JudgeConstraint = {
      name: 'Agent Loop 完成状态',
      passed: false,
      detail: `自动生成未正常收尾（${loopStatusLabel(input.loop.status)}，${input.loop.turns} 轮），产物不能直接交付`,
    }
    return {
      verdict: 'return',
      hard_constraints: [loopConstraint],
      soft_constraints: [],
      user_visible_summary: `自动生成没有正常收尾（${loopStatusLabel(input.loop.status)}），需要你决定怎么处理。`,
      repairable: false,
    }
  }

  const project = findProject(input.project_id)
  const backplane = readPrdBackplane(input.project_id)
  const requirements = backplane.requirements
  const featureIds = readGwtFeatureIds(input.project_id)

  // ── 硬约束①：背板存在 ──
  const prdPresent: JudgeConstraint = {
    name: 'PRD 核心功能项',
    passed: requirements.length > 0,
    detail: requirements.length > 0 ? `已包含 ${requirements.length} 个功能项` : '还没有确认的核心功能项',
  }

  // ── 硬约束②：GWT 覆盖（P0 严格；骨架对全量功能项产出，存量语义不变） ──
  const missingGwt = requirements.filter((item) => !featureIds.includes(item.id))
  const gwtCoverage: JudgeConstraint = {
    name: 'GWT 场景覆盖',
    passed: missingGwt.length === 0,
    detail: missingGwt.length === 0
      ? `全部 ${requirements.length} 个功能项都有 GWT 场景`
      : `缺少 GWT 场景：${missingGwt.map((item) => item.id).join('、')}`,
  }

  // ── 硬约束③：P0 行为断言可满足性（§8.1 行为门禁） ──
  const artifact = readArtifactText(project.root_path)
  const indexHtml = readProjectHtml(project.root_path)
  const appJs = readProjectAppJs(project.root_path)
  const codeConsistency = evaluateBehaviorAssertions(requirements, indexHtml, appJs, artifact, input.test_result)
  // Phase 3 B4（2026-09-09）：反退化硬约束（规则先行层，LLM 语义腿之前拒已知坏实现）。
  // 开关 off=现状（约束不追加，判定逐字节不变）；ai-mock-frontend 以前端产物必含
  // fetch('/api/llm') 的平台接入形态为口径（server 侧无需读——/api/llm 由平台产物服务器提供）。
  const antidegrade = antidegradeEnabled()
    ? detectAntidegrade({ artifact, caps: backplaneAiCapabilities(backplane) })
    : []
  // C3（2026-09-09）：反退化 findings 同步落负经验卡（fire-and-forget；experience 开关 off
  // 时 recordFailureCards 内部零副作用——判定链路字节不变）
  if (antidegrade.length > 0) {
    recordFailureCards({ projectId: input.project_id }, { antidegrade })
  }
  const hardConstraints: JudgeConstraint[] = [
    prdPresent,
    gwtCoverage,
    codeConsistency,
    ...(antidegrade.length > 0 || antidegradeEnabled()
      ? [
          {
            name: '能力反退化（已知坏实现）',
            passed: antidegrade.length === 0,
            detail: antidegrade.length === 0 ? '无 AI 冒充/无需求依据控件等已知坏实现形态' : antidegrade.map((f) => f.detail).join('；'),
          },
        ]
      : []),
  ]

  // ── 软约束 ──
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
  const refinement = evaluateRefinementProxy(project.project_id, backplane.ux_contract, indexHtml, artifact)
  if (refinement) softConstraints.push(refinement)

  // 注入点⑧（周计划 §6）：章节同步校验——轻量版本一致性（背板 template_meta.version
  // 落后当前模板包版本时提示重建，**不扩任务完成度判定**防双口径）；开关关闭=现状。
  // 仅 soft 提示且 passed=true，不影响 pass/suggest 走向（提示性对齐建议）。
  if (isInjectionEnabled('judge') && backplane.template_meta && backplane.template_meta.version < TEMPLATE_META_VERSION) {
    softConstraints.push({
      name: '模板版本一致性',
      passed: true,
      detail: `PRD 由旧版模板（v${backplane.template_meta.version}）生成，当前模板包为 v${TEMPLATE_META_VERSION}；建议重新生成 PRD 以对齐最新章节口径（不影响本次交付判定）`,
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

/**
 * 硬约束③ 判定：P0 功能项的每条行为断言三档判定（运行证据 > 静态确认 > 待评估），
 * 外加存在性基线（产物整体有交互入口 / 原文匹配，与改造前语义同构）。
 */
function evaluateBehaviorAssertions(
  requirements: SketchRequirement[],
  indexHtml: string,
  appJs: string,
  artifact: string,
  testResult: GwtTestResult | undefined,
): JudgeConstraint {
  const functionalEntry = hasInteractiveEntry(indexHtml, appJs)
  const failedScenarios = testResult?.failure_summary ?? []
  const p0Items = requirements.filter((item) => requirementPriority(item) === 'P0')

  // 存在性基线：任何功能项既无原文匹配又无整体交互入口 → 退回（保留改造前防线）
  const missingEntry = requirements.filter((item) => {
    const textualEntry = indexHtml.includes(escapeHtml(item.description))
    return !(textualEntry || functionalEntry)
  })
  if (missingEntry.length > 0) {
    return {
      name: 'P0 行为断言可满足性',
      passed: false,
      detail: `页面缺少入口：${missingEntry.map((item) => item.id).join('、')}`,
    }
  }

  // 运行证据优先（§8.1）：行为脚本报告里该断言的场景失败 → 退回（P3「车不位移」在此关门）。
  // m-9：场景名精确等值对账（`${itemId} ${assertion}`）——此前 includes(assertion) 子串匹配，
  // 同 item 断言互为子串时（「新增一条记录」⊂「新增一条记录并高亮」）失败误归属到未失败断言
  const runtimeFailed: string[] = []
  for (const item of p0Items) {
    for (const assertion of requirementAssertions(item)) {
      const failed = failedScenarios.some(
        (failure) => failure.scenario.trim() === `${item.id} ${assertion}`.trim(),
      )
      if (failed) runtimeFailed.push(`${item.id} ${assertion}`)
    }
  }
  if (runtimeFailed.length > 0) {
    return {
      name: 'P0 行为断言可满足性',
      passed: false,
      detail: `行为断言未通过（运行验证）：${runtimeFailed.join('；')}`,
    }
  }

  // 静态启发式（无运行证据时的兜底确认）：关键词命中 → 确认；未命中 → 待评估不退回
  const pending: string[] = []
  let confirmed = 0
  let behavioral = 0
  for (const item of p0Items) {
    for (const assertion of requirementAssertions(item)) {
      const plan = parseBehaviorAssertion(assertion)
      if (plan.presenceFallback || !plan.effect) continue
      behavioral += 1
      if (plan.effect.keywords.some((keyword) => artifact.includes(keyword))) {
        confirmed += 1
      } else {
        pending.push(`${item.id} ${assertion}`)
      }
    }
  }
  const pendingNote = pending.length > 0 ? `；待评估（静态无法确认，运行验证兜底）：${pending.join('、')}` : ''
  return {
    name: 'P0 行为断言可满足性',
    passed: true,
    detail: behavioral > 0
      ? `P0 行为断言 ${confirmed}/${behavioral} 静态确认${pendingNote}`
      : '功能项在页面中有对应入口',
  }
}

/**
 * 精致度软约束（§8.1 新增，P4 体验倒挂的粗粒度下界）：UX 契约存在时比较
 * ①产物规模 ≥ 草图 50%（字节量级，防 MVP 塌缩为单行文本）
 * ②草图 class 选择器在产物中覆盖率 ≥ 30%（对应 §4.3 移植清单）。
 * 粗粒度代理仅兜底拦截明显倒挂，非美学精测；失败 → suggest（不退回）。
 */
function evaluateRefinementProxy(
  projectId: string,
  uxContract: { sketch_rel_path: string; confirmed_at: string } | undefined,
  indexHtml: string,
  artifact: string,
): JudgeConstraint | undefined {
  if (!uxContract) return undefined
  const sketch = readUxContractSketch(projectId, { ux_contract: uxContract })
  if (!sketch || !indexHtml) return undefined

  const scaleOk = artifact.length >= Math.floor(sketch.length * 0.5)
  const sketchClasses = extractCssClasses(sketch)
  const covered = sketchClasses.filter((cls) => artifact.includes(cls))
  const coverageOk = sketchClasses.length === 0 || covered.length / sketchClasses.length >= 0.3

  if (scaleOk && coverageOk) return undefined
  const reasons: string[] = []
  if (!scaleOk) reasons.push(`产物规模明显小于草图（${artifact.length} vs ${sketch.length} 字符）`)
  if (!coverageOk) reasons.push(`草图样式类迁移不足（${covered.length}/${sketchClasses.length}）`)
  return {
    name: '视觉精致度（对照草图）',
    passed: false,
    detail: reasons.join('；'),
  }
}

/** 提取 HTML 内联 <style> 与 class 属性中的 CSS 类名（去重）。 */
function extractCssClasses(html: string): string[] {
  const classes = new Set<string>()
  for (const match of html.matchAll(/\.([a-zA-Z][\w-]*)\s*[{,:.\s]/g)) {
    classes.add(match[1])
  }
  for (const match of html.matchAll(/class\s*=\s*["']([^"']+)["']/g)) {
    for (const cls of match[1].split(/\s+/)) {
      if (/^[a-zA-Z][\w-]*$/.test(cls)) classes.add(cls)
    }
  }
  return [...classes]
}

/** Agent Loop 异常终止态 → 用户可读标签（loop-aware judge 的 user_visible_summary 用）。 */
function loopStatusLabel(status: AgentLoopJudgeMetadata['status']): string {
  switch (status) {
    case 'turn_limit':
      return '达到轮次上限'
    case 'budget_exhausted':
      return '修复预算耗尽'
    case 'cancelled':
      return '被取消'
    default:
      return status
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

/** 读取产物全文（index.html + src/ 下 js/css），供行为断言关键词检查与语义审查。 */
export function readArtifactText(projectRoot: string): string {
  const parts: string[] = [readProjectHtml(projectRoot)]
  const srcDir = join(projectRoot, 'src')
  if (existsSync(srcDir)) {
    for (const name of readdirSync(srcDir)) {
      if (!/\.(js|css)$/.test(name)) continue
      try {
        parts.push(readFileSync(join(srcDir, name), 'utf8'))
      } catch {
        // 单文件读取失败跳过（部分产物不阻碍其余检查）
      }
    }
  }
  return parts.join('\n')
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
