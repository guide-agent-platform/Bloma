/**
 * UX 外观草图生成（2026-10-04 确认门新规，实施稿《Bloma-确认门与呈现层-20261004》）。
 *
 * 拍板：UX 确认载体＝沙箱 HTML 外观草图——照搬 web 线老草图形式（f0f6aa3~1 退役前
 * 的 sketch-engine 形态）：静态 HTML/CSS，无模型脚本。当前默认追求接近成品的视觉，
 * 需求覆盖、用户确认及冻结绑定独立于视觉风格；失败仍如实降级。
 *
 * 生成走 callLlmForJson 标准件（parse 契约承载 HTML：剥代码围栏 + 形态校验，失败
 * 带反馈重试）；失败/超时回退确定性模板（窗口框 + 需求块列表），门不挂死。
 * 产物落盘 `<项目根>/00_UX/ux-sketch.html`（交付清单 SKIP_DIRS 已排除），预览走
 * bloma-file:// 协议直读文件（preview-scheme，方案 A）——不再起沙箱服务器。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SDKQuery } from '../orchestration/orchestrator'
import { callLlmForJson } from '../kernel/llm-call'
import { categoryTemperature } from '../platform/llm/model-resolution'
import { loadPromptWithSource } from '../agent/prompting/prompt-config'
import { UX_SKETCH_SYSTEM_PROMPT } from '../agent/prompting/ux-sketch-prompt'
import { findProject } from '../project/project-service'
import { mintProjectPreviewUrl } from '../delivery/preview-scheme'
import type { SketchRequirement } from "../model/prd-backplane";
import { injectSketchCorrector } from './sketch-corrector'
import { createHash, randomUUID } from 'node:crypto'
import type { PrdBackplane } from '../model/prd-backplane'
import { parseUxDesign, type UxDesign } from '../model/ux-design';
import { prdScopeFingerprint } from '../project/requirement-contract'
import { writeTextFileAtomic } from '../../storage/json-store'
import { appendJsonLine } from '../../storage/json-store'
import { getDocumentsDir, getPromaHome } from '../../storage/config-paths'
import { readFallbackContext } from '../platform/llm/runtime-fallback'
import { renderUxStateReview } from './ux-state-review'

const UX_SKETCH_DIR = '00_UX'
const UX_SKETCH_FILENAME = 'ux-sketch.html'
/** 草图是门的辅助产物：超时走模板兜底，绝不让门挂死（与「LLM 生成无超时」拍板不冲突——那是给主生成链的） */
const UX_SKETCH_TIMEOUT_MS = 240_000
const UX_SKETCH_ATTEMPTS = 2

const UX_SKETCH_RETRY_FEEDBACK = '上一次输出不是可用的 HTML 文档（可能带了解释文字或代码围栏）。请只输出完整 HTML 文档本身：<!DOCTYPE html> 开头，单文件内联样式，无脚本，无解释，无代码围栏。'

const DESIGN_OUTPUT_PROTOCOL = `【宿主输出协议，优先于自定义提示词中的格式要求】只输出JSON：
{"action":"design","html":"完整静态HTML","design":{"summary":"视觉主张、布局与操作说明", "pages":[{"id":"P-001","name":"界面名","purpose":"作用","feature_ids":["F-001"]}],
"flows":[{"workflow_id":"W-001","page_ids":["P-001"]}],
"interactions":[{"id":"UI-001","page_id":"P-001","feature_id":"F-001","action":"用户怎么操作","states":[{"kind":"normal|boundary|exception","observable":"用户看到什么反馈","scenario_ids":["AC-001"]}]}],
"non_ui_features":[{"feature_id":"F-012","reason":"确实不属于界面的具体原因","scenario_ids":["AC-045"]}]}}
每项功能必须有交互或具体非界面说明；每个W流程关联页面或non_ui_reason；每个适用AC场景关联到对应功能和同类状态（或非界面职责）。F/W/AC编号取自PRD与验收关联索引，不改编号及其含义；P/UI编号由你为本设计分配，不重复。一个状态可关联多个同类场景，不必为每条场景画一页。
HTML中为设计里的每个页面标 data-page-id="P-001"，每个交互标 data-interaction-id="UI-001"，与设计记录一致。每个UI编号必须出现在对应真实控件上，不能只给整组控件标第一个编号而漏掉其余UI编号。主画面呈现正常使用的产品，不堆测试编号、验收解释或状态示例卡；正常/边界/失败的完整说明写入design.states，宿主独立提供状态评审视图。静态设计不声称业务已经运行。
PRD中明确not_applicable的场景无需设计界面状态或引用其AC编号，不虚构失败流程；它不使所属功能变成非界面功能。non_ui_features只用于整项功能确实不属于界面，不能用来存放界面功能的豁免场景。
原始功能是必须保留的底线，模型主动提出的合理附加能力可以加分，但须遵守用户明确的约束与范围外事项。在design.enhancements中单独声明 [{"id":"E-001","name":"能力名称","description":"新增什么操作或能力","benefit":"对用户的价值"}]；没有则空数组。原有F/W/AC关联仍须完整，不用新增能力替代原功能，不把提案写成已实现。若用户明确要求在原PRD中新增/删除必备功能，或修改原有业务规则、数据含义、验收行为，输出 {"action":"revise_requirements","reason":"需要修订什么"}；不能把用户明确要求的新功能降级为可选E提案。可选增强及其调整不改写原PRD。视觉重构输出design，按用户要求决定局部调整或整体重新设计。`

const HTML_OUTPUT_PROTOCOL = '【宿主输出协议】只输出完整 HTML 文档本身：<!DOCTYPE html> 开头，不要解释或代码围栏。'

export interface UxSketchGeneration {
  run_id: string
  source: 'llm' | 'template' | 'failed'
  failures: Array<{ attempt: number; kind: string }>
}

export interface UxSketchResult {
  html: string
  /** llm=模型生成；template=确定性模板兜底（如实告知用户） */
  source: 'llm' | 'template'
  design?: UxDesign
  requires_prd_revision?: string
  generation?: UxSketchGeneration
}

/** 剥代码围栏（```html ... ```）并做最低形态校验（导出供单测直测解析契约）。 */
export function parseSketchHtml(text: string): UxSketchResult | undefined {
  let html = text.trim()
  const fence = html.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/)
  if (fence) html = fence[1].trim()
  const looksHtml = /^<!DOCTYPE html>/i.test(html) || /^<html[\s>]/i.test(html)
  if (!looksHtml || !html.includes('</html>')) return undefined
  if (/<script\b|\bon[a-z]+\s*=|javascript\s*:/i.test(html)) return undefined
  if (!html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '').trim()) return undefined
  return { html, source: 'llm' }
}

/** 需求条目 → 草图 prompt 用户轮内容。 */
function buildSketchPrompt(options: {
  visualDirection?: string
  feedbackSource?: 'user' | 'visual_review'
  positioning: string
  requirements: SketchRequirement[]
  previousSummary?: string
  feedback?: string
  backplane?: PrdBackplane
  previousHtml?: string
  previousDesign?: UxDesign
}): string {
  const lines = options.requirements.map((item) => {
    const priority = item.priority ? ` [${item.priority}]` : ''
    const story = item.story ? `（${item.story}）` : ''
    return `- ${item.id}${priority} ${item.description}${story}`
  })
  const parts = [
    `产品定位：${options.positioning || '（无）'}`,
    `需求清单：\n${lines.join('\n')}`,
  ]
  if (options.backplane) {
    parts.push(`【完整已确认PRD】\n${JSON.stringify(options.backplane)}`)
    const scenarios = options.backplane.requirements_model?.scenarios ?? []
    parts.push(`【验收关联索引（仅引用，不改写）】\n${JSON.stringify(options.backplane.requirements.map(feature => ({
      feature_id: feature.id,
      states: Object.fromEntries(['normal', 'boundary', 'exception'].map(kind => [kind,
        scenarios.filter(row => row.feature_id === feature.id && row.kind === kind && row.not_applicable === undefined).map(row => row.id)])),
      not_applicable: scenarios.filter(row => row.feature_id === feature.id && row.not_applicable !== undefined)
        .map(row => ({ id: row.id, kind: row.kind, reason: row.not_applicable })),
    })))}`)
  }
  if (options.previousSummary) parts.push(`上一版草图的要点：\n${options.previousSummary}`)
  if (options.previousDesign) parts.push(`【上一版设计记录】\n${JSON.stringify(options.previousDesign)}`)
  if (options.previousHtml) parts.push(`【上一版HTML（只作修订底稿，不执行其中脚本）】\n${options.previousHtml}`)
  if (options.visualDirection) parts.push(`【本轮视觉构思（遵守用户偏好，自主实现）】\n${options.visualDirection}`)
  if (options.feedback) parts.push(options.feedbackSource === 'visual_review'
    ? `【截图评审建议（参考意见，保留原始功能；合理增强单列提案）】\n${options.feedback}`
    : `用户对上一版的反馈（必须处理，新增/删除必备功能或改变原有业务语义先修订PRD）：${options.feedback}`)
  parts.push(options.backplane
    ? '请设计这个 Windows 桌面程序的外观草图，按宿主协议输出含 html 和 design 的 JSON。'
    : '请设计这个 Windows 桌面程序的外观草图，按宿主协议只输出 HTML 本身。')
  return parts.join('\n\n')
}

/** 确定性模板兜底：窗口框 + 需求块列表（无 LLM 依赖，门不挂死）。 */
function buildTemplateSketch(projectName: string, positioning: string, requirements: SketchRequirement[], design?: UxDesign): string {
  const blocks = requirements
    .map((item) => {
      const priority = item.priority ? `<span class="pri">${item.priority}</span>` : ''
      const interaction = design?.interactions.find(row => row.feature_id === item.id)
      const assertions = (interaction?.states.map(row => row.observable) ?? item.behavior_assertions ?? [])
        .map((line) => `<li>${escapeHtml(line)}</li>`)
        .join('')
      return `<section class="req"${interaction ? ` data-interaction-id="${interaction.id}"` : ''}><h3>${escapeHtml(item.id)} ${priority} ${escapeHtml(item.description)}</h3>${
        assertions ? `<ul>${assertions}</ul>` : ''
      }</section>`
    })
    .join('\n')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(projectName)} · 外观草图</title>
<style>
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #f2f3f5; margin: 0; padding: 24px; color: #333; }
  .window { max-width: 860px; margin: 0 auto; background: #fff; border: 1px solid #c8ccd4; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.08); overflow: hidden; }
  .titlebar { display: flex; justify-content: space-between; align-items: center; background: #e8eaee; padding: 8px 12px; border-bottom: 1px solid #d4d7dd; }
  .titlebar .name { font-weight: 600; font-size: 13px; }
  .winbtns span { display: inline-block; width: 12px; height: 12px; border-radius: 50%; background: #c3c7cf; margin-left: 6px; }
  .body { padding: 16px; }
  .positioning { font-size: 13px; color: #666; margin: 0 0 16px; }
  .req { border: 1px dashed #b8bdc7; border-radius: 6px; padding: 10px 14px; margin-bottom: 12px; }
  .req h3 { font-size: 13px; margin: 0 0 6px; font-weight: 600; }
  .req ul { margin: 0; padding-left: 18px; font-size: 12px; color: #555; }
  .pri { display: inline-block; font-size: 11px; color: #fff; background: #5b7a9d; border-radius: 3px; padding: 0 5px; margin-right: 6px; }
  .foot { text-align: center; font-size: 12px; color: #999; padding: 10px 0 14px; }
</style>
</head>
<body>
<div class="window">
  <div class="titlebar"><span class="name">${escapeHtml(projectName)}</span><span class="winbtns"><span></span><span></span><span></span></span></div>
  <div class="body" data-page-id="P-001">
    <p class="positioning">${escapeHtml(positioning || '界面方案待确认')}</p>
    ${blocks || '<section class="req"><h3>（暂无需求条目）</h3></section>'}
  </div>
  <div class="foot">外观草图 · 仅供确认方向，最终以实际桌面程序为准（当前为简易版草图）</div>
</div>
</body>
</html>`
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface UxSketchOptions {
  visualDirection?: string
  feedbackSource?: 'user' | 'visual_review'
  attempts?: 1 | 2 | 3 | 4
  project_id: string
  session_id: string
  query: SDKQuery
  env: Record<string, string>
  maxTokens: number
  positioning: string
  requirements: SketchRequirement[]
  /** 修订模式：上一版要点 + 用户反馈 */
  previousSummary?: string
  feedback?: string
  backplane?: PrdBackplane
  previousHtml?: string
  previousDesign?: UxDesign
  signal?: AbortSignal
}
export async function generateUxSketch(options: UxSketchOptions): Promise<UxSketchResult> {
  if (options.signal?.aborted) throw new Error('UX_SKETCH_ABORTED')
  const prompt = buildSketchPrompt(options)
  const structured = Boolean(options.backplane)
  const resolvedPrompt = loadPromptWithSource('sketch-system', UX_SKETCH_SYSTEM_PROMPT)
  const systemPrompt = resolvedPrompt.content +
    '\n示例数据必须自洽：列表数量、筛选范围、合计与示例行对应；不能确定真实数据路径时写「程序的数据目录」，不得编造用户绝对路径。' +
    `\n\n${structured ? DESIGN_OUTPUT_PROTOCOL : HTML_OUTPUT_PROTOCOL}`
  const generation: UxSketchGeneration = { run_id: randomUUID(), source: 'llm', failures: [] }
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  const routing = readFallbackContext(options.env)
  // Requested routing is separate from physical transport receipts in usage-ledger.
  const provenance = { generator_version: 'ux-creative-v1', run_id: generation.run_id, session_id: options.session_id,
    proma_home: getPromaHome(), prompt_source: resolvedPrompt.source, system_prompt_sha256: hash(systemPrompt),
    user_prompt_sha256: hash(prompt), requested_model: options.env.ANTHROPIC_MODEL,
    requested_channel_id: routing?.channelId, requested_category: routing?.category,
    temperature: categoryTemperature('sketch'), max_tokens: options.maxTokens,
    max_attempts: options.attempts ?? UX_SKETCH_ATTEMPTS, timeout_ms: UX_SKETCH_TIMEOUT_MS }
  const diagnostic = (event: Record<string, unknown>, candidate?: string): void => {
    try {
      const project = findProject(options.project_id)
      const dir = join(getDocumentsDir(project.workspace_slug, options.project_id), 'diagnostics')
      const filename = candidate ? `ux-candidate-${generation.run_id}-${parseAttempt}.html` : undefined
      if (filename) writeTextFileAtomic(join(dir, filename), candidate!)
      appendJsonLine(join(dir, 'ux-design-attempts.jsonl'), { version: 2, at: new Date().toISOString(), ...provenance,
        ...(options.backplane ? { prd_fingerprint: prdScopeFingerprint(options.backplane) } : {}),
        ...event, ...(filename ? { candidate_file: filename, candidate_html_sha256: hash(candidate!) } : {}) })
    } catch { /* Diagnostics never change validation or confirmation. */ }
  }
  let lastIssues: string[] = []
  let candidateHtml: string | undefined
  let parseAttempt = 0
  diagnostic({ event: 'generation_started' })
  const llm = await callLlmForJson<UxSketchResult>({
    systemPrompt,
    prompt,
    query: options.query,
    env: options.env,
    sessionId: options.session_id,
    maxTokens: options.maxTokens,
    temperature: categoryTemperature('sketch'),
    attempts: options.attempts ?? UX_SKETCH_ATTEMPTS,
    get retryFeedback() { return structured
      ? `上次设计校验未通过：${lastIssues.join('；')}。请修正JSON中的design及必需的HTML标记，核对验收关联索引与页面/交互标记。${candidateHtml
        ? lastIssues.some(issue => issue.startsWith('HTML 未呈现'))
          ? `已有候选HTML缺少页面或交互标记，本次必须同时输出完整html，在对应真实控件或语义容器上补齐缺少的data-page-id/data-interaction-id；不得省略html或只改design。`
          : `已有完整安全候选HTML（sha256=${hash(candidateHtml)}），本次只输出action与design，不要重发html，宿主将原样复用已保存视图。若设计必须新增HTML中不存在的控件标记，才输出完整html。`
        : '没有可复用的安全HTML，必须同时输出完整html。'}原任务：\n${prompt}`
      : `${UX_SKETCH_RETRY_FEEDBACK}\n原任务：\n${prompt}` },
    signal: options.signal,
    timeoutMs: UX_SKETCH_TIMEOUT_MS,
    onAttemptFailure: failure => {
      const kind = failure.termination ?? failure.kind
      generation.failures.push({ attempt: failure.attempt, kind })
      diagnostic({ event: 'attempt_failed', attempt: failure.attempt, failure_kind: kind })
    },
    parse: raw => {
      parseAttempt++
      lastIssues = []
      let freshCandidate: string | undefined
      const parsed = parseUxOutput(raw, options.backplane, issues => { lastIssues = issues }, candidateHtml,
        html => { candidateHtml = html; freshCandidate = html })
      diagnostic({ event: 'output_checked', attempt: parseAttempt - 1, raw_output: raw.slice(0, 65536),
        raw_output_truncated: raw.length > 65536, output_sha256: hash(raw), validation_issues: lastIssues,
        accepted_for_preview: Boolean(parsed && !parsed.requires_prd_revision), requested_prd_revision: Boolean(parsed?.requires_prd_revision),
        reused_candidate: Boolean(parsed && !parsed.requires_prd_revision && !freshCandidate && candidateHtml) }, freshCandidate)
      return parsed
    },
  })
  if (options.signal?.aborted) {
    diagnostic({ event: 'generation_finished', source: 'aborted', failures: generation.failures })
    throw new Error('UX_SKETCH_ABORTED')
  }
  if (llm) {
    diagnostic({ event: 'generation_finished', source: 'llm', requested_prd_revision: Boolean(llm.requires_prd_revision) })
    return { ...llm, generation }
  }
  generation.source = structured ? 'failed' : 'template'
  diagnostic({ event: 'generation_finished', source: structured ? options.feedback ? 'previous_version_retained' : 'failed' : 'template', failures: generation.failures,
    validation_issues: lastIssues })
  if (structured) throw new Error(`UX_DESIGN_FAILED: ${options.feedback ? '未能可靠完成调整，保留上一版和用户意见' : '未生成可确认的完整界面设计'}；${lastIssues.slice(0, 4).join('；') || generation.failures.map(row => row.kind).join('、')}`)
  const project = findProject(options.project_id)
  return {
    html: buildTemplateSketch(project?.name ?? '未命名项目', options.positioning, options.requirements),
    source: 'template',
    generation,
  }
}

function parseUxOutput(raw: string, backplane: PrdBackplane | undefined, onIssues: (issues: string[]) => void,
  candidateHtml?: string, onCandidate?: (html: string) => void): UxSketchResult | undefined {
  if (!backplane) return parseSketchHtml(raw)
  let value: Record<string, unknown>
  const json = raw.replace(/^```(?:json)?\s*\n?|\n?```$/g, '').trim()
  try { value = JSON.parse(json) } catch {
    // The protocol writes HTML before metadata. Preserve only a complete JSON
    // string value; never invent missing bytes or accept an incomplete design.
    const prefix = /^\{\s*"action"\s*:\s*"design"\s*,\s*"html"\s*:\s*("(?:[^"\\]|\\.)*")\s*[,}]/s.exec(json)
    if (prefix) {
      try {
        const html = parseSketchHtml(JSON.parse(prefix[1]))
        if (html) onCandidate?.(html.html)
      } catch { /* Incomplete or invalid string values cannot be reused. */ }
    }
    onIssues(['设计输出不是合法 JSON，可能在设计记录处被截断'])
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) { onIssues(['设计输出须为对象']); return undefined }
  if (value.action === 'revise_requirements' && typeof value.reason === 'string' && value.reason.trim()) return { html: '', source: 'llm', requires_prd_revision: value.reason }
  if (value.action !== 'design') { onIssues(['缺少 design 动作']); return undefined }
  const sourceHtml = value.html === undefined ? candidateHtml : value.html
  if (typeof sourceHtml !== 'string') { onIssues(['缺少 HTML 视图且没有可复用候选']); return undefined }
  const html = parseSketchHtml(sourceHtml)
  if (!html) { onIssues(['HTML 为空、不完整或含可执行脚本']); return undefined }
  if (value.html !== undefined) onCandidate?.(html.html)
  const design = parseUxDesign(value.design, backplane, onIssues)
  if (!design) return undefined
  const mappedHtml = html.html.replace(/<!--[\s\S]*?-->|<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
  const missingMarkers: string[] = []
  for (const page of design.pages) if (!new RegExp(`<[^<>]+\\bdata-page-id\\s*=\\s*["']${page.id}["'][^<>]*>`).test(mappedHtml)) missingMarkers.push(`HTML 未呈现页面 ${page.id}`)
  for (const item of design.interactions) if (!new RegExp(`<[^<>]+\\bdata-interaction-id\\s*=\\s*["']${item.id}["'][^<>]*>`).test(mappedHtml)) missingMarkers.push(`HTML 未呈现交互 ${item.id}`)
  if (missingMarkers.length) { onIssues(missingMarkers); return undefined }
  return { ...html, design }
}

/** 草图落盘 + 铸 bloma-file:// 预览 URL（2026-10-05 方案 A：不再起沙箱服务器——
 *  子进程/端口/探活/node 解析四个故障域整个移除，URL 即文件）；落盘/铸造失败抛错（调用方如实降级）。 */
export async function stageUxSketch(options: {
  project_id: string
  html: string
  design?: UxDesign
  signal?: AbortSignal
}): Promise<{ preview_url: string; review_url?: string; sketch_path: string; html_hash: string }> {
  if (options.signal?.aborted) throw new Error('UX_SKETCH_ABORTED')
  const project = findProject(options.project_id)
  if (!project?.root_path) throw new Error('UX_SKETCH_PROJECT_MISSING: 项目根目录缺失，无法存放草图')
  const dir = join(project.root_path, UX_SKETCH_DIR)
  mkdirSync(dir, { recursive: true })
  const sketchPath = join(dir, UX_SKETCH_FILENAME)
  const historyDir = join(dir, 'history')
  mkdirSync(historyDir, { recursive: true })
  let lastVersion = readdirSync(historyDir).reduce((max, name) => Math.max(max, Number(/^version-(\d+)\.html$/.exec(name)?.[1] ?? 0)), 0)
  if (lastVersion === 0 && existsSync(sketchPath)) {
    writeFileSync(join(historyDir, 'version-0001.html'), readFileSync(sketchPath), { flag: 'wx' })
    lastVersion = 1
  }
  const html = injectSketchCorrector(options.html)
  writeFileSync(join(historyDir, `version-${String(lastVersion + 1).padStart(4, '0')}.html`), html, { encoding: 'utf8', flag: 'wx' })
  // 点选层注入（批11 ①，2026-10-08）：草图落盘时内联注入——右栏渲染即获得点选标记
  //（元素级语义，无需纠错实例；平台注入的确定性脚本，非 LLM 产出，不违草图禁脚本纪律）。
  writeFileSync(sketchPath, html, 'utf8')
  if (options.design) {
    writeTextFileAtomic(join(dir, 'ux-design.json'), JSON.stringify(options.design, null, 2))
    writeFileSync(join(historyDir, `version-${String(lastVersion + 1).padStart(4, '0')}.json`), JSON.stringify(options.design, null, 2), { flag: 'wx' })
    const review = renderUxStateReview(options.design)
    writeTextFileAtomic(join(dir, 'ux-state-review.html'), review)
    writeFileSync(join(historyDir, `version-${String(lastVersion + 1).padStart(4, '0')}.states.html`), review, { flag: 'wx' })
  }
  const previewUrl = mintProjectPreviewUrl(options.project_id, `${UX_SKETCH_DIR}/${UX_SKETCH_FILENAME}`)
  return { preview_url: previewUrl, ...(options.design ? { review_url: mintProjectPreviewUrl(options.project_id, `${UX_SKETCH_DIR}/ux-state-review.html`) } : {}),
    sketch_path: sketchPath, html_hash: createHash('sha256').update(html).digest('hex') }
}

/** Preserve the exact layout the user confirmed for downstream implementation. */
export function freezeConfirmedUxSketch(projectId: string, expected?: { prd: PrdBackplane; design: UxDesign; html_hash: string }): void {
  const root = findProject(projectId)?.root_path
  if (!root) throw new Error('UX_SKETCH_PROJECT_MISSING')
  const path = join(root, UX_SKETCH_DIR, UX_SKETCH_FILENAME)
  if (!existsSync(path)) throw new Error('UX_SKETCH_MISSING')
  const html = readFileSync(path, 'utf8'), htmlHash = createHash('sha256').update(html).digest('hex')
  if (expected && (htmlHash !== expected.html_hash || expected.design.prd_fingerprint !== prdScopeFingerprint(expected.prd))) throw new Error('UX_SKETCH_VERSION_CHANGED')
  writeTextFileAtomic(join(root, UX_SKETCH_DIR, 'confirmed.html'), html)
  if (expected) writeTextFileAtomic(join(root, UX_SKETCH_DIR, 'confirmed.json'), JSON.stringify({ version: 1, html_hash: htmlHash, design: expected.design }, null, 2))
}

export function readUxSketchVersion(projectId: string): { html: string; html_hash: string } | undefined {
  const root = findProject(projectId).root_path, path = join(root, UX_SKETCH_DIR, UX_SKETCH_FILENAME)
  if (!existsSync(path)) return undefined
  const html = readFileSync(path, 'utf8')
  return { html, html_hash: createHash('sha256').update(html).digest('hex') }
}
