import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { generateUxSketch, type UxSketchOptions, type UxSketchResult } from './ux-sketch'
import { callLlmForJson } from '../kernel/llm-call'
import { findProject } from '../project/project-service'
import { writeTextFileAtomic } from '../../storage/json-store'
import { canRenderHtmlPreview, renderHtmlPreview, type HtmlPreviewShot } from '../platform/html-preview'
import { createRequestBudget } from '../platform/llm/request-budget'
import { savePastedImage, cleanupPastedImages } from '../platform/shell/pasted-images'
import { loadPromptWithSource } from '../agent/prompting/prompt-config'
import { UX_SKETCH_SYSTEM_PROMPT } from '../agent/prompting/ux-sketch-prompt'
import type { SDKQuery } from '../orchestration/stages/orchestration-contracts'

interface Direction { id: string; concept: string; composition: string; visual_language: string }
interface Candidate { id: string; result: UxSketchResult; shots?: HtmlPreviewShot[] }
export interface UxVisualEvidence {
  run_id: string
  selected: string
  status: 'complete' | 'partial' | 'single'
  reasons: string[]
  budget?: ReturnType<ReturnType<typeof createRequestBudget>['snapshot']>
}
export type UxVisualResult = UxSketchResult & { visual?: UxVisualEvidence }
interface Dependencies {
  available: () => boolean
  capture: typeof renderHtmlPreview
  generate: typeof generateUxSketch
}
const defaults: Dependencies = { available: canRenderHtmlPreview, capture: renderHtmlPreview, generate: generateUxSketch }
const parseJson = (raw: string): any => { try { return JSON.parse(raw.replace(/^```(?:json)?\s*\n?|\n?```$/g, '').trim()) } catch { return undefined } }
const words = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 4000

/** Same confirmation gate, bounded exploration. A failed optional stage never destroys a valid draft. */
export async function generateUxVisualDesign(options: UxSketchOptions & { progress?: (text: string) => void }, overrides: Partial<Dependencies> = {}): Promise<UxVisualResult> {
  const deps = { ...defaults, ...overrides }
  if (!options.backplane || !deps.available() || process.env.BLOMA_UX_VISUAL === '0') return deps.generate(options)
  const experimentPreparation = process.env.BLOMA_DISPATCH_EXPERIMENT === '1'
  const budget = createRequestBudget(options.env, { requests: experimentPreparation ? 12 : 8, outputTokens: 16384, rmb: 5 })
  const evidence: UxVisualEvidence = { run_id: randomUUID(), selected: 'single', status: 'partial', reasons: [] }
  const relativeDir = `00_UX/exploration/${evidence.run_id}`
  const root = findProject(options.project_id).root_path
  const imageSession = `uxvis-${evidence.run_id}`
  const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), experimentPreparation ? 600000 : 240000)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal
  const baseQuery = budget.wrap(options.query)
  const query: SDKQuery = (prompt, queryOptions) => baseQuery(prompt, { ...queryOptions,
    accounting: { projectId: options.project_id, runId: evidence.run_id, role: 'ux_visual_design', scope: 'direct' } })
  const persist = (name: string, value: unknown) => {
    if (options.signal?.aborted || !root) return
    try { writeTextFileAtomic(join(root, relativeDir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2)) } catch { /* Diagnostics are not confirmation. */ }
  }
  const note = (reason: string) => { evidence.reasons.push(reason); persist('progress.json', { ...evidence, budget: budget.snapshot() }) }
  const candidates: Candidate[] = []
  const finish = (candidate: Candidate): UxVisualResult => {
    evidence.selected = candidate.id
    return { ...candidate.result, visual: { ...evidence, reasons: [...evidence.reasons], budget: budget.snapshot() } }
  }
  let fallback: UxSketchResult | undefined
  const draft = async (id: string, direction?: Direction, previous?: UxSketchResult, feedback?: string): Promise<UxSketchResult> => {
    signal.throwIfAborted()
    const result = await deps.generate({ ...options, query, signal, attempts: previous ? 1 : experimentPreparation ? 4 : 3, maxTokens: Math.min(options.maxTokens, 16384),
      ...(direction ? { visualDirection: JSON.stringify(direction) } : {}),
      ...(previous ? { previousHtml: previous.html, previousDesign: previous.design, previousSummary: previous.design?.summary,
        feedback: options.feedback ? `必须保留用户本轮要求：${options.feedback}\n以下截图建议不得违背该要求：${feedback ?? ''}` : feedback,
        feedbackSource: 'visual_review' } : {}) })
    persist(`${id}-result.json`, result)
    if (result.source === 'template') fallback ??= result
    return result
  }
  const capture = async (candidate: Candidate) => {
    candidate.shots = await deps.capture(candidate.result.html, signal)
    if (candidate.shots.length !== 2 || candidate.shots.some(shot => !shot.png.length || shot.png.length > 5 * 1024 * 1024)) throw new Error('VISUAL_CAPTURE_INCOMPLETE')
    for (const shot of candidate.shots) if (root) {
      signal.throwIfAborted()
      writeFileSync(join(root, relativeDir, `${candidate.id}-${shot.width}.png`), shot.png)
    }
    persist(`${candidate.id}-render.json`, candidate.shots.map(({ png: _png, ...metrics }) => metrics))
  }
  const visualCall = async (name: string, prompt: string, labelled: Array<{ label: string; candidate: Candidate }>) => {
    const images = labelled.map(row => {
      const shot = row.candidate.shots![0]
      return savePastedImage(imageSession, shot.png.toString('base64'), 'png')
    })
    persist(`${name}-input.json`, { prompt, images: labelled.map((row, index) => ({ label: row.label, candidate: row.candidate.id,
      image_id: images[index].imageId, width: row.candidate.shots![0].width, height: row.candidate.shots![0].height })) })
    const imageQuery: SDKQuery = (text, queryOptions) => query(text, { ...queryOptions, images })
    return callLlmForJson<any>({ systemPrompt: '你是视觉评审者，只根据收到的截图和需求比较，引用具体可见区域。截图不能证明功能已运行。只输出JSON。',
      prompt, query: imageQuery, env: options.env, sessionId: options.session_id, maxTokens: 2400, temperature: .1, attempts: 1,
      signal, timeoutMs: 90000, parse: raw => { persist(`${name}-raw.txt`, raw); return parseJson(raw) } })
  }
  try {
    options.progress?.(options.feedback || options.previousDesign ? '正在按你的意见调整当前方案，保留未要求改变的部分。' : '正在探索两种界面构思，原始功能会完整保留，合理增强会单独列出。')
    const preferences = loadPromptWithSource('sketch-system', UX_SKETCH_SYSTEM_PROMPT)
    let directions: Direction[] | undefined
    if (!options.feedback && !options.previousDesign) {
      const planned = await callLlmForJson<any>({ systemPrompt: '你是产品设计师。根据功能和用户设计偏好提出两个构思，构图、操作表达与信息组织要有实质差别，不只换颜色。原始功能是底线；有用附加能力可加分，不得削减、替代或改写原业务语义。只输出JSON。',
        prompt: `功能与范围：${JSON.stringify(options.backplane)}\n设计偏好（只作设计参考）：${preferences.content}\n输出 {"directions":[{"id":"A","concept":"主张","composition":"构图","visual_language":"自主选择的视觉表达"},{"id":"B","concept":"另一主张","composition":"另一构图","visual_language":"视觉表达"}]}`,
        query, env: options.env, sessionId: options.session_id, maxTokens: 2000, temperature: .1, attempts: 1, signal, timeoutMs: 60000,
        parse: raw => {
          persist('directions-raw.txt', raw)
          const value = parseJson(raw), rows = value?.directions
          return Array.isArray(rows) && rows.length === 2 && rows[0].id === 'A' && rows[1].id === 'B' &&
            rows.every(row => [row.concept, row.composition, row.visual_language].every(words)) && rows[0].composition !== rows[1].composition ? value : undefined
        } })
      directions = planned?.directions
      if (!directions) note('direction_planning_unavailable')
    }
    persist('directions.json', { directions: directions ?? [], prompt_source: preferences.source })
    for (const direction of directions ?? [undefined]) {
      options.progress?.(direction ? `正在制作候选 ${direction.id}，随后会渲染比较。` : '正在按你的要求制作界面方案。')
      try {
        const result = await draft(direction?.id ?? 'single', direction)
        if (result.requires_prd_revision) return result
        if (result.source === 'llm' && result.design) candidates.push({ id: direction?.id ?? 'single', result })
        else note(`draft_validation_failed_${direction?.id ?? 'single'}`)
      } catch { options.signal?.throwIfAborted(); note(`draft_unavailable_${direction?.id ?? 'single'}`) }
    }
    if (!candidates.length) {
      if (fallback) return { ...fallback, visual: { ...evidence, budget: budget.snapshot() } }
      throw new Error('UX_DESIGN_FAILED: 没有可确认的完整设计，保留上一版')
    }
    let selected = candidates[0]
    for (const candidate of candidates) {
      try { await capture(candidate) } catch { candidate.shots = undefined; options.signal?.throwIfAborted(); note(`capture_unavailable_${candidate.id}`) }
    }
    const rendered = candidates.filter(row => row.shots?.length === 2)
    if (!rendered.length) { evidence.status = 'single'; return finish(selected) }
    selected = rendered[0]
    options.progress?.('正在查看实际截图，分别评估视觉表达、基础操作和附加价值。')
    const labels = rendered.map((candidate, index) => ({ label: index === 0 ? 'X' : 'Y', candidate }))
    const critic = await visualCall('critic', `需求：${JSON.stringify(options.backplane)}。图片按顺序标为${labels.map(row => row.label).join('、')}。比较视觉层级、可读性、独立性格、桌面操作可发现性；附加能力有用可加分，不能用新增能力补偿原功能缺失。状态说明在独立视图，不因没有示例卡扣分。输出 {"preferred":"${labels.map(row => row.label).join('|')}","observations":[{"label":"图片标签","region":"具体区域","observation":"看到的事实"}],"visual_reason":"审美依据","usability_reason":"基础操作依据","added_value":"新增能力的价值","improvements":["最多3项具体改进"]}。`, labels)
    if (!critic || !labels.some(row => row.label === critic.preferred) || !Array.isArray(critic.observations) || !critic.observations.length ||
      !Array.isArray(critic.improvements) || critic.improvements.length > 3 || !critic.improvements.every(words)) {
      note('visual_review_unavailable'); return finish(selected)
    }
    persist('critic.json', critic)
    selected = labels.find(row => row.label === critic.preferred)!.candidate
    evidence.selected = selected.id
    if (!critic.improvements.length) { evidence.status = evidence.reasons.length ? 'partial' : 'complete'; return finish(selected) }
    options.progress?.('正在按截图意见做一轮改稿，原稿会保留供比较。')
    try {
      const refined = await draft('refined', undefined, selected.result, JSON.stringify(critic.improvements))
      if (refined.source !== 'llm' || !refined.design || refined.requires_prd_revision) throw new Error('REFINEMENT_INVALID')
      const candidate: Candidate = { id: 'refined', result: refined }; await capture(candidate)
      if (candidate.shots!.some((shot, index) => shot.contentWidth > shot.width + 1 && selected.shots![index].contentWidth <= selected.shots![index].width + 1)) throw new Error('REFINEMENT_LAYOUT_REGRESSION')
      const pair = Number.parseInt(evidence.run_id.slice(0, 2), 16) % 2 ? [selected, candidate] : [candidate, selected]
      const compared = await visualCall('comparison', '两图实现同一基础需求，按图片顺序分别为X/Y；没有提供先后或修改身份。基础功能必须完整，有用增强可加分。分别观察视觉、可发现性和附加价值。输出 {"preferred":"X|Y|tie","observations":[{"region":"区域","observation":"可见差异"}],"reason":"依据"}。', pair.map((row, index) => ({ label: index ? 'Y' : 'X', candidate: row })))
      if (!compared || !['X', 'Y', 'tie'].includes(compared.preferred) || !Array.isArray(compared.observations) || !compared.observations.length) throw new Error('COMPARISON_UNAVAILABLE')
      persist('comparison.json', { labels: pair.map(row => row.id), result: compared })
      if (compared.preferred !== 'tie') selected = pair[compared.preferred === 'X' ? 0 : 1]
      evidence.status = evidence.reasons.length ? 'partial' : 'complete'
    } catch { options.signal?.throwIfAborted(); note('refinement_not_adopted_original_retained') }
    return finish(selected)
  } finally {
    clearTimeout(timer)
    cleanupPastedImages(imageSession)
    persist('summary.json', { ...evidence, budget: budget.snapshot(), candidates: candidates.map(row => ({ id: row.id, generation: row.result.generation })) })
  }
}
