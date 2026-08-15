import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConversationTurn, SDKQuery } from './orchestrator'
import { findProject } from './project-service'
import type { PrdBackplane } from './sketch-engine'
import { renderPackageJson, renderStaticServer, type GeneratedMvpFile } from './mvp-engine'
import type { MessageContentBlock } from '../shared/types'

/**
 * MvpEngineLlm — A2-14b：从已确认需求真实生成可运行 MVP 代码（LLM 生成型，无模板兜底）。
 *
 * - 模型只输出一个 JSON `{ files:[{path,content}], run_command, assumptions, risks }`；
 * - 文件路径白名单校验（模型可写仅 index.html / src/*.js / src/*.css），
 *   package.json 与 static-server.js 由系统固定写入（不接受模型 content）；
 * - 120s 硬超时（对齐 R-WAIT-03）：超时/解析失败/非 JSON/空输出/空 files/路径非法/超文件数
 *   一律抛错向上传播；外部取消抛 AGENT_CANCELLED。不再降级为模板（模板仅保留在 repair-engine 自动修复）。
 */

export interface GenerateMvpLlmInput {
  project_id: string
  /** PRD 背板：生成唯一事实源（定位/功能项/验收/范围外），防"货不对板"。 */
  backplane: PrdBackplane
  query: SDKQuery
  env: Record<string, string>
  signal?: AbortSignal
  sessionId: string
  maxTokens?: number
  timeoutMs?: number
  /** 修复上下文（self-healing @分析错误原因）：上次生成/运行失败的具体原因，注入 prompt 让模型针对性修复。 */
  repairContext?: { category: string; error: string }
}

export interface GenerateMvpLlmResult {
  files: GeneratedMvpFile[]
  run_command: string
  assumptions: string[]
  risks: string[]
}

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_FILES = 10
/** 单次生成默认最大输出 token（对齐全量代码生成，避免 4000 导致三文件 JSON 溢出截断）。 */
export const DEFAULT_MAX_TOKENS = 8192
/** 截断升级重试时的输出上限（一次性放宽，成本可控）。 */
const MAX_MAX_TOKENS = 16384
/** 生成尝试次数上限：首试 + 一次恢复重试（对齐 ADR-082「一次修复往返」的成本控制）。 */
const MAX_GENERATION_ATTEMPTS = 2

/** 格式错误（非截断）恢复重试的反馈提示：只要求重输出合法 JSON，不修补内容。 */
const RETRY_FEEDBACK_PROMPT =
  '你上一次的输出无法被解析为有效 JSON。请重新只输出一个 JSON 对象' +
  '（{"files":[{"path":"...","content":"..."}],"run_command":"npm start","assumptions":[],"risks":[]}），' +
  '不要任何 markdown 代码围栏、不要任何解释文字，确保所有括号与引号完整闭合。'

/** 模型可写白名单：精确单层匹配（index.html 顶层、src/ 下一层 .js/.css）。 */
const MODEL_WRITABLE_TESTS: ((path: string) => boolean)[] = [
  (path) => path === 'index.html',
  (path) => /^src\/[^/]+\.js$/.test(path),
  (path) => /^src\/[^/]+\.css$/.test(path),
]

/** 系统接管文件：content 忽略，由系统写入固定版本，不整批拒绝。 */
const SYSTEM_FILES = new Set(['package.json', 'static-server.js'])

const SYSTEM_PROMPT = `你是「Bloma MVP 生成器」，负责把已确认的需求生成一个可运行、纯前端的 MVP。只输出一个 JSON 对象，不要任何多余文字，不要 markdown 代码块围栏。

输出结构：
{"files":[{"path":"index.html","content":"..."},{"path":"src/app.js","content":"..."},{"path":"src/styles.css","content":"..."}],
 "run_command":"npm start",
 "assumptions":["..."],
 "risks":["..."]}

硬性约束：
- 严格按照用户提供的需求清单实现对应功能，不要擅自替换成其他应用（如计算器、待办清单、记账本等）——用户要什么就做什么。
- 纯前端应用，零外部依赖，仅 index.html / src/app.js / src/styles.css 三个文件，可本地 npm start 启动。
- 运行在安全沙箱内：CSP connect-src 为 none，应用不得发起任何外部网络请求（不 fetch/XHR/WebSocket 外部地址）。
- index.html 提供用户可见的功能入口与交互控件（按钮/输入框等），src/app.js 实现对应的交互逻辑。
- 严禁使用 eval()、new Function()、Function() 构造器、setTimeout/setInterval 传字符串等动态执行方式——它们会被沙箱 CSP 拦截导致按钮无响应。交互逻辑请用显式的 if/switch 分支或事件监听实现。
- index.html 中不要写 <meta http-equiv="Content-Security-Policy"> 标签（沙箱 CSP 由平台统一注入，内联 meta 会与之冲突导致脚本被拦）。
- 只输出 JSON，其余一律不要。`

export async function generateMvpLlm(input: GenerateMvpLlmInput): Promise<GenerateMvpLlmResult> {
  const selfController = new AbortController()
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => selfController.abort(), timeoutMs)
  const combinedSignal = combineSignals(selfController.signal, input.signal)

  try {
    const prompt = buildPrompt(input.backplane, input.repairContext)
    let maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS
    let lastAccumulated = ''
    let truncated = false

    // 首试 + 一次恢复重试：截断 → 加大 maxTokens 重新生成（内容不能修补）；
    // 格式错误（非截断）→ 带反馈重试。两种恢复都只做一轮，成本与延迟可控。
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
      const accumulated = await streamAccumulate(input, prompt, maxTokens, attempt, lastAccumulated, truncated, combinedSignal, selfController)
      if (input.signal?.aborted) throw new Error('AGENT_CANCELLED')

      const parsed = parseMvpJson(accumulated)
      if (parsed) {
        if (parsed.files.length === 0) throw new Error('MVP_LLM_INVALID_OUTPUT: 模型未返回任何文件')
        if (parsed.files.length > MAX_FILES) throw new Error(`MVP_LLM_INVALID_OUTPUT: 模型返回文件数超过上限 ${MAX_FILES}`)

        const modelFiles = validateFilePaths(parsed.files)
        if (!modelFiles) throw new Error('MVP_LLM_PATH_REJECTED: 模型返回了非法的文件路径')

        const project = findProject(input.project_id)
        const finalFiles: GeneratedMvpFile[] = [
          { path: 'package.json', content: renderPackageJson(project.name) },
          { path: 'static-server.js', content: renderStaticServer() },
          ...modelFiles.map(sanitizeModelFile),
        ]
        for (const file of finalFiles) {
          const fullPath = join(project.root_path, file.path)
          mkdirSync(join(fullPath, '..'), { recursive: true })
          writeFileSync(fullPath, file.content, 'utf8')
        }

        return {
          files: finalFiles,
          run_command: typeof parsed.run_command === 'string' && parsed.run_command.trim() ? parsed.run_command : 'npm start',
          assumptions: parsed.assumptions ?? [],
          risks: parsed.risks ?? [],
        }
      }

      // 解析失败：区分截断与格式错误，决定重试策略。
      truncated = looksTruncated(accumulated)
      lastAccumulated = accumulated
      if (truncated) maxTokens = Math.min(maxTokens * 2, MAX_MAX_TOKENS)
    }

    // 重试耗尽：按最后一种失败原因抛清晰错误，便于上层与用户定位。
    if (truncated) {
      throw new Error('MVP_LLM_TRUNCATED: 模型输出被截断（疑似 max_tokens 不足），已尝试加大 token 重试仍失败')
    }
    throw new Error('MVP_LLM_PARSE_FAILED: 模型输出无法解析为有效 JSON')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 单次生成：流式累积 assistant 文本，超时/取消语义与旧实现一致。
 * 重试时按策略调整 prompt 与历史（截断→全新重生成；格式错误→带反馈续问）。
 */
async function streamAccumulate(
  input: GenerateMvpLlmInput,
  prompt: string,
  maxTokens: number,
  attempt: number,
  lastAccumulated: string,
  truncated: boolean,
  signal: AbortSignal,
  selfController: AbortController,
): Promise<string> {
  const history = buildRetryHistory(input.backplane, input.repairContext, attempt, lastAccumulated, truncated)
  const queryPrompt = attempt === 0 || truncated ? prompt : RETRY_FEEDBACK_PROMPT

  let accumulated = ''
  try {
    const stream = input.query(queryPrompt, {
      env: input.env,
      signal,
      sessionId: input.sessionId,
      history,
      maxTokens,
    })
    for await (const sdkMessage of stream) {
      if (sdkMessage.type !== 'assistant' || !sdkMessage.message) continue
      const text = extractText(sdkMessage.message.content)
      if (text) accumulated += text
    }
  } catch (error) {
    // 按触发源区分语义（不依赖错误类型）：自建 timeout controller 先触发 → 超时抛错；
    // 外部 signal 先触发 → 取消语义向上抛；其余网络/模型错误 → 向上抛。
    if (selfController.signal.aborted) throw new Error('MVP_LLM_TIMEOUT: 模型生成超时，已取消本次生成')
    throw error
  }

  // 流正常结束但自建 controller 已触发（mock 流在 abort 后仍返回）→ 超时抛错
  if (selfController.signal.aborted) throw new Error('MVP_LLM_TIMEOUT: 模型生成超时，已取消本次生成')
  return accumulated
}

/** 重试历史：截断走全新重生成（不加脏输出），格式错误把坏输出作为 assistant 轮次回灌续问。 */
function buildRetryHistory(
  backplane: PrdBackplane,
  repairContext: GenerateMvpLlmInput['repairContext'],
  attempt: number,
  lastAccumulated: string,
  truncated: boolean,
): ConversationTurn[] {
  if (attempt === 0 || truncated) return [{ role: 'system', content: SYSTEM_PROMPT }]
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildPrompt(backplane, repairContext) },
    { role: 'assistant', content: lastAccumulated },
  ]
}

/** 检测模型输出是否被截断（max_tokens 用尽导致 JSON 未闭合）。只做结构判断，绝不修补内容。 */
function looksTruncated(text: string): boolean {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.lastIndexOf('{')
  if (start < 0) return false
  // 模型截断惯用的省略/占位符结尾
  if (/(?:\.\.\.|…)\s*$|\/\/\s*(?:rest|more|remaining|todo|未完|略|其余)\s*$/i.test(cleaned)) return true
  const tail = cleaned.slice(start)
  let depth = 0
  let inString = false
  let escaped = false
  for (const ch of tail) {
    if (inString) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') depth = Math.max(0, depth - 1)
  }
  return inString || depth > 0
}

/** 组合自建超时 signal 与外部 signal：任一触发即中止（等价 AbortSignal.any，Node ≥ 20.3）。 */
function combineSignals(self: AbortSignal, external?: AbortSignal): AbortSignal {
  if (!external) return self
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  self.addEventListener('abort', onAbort, { once: true })
  external.addEventListener('abort', onAbort, { once: true })
  if (self.aborted || external.aborted) controller.abort()
  return controller.signal
}

function buildPrompt(backplane: PrdBackplane, repairContext?: GenerateMvpLlmInput['repairContext']): string {
  const items = backplane.requirements.length
    ? backplane.requirements
    : [{ id: 'F-001', description: '一个可运行、可交互的功能页面' }]
  const list = items.map((r) => `- ${r.id}: ${r.description}`).join('\n')
  const acceptance = items.map((r) => `- ${r.id}: ${backplane.acceptance[r.id] ?? ''}`).join('\n')
  const outOfScope = backplane.out_of_scope.length
    ? backplane.out_of_scope.map((scope) => `- ${scope}`).join('\n')
    : '- 无'
  const repairSection = repairContext
    ? [
        ``,
        `【修复上下文（上次版本失败原因，请针对性修复）】`,
        `错误类别：${repairContext.category}`,
        `错误描述：${repairContext.error}`,
        `请先分析上述失败原因，再生成修复后的版本；其余功能项与验收标准不变，不要擅自改需求。`,
      ]
    : []
  return [
    `请根据以下 PRD 背板生成 MVP（产品定位是唯一主题锚点，功能项必须全部实现，不得擅自替换成其他应用）。`,
    ``,
    `产品定位：${backplane.positioning}`,
    ``,
    `功能项：`,
    list,
    ``,
    `验收标准：`,
    acceptance,
    ``,
    `范围外（不要实现）：`,
    outOfScope,
    ...repairSection,
  ].join('\n')
}

interface MvpLlmParsed {
  files: { path: string; content: string }[]
  run_command?: string
  assumptions?: string[]
  risks?: string[]
}

function parseMvpJson(text: string): MvpLlmParsed | undefined {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed.files)) return undefined

  const files = parsed.files
    .filter(isRecord)
    .filter((f) => typeof f.path === 'string' && typeof f.content === 'string')
    .map((f) => ({ path: f.path as string, content: f.content as string }))

  const stringArray = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined

  return {
    files,
    run_command: typeof parsed.run_command === 'string' ? parsed.run_command : undefined,
    assumptions: stringArray(parsed.assumptions),
    risks: stringArray(parsed.risks),
  }
}

/**
 * 校验模型返回的文件路径白名单。返回可写模型文件列表；安全违规（路径穿越/绝对路径/
 * 白名单不匹配的非系统文件）返回 null（整批拒绝）；系统接管文件被忽略（单文件忽略，不整批拒绝）。
 */
function validateFilePaths(rawFiles: { path: string; content: string }[]): { path: string; content: string }[] | null {
  const modelFiles: { path: string; content: string }[] = []
  for (const file of rawFiles) {
    if (isUnsafePath(file.path)) return null
    if (SYSTEM_FILES.has(file.path)) continue
    if (MODEL_WRITABLE_TESTS.some((test) => test(file.path))) {
      modelFiles.push(file)
      continue
    }
    return null
  }
  return modelFiles
}

function isUnsafePath(path: string): boolean {
  if (path.includes('..')) return true
  if (path.startsWith('/') || path.startsWith('\\')) return true
  if (/^[a-zA-Z]:/.test(path)) return true
  return false
}

/**
 * 移除模型生成 index.html 里与平台 CSP 冲突的 meta CSP 标签（P1）。
 * 模型有时会自发写 `<meta http-equiv="Content-Security-Policy" content="script-src 'self'">`，
 * 它与平台静态服务器的 CSP 取交集后会把内联脚本/ eval 一并拦死，导致「点按钮没反应」。
 * 平台 CSP 是唯一真相源，这里强制剥掉内联 meta CSP，避免双重 CSP 冲突。
 */
function sanitizeModelFile(file: { path: string; content: string }): { path: string; content: string } {
  if (file.path !== 'index.html') return file
  return {
    path: file.path,
    content: file.content.replace(/<meta[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, ''),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function extractText(blocks: MessageContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

