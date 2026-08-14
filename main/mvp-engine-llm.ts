import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConversationTurn, SDKQuery } from './orchestrator'
import { findProject } from './project-service'
import type { SketchRequirement } from './sketch-engine'
import { renderPackageJson, renderStaticServer, type GeneratedMvpFile } from './mvp-engine'
import type { MessageContentBlock } from '../shared/types'

/**
 * MvpEngineLlm — A2-14b：从已确认需求真实生成可运行 MVP 代码（LLM 生成型，模板降级为兜底）。
 *
 * - 模型只输出一个 JSON `{ files:[{path,content}], run_command, assumptions, risks }`；
 * - 文件路径白名单校验（模型可写仅 index.html / src/*.js / src/*.css），
 *   package.json 与 static-server.js 由系统固定写入（不接受模型 content）；
 * - 120s 硬超时（对齐 R-WAIT-03）：超时/解析失败/非 JSON/空输出/空 files → 返回 template 兜底；
 *   外部取消 → 抛错向上；仅网络/模型错误等非中止异常向上抛。
 */

export interface GenerateMvpLlmInput {
  project_id: string
  requirements: SketchRequirement[]
  query: SDKQuery
  env: Record<string, string>
  signal?: AbortSignal
  sessionId: string
  maxTokens?: number
  timeoutMs?: number
}

export interface GenerateMvpLlmResult {
  files: GeneratedMvpFile[]
  run_command: string
  assumptions: string[]
  risks: string[]
  generated_by: 'llm' | 'template'
}

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_FILES = 10

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
- 纯前端应用，零外部依赖，仅 index.html / src/app.js / src/styles.css 三个文件，可本地 npm start 启动。
- 运行在安全沙箱内：CSP connect-src 为 none，应用不得发起任何外部网络请求（不 fetch/XHR/WebSocket 外部地址）。
- index.html 必须包含四则运算符按钮：+（加）、−（减）、×（乘）、÷（除）。
- src/app.js 必须包含名为 calculate 的四则运算逻辑函数。
- 严禁使用 eval()、new Function()、Function() 构造器、setTimeout/setInterval 传字符串等动态执行方式——它们会被沙箱 CSP 拦截导致按钮无响应。四则运算请用显式的 if/switch 分支或运算符判断实现。
- index.html 中不要写 <meta http-equiv="Content-Security-Policy"> 标签（沙箱 CSP 由平台统一注入，内联 meta 会与之冲突导致脚本被拦）。
- 只输出 JSON，其余一律不要。`

export async function generateMvpLlm(input: GenerateMvpLlmInput): Promise<GenerateMvpLlmResult> {
  const selfController = new AbortController()
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => selfController.abort(), timeoutMs)
  const combinedSignal = combineSignals(selfController.signal, input.signal)

  try {
    const prompt = buildPrompt(input.requirements)
    const history: ConversationTurn[] = [{ role: 'system', content: SYSTEM_PROMPT }]

    let accumulated = ''
    try {
      const stream = input.query(prompt, {
        env: input.env,
        signal: combinedSignal,
        sessionId: input.sessionId,
        history,
        maxTokens: input.maxTokens,
      })
      for await (const sdkMessage of stream) {
        if (sdkMessage.type !== 'assistant' || !sdkMessage.message) continue
        const text = extractText(sdkMessage.message.content)
        if (text) accumulated += text
      }
    } catch (error) {
      // 按触发源区分语义（不依赖错误类型）：自建 timeout controller 先触发 → 超时返回 template；
      // 外部 signal 先触发 → 取消语义向上抛；其余网络/模型错误 → 向上抛由 runMvpTask 兜底。
      if (selfController.signal.aborted) return templateFallback()
      throw error
    }

    // 流正常结束但自建 controller 已触发（mock 流在 abort 后仍返回）→ 超时兜底
    if (selfController.signal.aborted) return templateFallback()
    if (input.signal?.aborted) throw new Error('AGENT_CANCELLED')

    const parsed = parseMvpJson(accumulated)
    if (!parsed || parsed.files.length === 0 || parsed.files.length > MAX_FILES) return templateFallback()

    const modelFiles = validateFilePaths(parsed.files)
    if (!modelFiles) return templateFallback()

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
      generated_by: 'llm',
    }
  } finally {
    clearTimeout(timer)
  }
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

function buildPrompt(requirements: SketchRequirement[]): string {
  const list = requirements.length
    ? requirements.map((r) => `- ${r.id}: ${r.description}`).join('\n')
    : '- F-001: 基础四则运算计算器'
  return `请生成以下需求的 MVP：\n${list}`
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

function templateFallback(): GenerateMvpLlmResult {
  return { files: [], run_command: 'npm start', assumptions: [], risks: [], generated_by: 'template' }
}
