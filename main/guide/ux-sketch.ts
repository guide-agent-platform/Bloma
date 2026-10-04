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
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SDKQuery } from '../orchestration/orchestrator'
import { callLlmForJson } from '../kernel/llm-call'
import { categoryTemperature } from '../platform/llm/model-resolution'
import { loadPromptOverride } from '../agent/prompting/prompt-config'
import { findProject } from '../project/project-service'
import { mintProjectPreviewUrl } from '../delivery/preview-scheme'
import type { SketchRequirement } from '../coding/sketch-engine'

const UX_SKETCH_DIR = '00_UX'
const UX_SKETCH_FILENAME = 'ux-sketch.html'
/** 草图是门的辅助产物：超时走模板兜底，绝不让门挂死（与「LLM 生成无超时」拍板不冲突——那是给主生成链的） */
const UX_SKETCH_TIMEOUT_MS = 240_000
const UX_SKETCH_ATTEMPTS = 2

const UX_SKETCH_SYSTEM_PROMPT = `你是桌面软件的界面草图工程师。任务：根据需求清单画一张「外观草图」——低保真、纯外观、不可交互的静态 HTML 页面，供用户在开发前确认界面方向。

硬性规则：
1. 输出一个完整 HTML 文档（<!DOCTYPE html> 开头），单文件、内联 <style>、<meta charset="utf-8">、禁止任何 <script>。
2. 草图必须模拟 Windows 桌面应用窗口形态：顶部标题栏（左侧应用名、右侧最小化/最大化/关闭按钮示意），下方是主界面布局。
3. 低保真风格：灰阶为主 + 少量主题色点缀；用线框、占位块、示意文字表达布局，不追求视觉精细。
4. 每条需求在界面上要有对应区块/控件示意（按钮、输入区、列表等），关键交互用静态示意（如「点击后 → 结果区显示 ×××」的文字标注）。
5. 页脚固定一行：「外观草图 · 仅供确认方向，最终以实际桌面程序为准」。
6. 只输出 HTML 本身，不要任何解释文字，不要 Markdown 代码围栏。
修订模式（给了上一版要点与用户反馈时）：保留未提及的部分，只改用户指出的问题，仍输出完整 HTML 文档。`

const UX_SKETCH_RETRY_FEEDBACK = '上一次输出不是可用的 HTML 文档（可能带了解释文字或代码围栏）。请只输出完整 HTML 文档本身：<!DOCTYPE html> 开头，单文件内联样式，无脚本，无解释，无代码围栏。'

function getSystemPrompt(): string {
  return loadPromptOverride('ux-sketch.md') ?? UX_SKETCH_SYSTEM_PROMPT
}

export interface UxSketchResult {
  html: string
  /** llm=模型生成；template=确定性模板兜底（如实告知用户） */
  source: 'llm' | 'template'
}

/** 剥代码围栏（```html ... ```）并做最低形态校验（导出供单测直测解析契约）。 */
export function parseSketchHtml(text: string): UxSketchResult | undefined {
  let html = text.trim()
  const fence = html.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/)
  if (fence) html = fence[1].trim()
  const looksHtml = /^<!DOCTYPE html>/i.test(html) || /^<html[\s>]/i.test(html)
  if (!looksHtml || !html.includes('</html>')) return undefined
  return { html, source: 'llm' }
}

/** 需求条目 → 草图 prompt 用户轮内容。 */
function buildSketchPrompt(options: {
  positioning: string
  requirements: SketchRequirement[]
  previousSummary?: string
  feedback?: string
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
  if (options.previousSummary && options.feedback) {
    parts.push(
      `上一版草图的要点：\n${options.previousSummary}`,
      `用户对上一版的反馈（只改这些问题，其余保持）：${options.feedback}`,
    )
  }
  parts.push('请画出这个 Windows 桌面程序的外观草图（完整 HTML 文档，只输出 HTML 本身）。')
  return parts.join('\n\n')
}

/** 确定性模板兜底：窗口框 + 需求块列表（无 LLM 依赖，门不挂死）。 */
function buildTemplateSketch(projectName: string, positioning: string, requirements: SketchRequirement[]): string {
  const blocks = requirements
    .map((item) => {
      const priority = item.priority ? `<span class="pri">${item.priority}</span>` : ''
      const assertions = (item.behavior_assertions ?? []).slice(0, 3)
        .map((line) => `<li>${escapeHtml(line)}</li>`)
        .join('')
      return `<section class="req"><h3>${escapeHtml(item.id)} ${priority} ${escapeHtml(item.description)}</h3>${
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
  <div class="body">
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
  signal?: AbortSignal
}): Promise<UxSketchResult> {
  const prompt = buildSketchPrompt(options)
  const llm = await callLlmForJson<UxSketchResult>({
    systemPrompt: getSystemPrompt(),
    prompt,
    query: options.query,
    env: options.env,
    sessionId: options.session_id,
    maxTokens: options.maxTokens,
    temperature: categoryTemperature('prd'),
    attempts: UX_SKETCH_ATTEMPTS,
    retryFeedback: UX_SKETCH_RETRY_FEEDBACK,
    signal: options.signal,
    timeoutMs: UX_SKETCH_TIMEOUT_MS,
    parse: parseSketchHtml,
  })
  if (llm) return llm
  const project = findProject(options.project_id)
  return {
    html: buildTemplateSketch(project?.name ?? '未命名项目', options.positioning, options.requirements),
    source: 'template',
  }
}

/** 草图落盘 + 铸 bloma-file:// 预览 URL（2026-10-05 方案 A：不再起沙箱服务器——
 *  子进程/端口/探活/node 解析四个故障域整个移除，URL 即文件）；落盘/铸造失败抛错（调用方如实降级）。 */
export async function stageUxSketch(options: {
  project_id: string
  html: string
}): Promise<{ preview_url: string; sketch_path: string }> {
  const project = findProject(options.project_id)
  if (!project?.root_path) throw new Error('UX_SKETCH_PROJECT_MISSING: 项目根目录缺失，无法存放草图')
  const dir = join(project.root_path, UX_SKETCH_DIR)
  mkdirSync(dir, { recursive: true })
  const sketchPath = join(dir, UX_SKETCH_FILENAME)
  writeFileSync(sketchPath, options.html, 'utf8')
  const previewUrl = mintProjectPreviewUrl(options.project_id, `${UX_SKETCH_DIR}/${UX_SKETCH_FILENAME}`)
  return { preview_url: previewUrl, sketch_path: sketchPath }
}
