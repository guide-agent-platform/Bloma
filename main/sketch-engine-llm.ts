import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SDKQuery } from './orchestrator'
import { findProject } from './project-service'
import type { SketchRequirement } from './sketch-engine'
import { requirementAssertions, requirementStory } from './sketch-engine'
import { categoryTemperature } from './model-resolution'
import type { MessageContentBlock } from '../shared/types'

/**
 * SketchEngineLlm — 草图也走 LLM：从需求清单生成「无交互纯外观」的单文件 HTML。
 *
 * 与 MVP（mvp-engine-llm）同一套流式查询/超时/取消语义，但产物定位不同：
 * - 草图只产出 `index.html`（内联 CSS 的静态视觉稿），不产出 package.json /
 *   static-server.js / src/*.js——草图阶段的目标是「看起来像什么」，不是「能不能跑」；
 * - 强约束「无交互」：模型被要求不写任何 `<script>`/事件绑定，后处理再兜底剥离
 *   残留的 `<script>` 块、内联 `on*=` 事件与内联 meta CSP，保证预览只看不动；
 * - 失败抛错向上传播，由调用方（runSketchTask）回退确定性模板，避免澄清流程卡死。
 */

export interface GenerateSketchLlmInput {
  project_id: string
  requirements: SketchRequirement[]
  /** 用户已声明约束（T4-L1：project.constraints，随草图生成注入——「不含登录」则草图不画登录界面） */
  constraints?: string[]
  query: SDKQuery
  env: Record<string, string>
  sessionId: string
  maxTokens?: number
  timeoutMs?: number
}

export interface GenerateSketchLlmResult {
  files: { path: string; content: string }[]
  run_command: string
  summary: string
}

/** 单次尝试的留痕：只进日志与 sketch_fallback 埋点，用于事后区分「慢」还是「截断重试被掐」。 */
export interface SketchAttemptDetail {
  attempt: number
  elapsed_ms: number
  chars: number
  truncated: boolean
}

/** 草图 LLM 失败错误：携带逐次尝试明细，resolveSketch 取出进埋点。 */
export class SketchLlmError extends Error {
  readonly attempts: SketchAttemptDetail[]

  constructor(message: string, attempts: SketchAttemptDetail[]) {
    super(message)
    this.name = 'SketchLlmError'
    this.attempts = attempts
  }
}

/**
 * 默认不设生成超时（2026-08-16 用户决策「取消时间限制」）：90s→120s 两轮调参后慢渠道
 * 仍会被掐死，改为无上限等待，由渲染端 WaitingFeedback 提示 + 停止按钮（T3/U4）手动中止。
 * `timeoutMs` 语义改为「>0 才设 timer」：默认 0 = 不限时，参数保留供测试注入短超时。
 */

/** 渠道未配置 max_tokens 时的默认值：线上草图实测 18691 字符已贴 8192 token 边缘，提到 16384 与 mvp-engine-llm 同值。 */
const DEFAULT_MAX_TOKENS = 16384
const MAX_MAX_TOKENS = 32768
const MAX_GENERATION_ATTEMPTS = 2

const SYSTEM_PROMPT = `你是「Bloma 草图生成器」，负责把用户的想法生成一个**无交互的纯外观 HTML 草图**，用来让用户确认"软件长什么样"。只输出一个完整的 HTML 文档，不要任何解释文字，不要 markdown 代码块围栏。

硬性约束：
- 输出必须是一个自包含的 HTML 文档（含 <!doctype html>、<head>、内联 <style>、<body>）。
- **纯外观、零交互**：严禁出现 <script> 标签、任何 onclick/oninput 等内联事件、任何 JavaScript 逻辑。所有"按钮/输入框/列表"都只是视觉占位，点了没有任何反应，只要看起来像真实产品即可。
- 像一个真实产品的界面，而不是需求清单列表：要有应用外壳（顶部导航/标题栏）、主视觉区、以及按功能项组织的界面区块（表单、列表、统计卡、卡片等，按功能项语义选择合适形态）。
- 严格按照用户的功能项实现对应的界面区块，不要擅自替换成其他应用（用户要记账就做记账界面，不是计算器/待办）。
- **视觉表达对齐行为断言**：功能项若带有行为断言（如「按右方向键→车辆 x 坐标增加」），界面必须把断言涉及的实体与状态画出来（如赛道上的赛车、方向键提示），让用户看草图就能预判行为；断言里的实体不要凭空换成别的。
- **为移植做准备**：class 命名语义化（如 .race-track、.car、.history-list，不用 .box1、.red-div），DOM 结构清晰分层——草图确认后会被移植进三文件 MVP，语义化结构让移植不丢视觉。
- 纯内联 CSS，不引用任何外部字体/图片/CDN 资源。
- 视觉上干净现代，浅色主题，圆角卡片，克制的紫色系点缀。
- 只输出 HTML，其余一律不要。`

export async function generateSketchLlm(input: GenerateSketchLlmInput): Promise<GenerateSketchLlmResult> {
  const timeoutMs = input.timeoutMs ?? 0
  const prompt = buildPrompt(input.requirements, input.constraints)
  let maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS
  let truncated = false
  const attempts: SketchAttemptDetail[] = []

  // 首试 + 一次恢复重试：截断（文档未闭合）→ 加大 maxTokens 重新生成，绝不内容级修补；
  // 重试耗尽抛错，由调用方回退确定性模板，不阻断草图产出。
  // 超时预算**按次发放**：每次尝试新建 timer——共享总预算会让截断重试只剩残余时间，结构性必超时。
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const selfController = new AbortController()
    const timer = timeoutMs > 0 ? setTimeout(() => selfController.abort(), timeoutMs) : undefined
    const startedAt = Date.now()
    let accumulated = ''

    const timeoutError = (truncatedFlag: boolean): SketchLlmError =>
      new SketchLlmError(
        `SKETCH_LLM_TIMEOUT: 草图生成超时（第 ${attempt + 1} 次尝试，预算 ${timeoutMs}ms），已取消本次生成`,
        [...attempts, { attempt: attempt + 1, elapsed_ms: Date.now() - startedAt, chars: accumulated.length, truncated: truncatedFlag }],
      )

    try {
      const stream = input.query(prompt, {
        env: input.env,
        signal: selfController.signal,
        sessionId: input.sessionId,
        history: [{ role: 'system', content: SYSTEM_PROMPT }],
        maxTokens,
        // §7.7 类别温度：视觉稳定（0.1）
        temperature: categoryTemperature('sketch'),
      })
      for await (const sdkMessage of stream) {
        if (sdkMessage.type !== 'assistant' || !sdkMessage.message) continue
        const text = extractText(sdkMessage.message.content)
        if (text) accumulated += text
      }
    } catch (error) {
      clearTimeout(timer)
      if (selfController.signal.aborted) throw timeoutError(false)
      throw error
    }
    clearTimeout(timer)
    if (selfController.signal.aborted) throw timeoutError(false)

    const html = cleanSketchHtml(accumulated)
    truncated = looksTruncated(html)
    attempts.push({ attempt: attempt + 1, elapsed_ms: Date.now() - startedAt, chars: accumulated.length, truncated })
    console.log(
      `[generateSketchLlm] attempt=${attempt + 1}/${MAX_GENERATION_ATTEMPTS} elapsed=${attempts[attempts.length - 1].elapsed_ms}ms chars=${accumulated.length} html=${isHtmlDocument(html)} truncated=${truncated}`,
    )

    if (isHtmlDocument(html)) {
      const project = findProject(input.project_id)
      const file = { path: 'index.html', content: html }
      const fullPath = join(project.root_path, file.path)
      mkdirSync(join(fullPath, '..'), { recursive: true })
      writeFileSync(fullPath, file.content, 'utf8')

      return {
        files: [file],
        run_command: 'node static-server',
        summary: '已按你的需求生成外观草图。',
      }
    }

    if (truncated) maxTokens = Math.min(maxTokens * 2, MAX_MAX_TOKENS)
  }

  // 重试耗尽：按最后一种失败原因抛清晰错误（附逐次明细），便于上层回退模板与用户定位。
  if (truncated) {
    throw new SketchLlmError('SKETCH_LLM_TRUNCATED: 草图输出被截断（疑似 max_tokens 不足），已尝试加大 token 重试仍失败', attempts)
  }
  throw new SketchLlmError('SKETCH_LLM_PARSE_FAILED: 模型输出不是有效的 HTML 草图', attempts)
}

function buildPrompt(requirements: SketchRequirement[], constraints?: string[]): string {
  const items = requirements.length
    ? requirements
    : [{ id: 'F-001', description: '一个软件' }]
  const list = items
    .map((item) => {
      const assertions = requirementAssertions(item)
      const assertionLines = assertions.length
        ? assertions.map((assertion) => `    - ${assertion}`).join('\n')
        : ''
      return [`- ${item.id}: ${requirementStory(item)}`, ...(assertionLines ? [assertionLines] : [])].join('\n')
    })
    .join('\n')
  const constraintSection =
    constraints && constraints.length
      ? [
          ``,
          `用户约束（历轮声明，必须遵守——约束说不做的界面元素一律不出现）：`,
          ...constraints.map((constraint) => `- ${constraint}`),
        ]
      : []
  return [
    `请根据以下功能项生成无交互的纯外观 HTML 草图。`,
    ``,
    `功能项（含行为断言——断言涉及的实体与状态必须在界面中可见）：`,
    list,
    ...constraintSection,
    ``,
    `要求：界面区块与功能项一一对应，视觉上像一个真实产品（不是需求清单）；class 语义化命名，方便后续移植。`,
  ].join('\n')
}

/**
 * 清洗模型输出的 HTML，兜底保证「无交互」：
 * - 剥离 markdown 代码块围栏；
 * - 剥离残留的 <script> 块、内联 on* 事件（onclick/oninput 等）；
 * - 剥离与平台 CSP 冲突的内联 meta CSP（平台静态服务器统一注入，双 CSP 会拦截脚本）。
 */
function cleanSketchHtml(raw: string): string {
  return raw
    .replace(/```(?:html)?/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/<meta[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '')
    .trim()
}

/** 判定输出是否是完整的 HTML 文档（含 <html 或 <body、内联 <style>，且以 </html> 闭合）。导出供恢复服务复用（T1 磁盘产物完整性校验）。 */
export function isHtmlDocument(html: string): boolean {
  return (
    /<style[\s>]/i.test(html) &&
    /<html[\s>]|<body[\s>]/i.test(html) &&
    /<\/html>\s*$/i.test(html)
  )
}

/**
 * 检测模型输出是否被截断（max_tokens 用尽导致文档未闭合）。只做结构判断，绝不修补内容——
 * 线上案例：11KB 视觉稿停在 CSS 中间（无 </html>），浏览器把残余内容全当 CSS 解析 → 整页空白。
 */
function looksTruncated(html: string): boolean {
  // 只有「已开始 HTML 文档（有内联 <style>）但未闭合」才算截断；
  // 纯文本/根本不是 HTML → 不重试，走 SKETCH_LLM_PARSE_FAILED 路径。
  if (!/<style[\s>]/i.test(html)) return false
  if (!/<\/html>\s*$/i.test(html)) return true
  return /(?:\.\.\.|…)\s*$|\/\*\s*(?:rest|more|remaining|todo|未完|略|其余)[\s*]*$/i.test(html)
}

function extractText(blocks: MessageContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}
