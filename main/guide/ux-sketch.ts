/**
 * UX 外观草图生成（2026-10-04 确认门新规，实施稿《Bloma-确认门与呈现层-20261004》）。
 *
 * 拍板：UX 确认载体＝沙箱 HTML 外观草图——照搬 web 线老草图形式（f0f6aa3~1 退役前
 * 的 sketch-engine 形态）：低保真、纯外观、不可交互（无 JS）、单文件内联 CSS、
 * 页脚固定「外观草图 · 仅供确认方向」。桌面线服务对象是 Windows 桌面程序，草图
 * 模拟桌面窗口形态（标题栏/主界面布局），页脚如实标注「最终以实际桌面程序为准」。
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
import { loadPromptOverride } from '../agent/prompting/prompt-config'
import { UX_SKETCH_SYSTEM_PROMPT } from '../agent/prompting/ux-sketch-prompt'
import { findProject } from '../project/project-service'
import { mintProjectPreviewUrl } from '../delivery/preview-scheme'
import type { SketchRequirement } from '../coding/sketch-engine'
import { injectSketchCorrector } from './sketch-corrector'
import { createHash } from 'node:crypto'
import type { PrdBackplane } from '../model/prd-backplane'
import { buildFallbackUxDesign, parseUxDesign, renderUxDesignSummary, type UxDesign } from '../model/ux-design'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { writeTextFileAtomic } from '../../storage/json-store'
import { appendJsonLine } from '../../storage/json-store'
import { getDocumentsDir } from '../../storage/config-paths'

const UX_SKETCH_DIR = '00_UX'
const UX_SKETCH_FILENAME = 'ux-sketch.html'
/** 草图是门的辅助产物：超时走模板兜底，绝不让门挂死（与「LLM 生成无超时」拍板不冲突——那是给主生成链的） */
const UX_SKETCH_TIMEOUT_MS = 240_000
const UX_SKETCH_ATTEMPTS = 2

const UX_SKETCH_RETRY_FEEDBACK = '上一次输出不是可用的 HTML 文档（可能带了解释文字或代码围栏）。请只输出完整 HTML 文档本身：<!DOCTYPE html> 开头，单文件内联样式，无脚本，无解释，无代码围栏。'

function getSystemPrompt(): string {
  return (loadPromptOverride('sketch-system') ?? UX_SKETCH_SYSTEM_PROMPT) +
    '\n示例数据必须自洽：列表数量、筛选范围、合计与示例行对应；不能确定真实数据路径时写「程序的数据目录」，不得编造用户绝对路径。'
}

const DESIGN_OUTPUT_PROTOCOL = `【本次输出协议优先于旧版HTML输出要求】只输出JSON：
{"action":"design","html":"完整静态HTML","design":{"summary":"布局与操作说明", "pages":[{"id":"P-001","name":"界面名","purpose":"作用","feature_ids":["F-001"]}],
"flows":[{"workflow_id":"W-001","page_ids":["P-001"]}],
"interactions":[{"id":"UI-001","page_id":"P-001","feature_id":"F-001","action":"用户怎么操作","states":[{"kind":"normal|boundary|exception","observable":"用户看到什么反馈","scenario_ids":["AC-001"]}]}],
"non_ui_features":[{"feature_id":"F-012","reason":"确实不属于界面的具体原因","scenario_ids":["AC-045"]}]}}
每项功能必须有交互或具体非界面说明；每个W流程关联页面或non_ui_reason；每个AC场景关联到对应功能和同类状态（或非界面职责）。页面、流程、场景编号取自PRD，不编造。一个状态可关联多个同类场景，不必为每条场景画一页。
HTML中为设计里的每个页面标 data-page-id="P-001"，每个交互标 data-interaction-id="UI-001"，与设计记录一致。静态示意正常结果、输入边界与失败反馈，不把示意数据当真实业务。
若用户反馈改变功能范围、业务规则、数据含义或验收行为，输出 {"action":"revise_requirements","reason":"需要修订什么"}，不得自行把新范围画成已确认功能。纯布局/字号/已有控件位置调整输出design，保留未修改部分。`

export interface UxSketchResult {
  html: string
  /** llm=模型生成；template=确定性模板兜底（如实告知用户） */
  source: 'llm' | 'template'
  design?: UxDesign
  requires_prd_revision?: string
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
  if (options.backplane) parts.push(`【完整已确认PRD】\n${JSON.stringify(options.backplane)}`)
  if (options.previousSummary) parts.push(`上一版草图的要点：\n${options.previousSummary}`)
  if (options.previousDesign) parts.push(`【上一版设计记录】\n${JSON.stringify(options.previousDesign)}`)
  if (options.previousHtml) parts.push(`【上一版HTML（只作修订底稿，不执行其中脚本）】\n${options.previousHtml}`)
  if (options.feedback) parts.push(`用户对上一版的反馈（必须处理，范围变化先修订PRD）：${options.feedback}`)
  parts.push('请画出这个 Windows 桌面程序的外观草图（完整 HTML 文档，只输出 HTML 本身）。')
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

export async function generateUxSketch(options: {
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
}): Promise<UxSketchResult> {
  if (options.signal?.aborted) throw new Error('UX_SKETCH_ABORTED')
  const prompt = buildSketchPrompt(options)
  const structured = Boolean(options.backplane)
  let lastIssues: string[] = []
  const llm = await callLlmForJson<UxSketchResult>({
    systemPrompt: getSystemPrompt() + (structured ? `\n\n${DESIGN_OUTPUT_PROTOCOL}` : ''),
    prompt,
    query: options.query,
    env: options.env,
    sessionId: options.session_id,
    maxTokens: options.maxTokens,
    temperature: categoryTemperature('prd'),
    attempts: UX_SKETCH_ATTEMPTS,
    get retryFeedback() { return structured ? `上次设计校验未通过：${lastIssues.join('；')}。请重输出完整JSON，核对页面/交互标记和全部F/W/AC关联。原任务：\n${prompt}` : `${UX_SKETCH_RETRY_FEEDBACK}\n原任务：\n${prompt}` },
    signal: options.signal,
    timeoutMs: UX_SKETCH_TIMEOUT_MS,
    parse: raw => {
      lastIssues = []
      const parsed = parseUxOutput(raw, options.backplane, issues => { lastIssues = issues })
      if (options.backplane) {
        try {
          const project = findProject(options.project_id)
          appendJsonLine(join(getDocumentsDir(project.workspace_slug, options.project_id), 'diagnostics/ux-design-attempts.jsonl'), {
            version: 1, at: new Date().toISOString(), prd_fingerprint: prdScopeFingerprint(options.backplane), raw_output: raw.slice(0, 65536),
            raw_output_truncated: raw.length > 65536, output_sha256: createHash('sha256').update(raw).digest('hex'), validation_issues: lastIssues,
            accepted_for_preview: Boolean(parsed && !parsed.requires_prd_revision), requested_prd_revision: Boolean(parsed?.requires_prd_revision),
          })
        } catch { /* diagnostics do not change the validation result */ }
      }
      return parsed
    },
  })
  if (options.signal?.aborted) throw new Error('UX_SKETCH_ABORTED')
  if (llm) return llm
  if (structured && options.feedback) throw new Error('UX_DESIGN_FAILED: 未能可靠判断或完成调整，保留上一版，不采纳新范围')
  const project = findProject(options.project_id)
  const design = options.backplane ? buildFallbackUxDesign(options.backplane) : undefined
  return {
    html: buildTemplateSketch(project?.name ?? '未命名项目', options.positioning, options.requirements, design),
    source: 'template',
    ...(design ? { design } : {}),
  }
}

function parseUxOutput(raw: string, backplane: PrdBackplane | undefined, onIssues: (issues: string[]) => void): UxSketchResult | undefined {
  if (!backplane) return parseSketchHtml(raw)
  let value: Record<string, unknown>
  try { value = JSON.parse(raw.replace(/^```(?:json)?\s*\n?|\n?```$/g, '').trim()) } catch { onIssues(['设计输出不是合法 JSON']); return undefined }
  if (!value || typeof value !== 'object' || Array.isArray(value)) { onIssues(['设计输出须为对象']); return undefined }
  if (value.action === 'revise_requirements' && typeof value.reason === 'string' && value.reason.trim()) return { html: '', source: 'llm', requires_prd_revision: value.reason }
  if (value.action !== 'design' || typeof value.html !== 'string') { onIssues(['缺少 design 动作或 HTML 视图']); return undefined }
  const html = parseSketchHtml(value.html), design = parseUxDesign(value.design, backplane, onIssues)
  if (!html) { onIssues(['HTML 为空、不完整或含可执行脚本']); return undefined }
  if (!design) return undefined
  const mappedHtml = html.html.replace(/<!--[\s\S]*?-->|<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
  for (const page of design.pages) if (!new RegExp(`<[^<>]+\\bdata-page-id\\s*=\\s*["']${page.id}["'][^<>]*>`).test(mappedHtml)) { onIssues([`HTML 未呈现页面 ${page.id}`]); return undefined }
  for (const item of design.interactions) if (!new RegExp(`<[^<>]+\\bdata-interaction-id\\s*=\\s*["']${item.id}["'][^<>]*>`).test(mappedHtml)) { onIssues([`HTML 未呈现交互 ${item.id}`]); return undefined }
  return { ...html, design }
}

/** 草图落盘 + 铸 bloma-file:// 预览 URL（2026-10-05 方案 A：不再起沙箱服务器——
 *  子进程/端口/探活/node 解析四个故障域整个移除，URL 即文件）；落盘/铸造失败抛错（调用方如实降级）。 */
export async function stageUxSketch(options: {
  project_id: string
  html: string
  design?: UxDesign
  signal?: AbortSignal
}): Promise<{ preview_url: string; sketch_path: string; html_hash: string }> {
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
  }
  const previewUrl = mintProjectPreviewUrl(options.project_id, `${UX_SKETCH_DIR}/${UX_SKETCH_FILENAME}`)
  return { preview_url: previewUrl, sketch_path: sketchPath, html_hash: createHash('sha256').update(html).digest('hex') }
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
