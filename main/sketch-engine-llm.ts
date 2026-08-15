import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SDKQuery } from './orchestrator'
import { findProject } from './project-service'
import type { SketchRequirement } from './sketch-engine'
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

const DEFAULT_TIMEOUT_MS = 90_000

/** 渠道未配置 max_tokens 时的默认值：重 CSS 视觉稿 4000 必截断（线上已踩坑），与 mvp-engine-llm 同值。 */
const DEFAULT_MAX_TOKENS = 8192
const MAX_MAX_TOKENS = 16384
const MAX_GENERATION_ATTEMPTS = 2

const SYSTEM_PROMPT = `你是「Bloma 草图生成器」，负责把用户的想法生成一个**无交互的纯外观 HTML 草图**，用来让用户确认"软件长什么样"。只输出一个完整的 HTML 文档，不要任何解释文字，不要 markdown 代码块围栏。

硬性约束：
- 输出必须是一个自包含的 HTML 文档（含 <!doctype html>、<head>、内联 <style>、<body>）。
- **纯外观、零交互**：严禁出现 <script> 标签、任何 onclick/oninput 等内联事件、任何 JavaScript 逻辑。所有"按钮/输入框/列表"都只是视觉占位，点了没有任何反应，只要看起来像真实产品即可。
- 像一个真实产品的界面，而不是需求清单列表：要有应用外壳（顶部导航/标题栏）、主视觉区、以及按功能项组织的界面区块（表单、列表、统计卡、卡片等，按功能项语义选择合适形态）。
- 严格按照用户的功能项实现对应的界面区块，不要擅自替换成其他应用（用户要记账就做记账界面，不是计算器/待办）。
- 纯内联 CSS，不引用任何外部字体/图片/CDN 资源。
- 视觉上干净现代，浅色主题，圆角卡片，克制的紫色系点缀。
- 只输出 HTML，其余一律不要。`

export async function generateSketchLlm(input: GenerateSketchLlmInput): Promise<GenerateSketchLlmResult> {
  const selfController = new AbortController()
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => selfController.abort(), timeoutMs)
  const combinedSignal = combineSignals(selfController.signal, undefined)

  try {
    const prompt = buildPrompt(input.requirements)
    let maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS
    let truncated = false

    // 首试 + 一次恢复重试：截断（文档未闭合）→ 加大 maxTokens 重新生成，绝不内容级修补；
    // 重试耗尽抛错，由调用方回退确定性模板，不阻断草图产出。
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
      let accumulated = ''
      try {
        const stream = input.query(prompt, {
          env: input.env,
          signal: combinedSignal,
          sessionId: input.sessionId,
          history: [{ role: 'system', content: SYSTEM_PROMPT }],
          maxTokens,
        })
        for await (const sdkMessage of stream) {
          if (sdkMessage.type !== 'assistant' || !sdkMessage.message) continue
          const text = extractText(sdkMessage.message.content)
          if (text) accumulated += text
        }
      } catch (error) {
        if (selfController.signal.aborted) throw new Error('SKETCH_LLM_TIMEOUT: 草图生成超时，已取消本次生成')
        throw error
      }

      if (selfController.signal.aborted) throw new Error('SKETCH_LLM_TIMEOUT: 草图生成超时，已取消本次生成')

      const html = cleanSketchHtml(accumulated)
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

      truncated = looksTruncated(html)
      if (truncated) maxTokens = Math.min(maxTokens * 2, MAX_MAX_TOKENS)
    }

    // 重试耗尽：按最后一种失败原因抛清晰错误，便于上层回退模板与用户定位。
    if (truncated) {
      throw new Error('SKETCH_LLM_TRUNCATED: 草图输出被截断（疑似 max_tokens 不足），已尝试加大 token 重试仍失败')
    }
    throw new Error('SKETCH_LLM_PARSE_FAILED: 模型输出不是有效的 HTML 草图')
  } finally {
    clearTimeout(timer)
  }
}

function buildPrompt(requirements: SketchRequirement[]): string {
  const items = requirements.length
    ? requirements
    : [{ id: 'F-001', description: '一个软件' }]
  const list = items.map((r) => `- ${r.id}: ${r.description}`).join('\n')
  return [
    `请根据以下功能项生成无交互的纯外观 HTML 草图。`,
    ``,
    `功能项：`,
    list,
    ``,
    `要求：界面区块与功能项一一对应，视觉上像一个真实产品（不是需求清单）。`,
  ].join('\n')
}

/** 组合自建超时 signal（草图阶段无外部 signal，直接返回 self）。 */
function combineSignals(self: AbortSignal, _external?: AbortSignal): AbortSignal {
  return self
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
