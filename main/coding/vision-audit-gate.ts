/**
 * vision-audit-gate.ts — L1 视觉审计门禁（终验链内的强制视觉证据采集）。
 *
 * 链路（2026-09-12 重构，用户口径：链路不绑定厂商/模型，每个角色可选配）：
 *   ① 观察员A（盲描述）：只看截图，产出**带坐标的完整 JSON 描述**；
 *   ② 观察员B（盲描述）：**独立**调用同一提示词——先自己描述，**不允许先看 A 的结果**；
 *   ③ 对照审核者：拿 A/B 两份 JSON + 原图做二次识别，核查真实性与准确性，产出**问题 JSON**（带 bbox 证据）；
 *   ④ 修复者：问题交给 **Bloma 编程模型**（category mvp 的编码渠道）去改——本模块只产出问题，
 *      不自己修、不判败（判败权在 L0 确定性探针与裁判）。
 *
 * 角色可选配（默认 flash 档；本机限制：三家只用 flash，换档自行覆盖）：
 *   BLOMA_VISION_V1_MODEL      观察员A 模型（默认链：glm-4v-flash → glm-4.6v → ds 视觉）
 *   BLOMA_VISION_V2_MODEL      观察员B 模型（默认链：qwen3-vl-flash → qwen-vl-max → qwen3-vl-plus）
 *   BLOMA_VISION_COMPARE_MODEL 对照审核者模型（缺省复用观察员B 的端点）
 *   BLOMA_VISION_FIXER_ROLE    修复者角色（缺省 'coding'，即 Bloma 编程模型；由编程链解析，不在本模块选模型）
 *
 * 权威性边界：
 * - LLM 输出永不判败、永不自动改代码；只作为证据（报告 + 摘要 + 结构化问题）交给裁判与修复者；
 * - 基础设施失败（无渠道/超时/HTTP 错）→ status='unavailable'，调用方必须落到决策日志与裁判可见处（F9a 不静默）。
 */
import { listEnabledRawChannels, decryptApiKey } from '../channel-manager'
import { writeVisionAuditDocument, writeVisionProblemsDocument } from '../document-engine'
import { chromium } from 'playwright'

/** 显式覆盖（空 = 走角色偏好链）。 */
export const VISION_V1_MODEL = process.env.BLOMA_VISION_V1_MODEL || ''
export const VISION_V2_MODEL = process.env.BLOMA_VISION_V2_MODEL || ''
export const VISION_COMPARE_MODEL = process.env.BLOMA_VISION_COMPARE_MODEL || ''
export const VISION_FIXER_ROLE = process.env.BLOMA_VISION_FIXER_ROLE || 'coding'

/**
 * 角色偏好链（按序尝试；env 覆盖优先）。默认全为 flash 档（本机限制）。
 * 链末保留历史默认仅为向后兼容（旧渠道表里只有它时仍能跑）。
 */
export const V1_PREFERENCE = ['glm-4v-flash', 'glm-4.6v', 'deepseek-v4-flash-vision-exp']
export const V2_PREFERENCE = ['qwen3-vl-flash', 'qwen-vl-max', 'qwen3-vl-plus']

export interface ChannelLike {
  id: string
  name: string
  base_url: string
  api_key: string
  models: { id: string; enabled?: boolean }[] | string[]
  enabled: boolean
}

export interface VisionEndpoint {
  chatBase: string
  apiKey: string
  model: string
  channelName: string
}

/**
 * 对照审核产出的单条问题（面向"让编程模型去改"，不含实现方式）。
 *
 * Q5 路由规则（2026-09-12 裁定，已决）：
 *  - target='product'   → 允许组装 RepairTask(source='vision') 交编程模型；
 *  - target='description' → 进观察员质量队列（改提示词/换模型/重描述），**不回喂代码**；
 *  - 默认值由 kind 推导：omission/missing_element/state_error/layout_error → product；
 *    inaccurate/false_claim → description；
 *  - root_cause 可改判：observer → description；product → product（如 false_claim 根因是
 *    控件缺失/状态不可辨/渲染错误/可访问性问题）；ambiguous 不改判。
 *  - 混合问题必须拆条（由提示词约束），不整包丢给编程模型。
 */
export type ProblemTarget = 'description' | 'product'
export type ProblemRootCause = 'observer' | 'product' | 'ambiguous'

export interface VisionProblem {
  kind: 'omission' | 'inaccurate' | 'false_claim' | 'missing_element' | 'state_error' | 'layout_error'
  severity: 'low' | 'medium' | 'high' | 'critical'
  /** Q5：该问题该谁处理（默认按 kind 推导，root_cause 可改判） */
  target: ProblemTarget
  /** Q5：根因归属（观察员描述失误 / 产品实现问题 / 不确定） */
  root_cause: ProblemRootCause
  claim: string
  bbox: [number, number, number, number] | null
  evidence: string
  suggest_fix: string
}

export interface VisionGateResult {
  status: 'passed' | 'flagged' | 'unavailable' | 'skipped'
  /** 给裁判 testSummary 的紧凑证据（≤400 字）；unavailable/skipped 时为可见说明 */
  digest: string
  /** 结构化问题（交给编程模型修复用；无问题为空数组） */
  problems?: VisionProblem[]
  note?: string
}

export function visionAuditEnabled(): boolean {
  return process.env.BLOMA_VISION_AUDIT !== '0'
}

/** 渠道 base_url → OpenAI chat 根：/anthropic 系取 origin；compatible-mode/v1 原样。 */
export function deriveChatBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  const anthropicIdx = trimmed.indexOf('/anthropic')
  if (anthropicIdx > 0) return trimmed.slice(0, anthropicIdx)
  return trimmed
}

function modelIds(channel: ChannelLike): string[] {
  return (channel.models || []).map((m) => (typeof m === 'string' ? m : m.id))
}

/** 模型匹配：精确优先，子串兼容 seed 变体名（如 deepseek-deepseek-v4-flash-vision-exp-1）。 */
function hasModel(channel: ChannelLike, model: string): boolean {
  const ids = modelIds(channel)
  return ids.includes(model) || ids.some((id) => id.includes(model))
}

/** 按候选链挑一个可用端点；excludeChannelId 用于优先错开厂商渠道（拿不到再放开）。 */
export function pickVisionEndpoint(
  channels: ChannelLike[],
  candidates: string[],
  excludeChannelId?: string,
): { channel: ChannelLike; model: string } | undefined {
  for (const model of candidates) {
    if (!model) continue
    const hit = channels.find((c) => c.enabled && c.id !== excludeChannelId && hasModel(c, model))
    if (hit) return { channel: hit, model }
  }
  return undefined
}

function mkEndpoint(channel: ChannelLike, model: string, decrypt: (hex: string) => string): VisionEndpoint {
  return { chatBase: deriveChatBaseUrl(channel.base_url), apiKey: decrypt(channel.api_key), model, channelName: channel.name }
}

/**
 * 纯挑选：解析三个角色端点（解密函数注入，测试不碰 safeStorage）。
 * A 缺失 → null（无审计可言）；B 优先换渠道（跨厂商异构），同渠道为次优解；对照审核缺省复用 B。
 */
export function resolveVisionRoles(
  channels: ChannelLike[],
  decrypt: (hex: string) => string,
): { a: VisionEndpoint; b: VisionEndpoint; compare: VisionEndpoint } | null {
  const aCandidates = VISION_V1_MODEL ? [VISION_V1_MODEL] : V1_PREFERENCE
  const bCandidates = VISION_V2_MODEL ? [VISION_V2_MODEL] : V2_PREFERENCE

  const a = pickVisionEndpoint(channels, aCandidates)
  if (!a) return null
  const b = pickVisionEndpoint(channels, bCandidates, a.channel.id) ?? pickVisionEndpoint(channels, bCandidates)
  if (!b) return null

  const comparePick = VISION_COMPARE_MODEL ? pickVisionEndpoint(channels, [VISION_COMPARE_MODEL]) : undefined
  return {
    a: mkEndpoint(a.channel, a.model, decrypt),
    b: mkEndpoint(b.channel, b.model, decrypt),
    compare: comparePick ? mkEndpoint(comparePick.channel, comparePick.model, decrypt) : mkEndpoint(b.channel, b.model, decrypt),
  }
}

/** 兼容旧名（既有测试/调用点）：A→V1、B→V2。 */
export function resolveVisionPair(channels: ChannelLike[], decrypt: (hex: string) => string): { v1: VisionEndpoint; v2: VisionEndpoint } | null {
  const roles = resolveVisionRoles(channels, decrypt)
  return roles ? { v1: roles.a, v2: roles.b } : null
}

/**
 * 盲描述提示（A、B 各自独立调用，互不可见——互证有效的前提）。
 * 输出：带坐标的完整 JSON 描述（bbox 单位像素，原点图片左上角）。
 */
export const BLIND_DESCRIBE_PROMPT = [
  '你是 UI 截图观察员。只输出一个 JSON 对象，不要解释文字、不要 markdown 围栏。',
  '结构：',
  '{',
  '  "viewport": {"w": <int>, "h": <int>},',
  '  "screen": {"title": "界面标题原文", "purpose": "这个界面在做什么（一句话）", "layout": "布局结构（分栏/层级/对齐）"},',
  '  "elements": [',
  '    {"id": "e1", "type": "button|input|textarea|select|checkbox|radio|link|text|heading|icon|image|card|nav|table|list|canvas|badge|other",',
  '     "text": "逐字原文（无文字写空串）", "bbox": [left, top, width, height],',
  '     "state": "default|selected|hover|disabled|loading|error|empty|unknown",',
  '     "style": "可判定的视觉特征（颜色/字号层级/圆角/描边/阴影）", "note": "其它值得记录的事实"}',
  '  ],',
  '  "states_visible": ["当前可见状态（空态/加载/错误/选中…）"],',
  '  "uncertain": ["无法确认的点，不要猜"]',
  '}',
  '坐标约定：以图片左上角为原点、单位像素，bbox=[左, 上, 宽, 高]。元素尽量列全（含纯文字与图标）。',
  '禁止评价好坏、禁止给建议、禁止推测图片之外的内容；看不到的写进 uncertain。',
].join('\n')

/**
 * 对照审核提示：给 A/B 两份**各自独立产出**的盲描述 JSON + 原图，要求二次识别后产出问题 JSON。
 */
export function buildComparePrompt(aJson: string, bJson: string): string {
  return [
    '你是 UI 截图审核员。下面有两份**互相独立**产出的同一张截图的描述 JSON（观察员A、观察员B），以及原图。',
    '任务：对照原图做二次识别，核查两份描述的真实性与准确性，输出一个 JSON 对象（不要解释文字、不要围栏）。',
    '结构：',
    '{',
    '  "agree": ["两份一致且复核为真的要点"],',
    '  "corrections": [{"who": "A|B|both", "claim": "被纠正的描述", "actual": "图中实际情况", "bbox": [l,t,w,h] 或 null}],',
    '  "problems": [',
    '    {"target": "description|product", "root_cause": "observer|product|ambiguous",',
    '     "kind": "omission|missing_element|state_error|layout_error|inaccurate|false_claim",',
    '     "severity": "low|medium|high|critical",',
    '     "claim": "问题一句话（面向产品，不写代码建议）",',
    '     "bbox": [l,t,w,h] 或 null,',
    '     "evidence": "图中位置与可见证据",',
    '     "suggest_fix": "期望的界面表现（用户视角，非实现方式）"}',
    '  ],',
    '  "confidence": "high|medium|low"',
    '}',
    '规则：只报能在图上指认的问题；两份都没提、图上也没有的不要报；两份一致但都错时以原图为准（写 corrections 并计入 problems）；',
    '拿不准的降 severity，不要删；不要为凑数而报。',
    '',
    '【target / root_cause 判定规则（必须遵守）】',
    ' - 默认：omission / missing_element / state_error / layout_error → target=product；inaccurate / false_claim → target=description。',
    ' - 若 false_claim 的根因是产品侧（控件缺失、状态不可辨、渲染错误、可访问性问题）→ root_cause=product 且 target=product。',
    ' - 若 missing_element 只是观察员自己没看到 → root_cause=observer 且 target=description。',
    ' - 拿不准根因时 root_cause=ambiguous，并沿用 kind 默认 target。',
    ' - **混合问题必须拆成多条**（描述失误与产品缺陷不要写进同一条），每条只归一个 target。',
    '',
    '=== 观察员A JSON ===',
    aJson,
    '=== 观察员B JSON ===',
    bJson,
  ].join('\n')
}

/** 从模型输出里抠出 JSON（容忍围栏/前后噪声）；失败返回 undefined。 */
export function extractJson<T = unknown>(text: string): T | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced?.[1] ?? text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T
  } catch {
    return undefined
  }
}

/** Q5 默认路由：kind → target（root_cause 可改判）。 */
export function defaultTargetForKind(kind: VisionProblem['kind']): ProblemTarget {
  return kind === 'inaccurate' || kind === 'false_claim' ? 'description' : 'product'
}

/**
 * Q5 归一：target 缺失/非法时按 kind 推导；root_cause 明确时改判（observer→description、product→product）。
 * 导出供修复协调器的白名单复核复用。
 */
export function normalizeTarget(kind: VisionProblem['kind'], rawTarget: unknown, rootCause: ProblemRootCause): ProblemTarget {
  if (rootCause === 'observer') return 'description'
  if (rootCause === 'product') return 'product'
  if (rawTarget === 'description' || rawTarget === 'product') return rawTarget
  return defaultTargetForKind(kind)
}

/** 修复白名单：只有 target='product' 才允许组装 RepairTask(source='vision') 交编程模型。 */
export function productProblems(problems: VisionProblem[]): VisionProblem[] {
  return problems.filter((p) => p.target === 'product')
}

/** 解析对照审核输出 → 问题清单（非法/缺字段的条目丢弃，只保留可指认的问题）。 */
export function parseCompareOutput(text: string): { problems: VisionProblem[]; corrections: unknown[]; confidence?: string; parsed: boolean } {
  const json = extractJson<{ problems?: unknown; corrections?: unknown; confidence?: unknown }>(text)
  if (!json) return { problems: [], corrections: [], parsed: false }
  const kinds = ['omission', 'inaccurate', 'false_claim', 'missing_element', 'state_error', 'layout_error']
  const sevs = ['low', 'medium', 'high', 'critical']
  const rootCauses = ['observer', 'product', 'ambiguous']
  const problems: VisionProblem[] = (Array.isArray(json.problems) ? json.problems : [])
    .map((raw): VisionProblem | undefined => {
      const p = raw as Record<string, unknown>
      const kind = String(p.kind || '')
      const severity = String(p.severity || 'medium')
      const claim = String(p.claim || '').trim()
      if (!claim || !kinds.includes(kind)) return undefined
      const bboxRaw = p.bbox
      const bbox = Array.isArray(bboxRaw) && bboxRaw.length === 4 && bboxRaw.every((n) => typeof n === 'number')
        ? (bboxRaw as [number, number, number, number])
        : null
      const rootCause = (rootCauses.includes(String(p.root_cause)) ? String(p.root_cause) : 'ambiguous') as ProblemRootCause
      const typedKind = kind as VisionProblem['kind']
      return {
        kind: typedKind,
        severity: (sevs.includes(severity) ? severity : 'medium') as VisionProblem['severity'],
        target: normalizeTarget(typedKind, p.target, rootCause),
        root_cause: rootCause,
        claim,
        bbox,
        evidence: String(p.evidence || '').slice(0, 400),
        suggest_fix: String(p.suggest_fix || '').slice(0, 400),
      }
    })
    .filter((x): x is VisionProblem => x !== undefined)
    .slice(0, 30)
  return {
    problems,
    corrections: Array.isArray(json.corrections) ? json.corrections : [],
    confidence: typeof json.confidence === 'string' ? json.confidence : undefined,
    parsed: true,
  }
}

/** 摘要（≤400 字）：两份描述长度 + 问题计数（含 product/description 分档）+ 前两条产品侧问题。 */
export function digestVisionReport(aText: string, bText: string, problems: VisionProblem[]): { digest: string; flagged: boolean } {
  const product = productProblems(problems)
  const high = product.filter((p) => p.severity === 'high' || p.severity === 'critical').length
  const flagged = problems.length > 0
  const top = product.slice(0, 2).map((p) => `[${p.severity}/${p.kind}] ${p.claim}`).join(' ｜ ')
  const digest = [
    `视觉审计: A/B 盲描述 ${aText.length}/${bText.length} 字`,
    `问题 ${problems.length} 条（产品侧 ${product.length}，high/critical ${high}；描述质量 ${problems.length - product.length} 不回喂代码）`,
    top ? `要点: ${top}` : '',
  ].filter(Boolean).join('；').slice(0, 400)
  return { digest, flagged }
}

/** 视觉调用 max_tokens 缺省（env 可覆盖）。 */
const VISION_MAX_TOKENS = Number(process.env.BLOMA_VISION_MAX_TOKENS || 8192)
/** 已探测到的厂商上限缓存（按模型名）：避免每次调用都先吃一个 400（评审 ③）。 */
const MAX_TOKENS_CAP_CACHE = new Map<string, number>()

/**
 * 从 400 报错里解析厂商声明的 max_tokens 上限。
 * 实测样例（2026-09-12 智谱 glm-4v-flash）：
 *   {"error":{"code":"1210","message":"max_tokens参数非法：限制数值范围[1,1024]"}} → 1024
 * 解析失败返回 undefined（调用方保持原值，不猜）。
 */
export function parseMaxTokensCap(errorText: string): number | undefined {
  const range = errorText.match(/\[\s*\d+\s*,\s*(\d{2,6})\s*\]/)
  const afterKw = errorText.match(/max_tokens[^\d]{0,24}(\d{2,6})/i)
  const cap = Number(range?.[1] ?? afterKw?.[1])
  return Number.isFinite(cap) && cap > 0 ? cap : undefined
}

async function chatVision(ep: VisionEndpoint, instruction: string, imagePng: Buffer, timeoutMs: number): Promise<string> {
  const post = async (maxTokens: number) => fetch(`${ep.chatBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: ep.model, max_tokens: maxTokens,
      messages: [{ role: 'user', content: [
        { type: 'text', text: instruction },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${imagePng.toString('base64')}` } },
      ] }],
    }),
  })

  // 已探测过该模型上限 → 直接按上限请求，零浪费
  const cachedCap = MAX_TOKENS_CAP_CACHE.get(ep.model)
  const initial = cachedCap ? Math.min(cachedCap, VISION_MAX_TOKENS) : VISION_MAX_TOKENS
  let resp = await post(initial)
  if (resp.status === 400) {
    const bodyText = await resp.text().catch(() => '')
    const cap = parseMaxTokensCap(bodyText)
    if (cap && cap < initial) {
      MAX_TOKENS_CAP_CACHE.set(ep.model, cap)
      resp = await post(cap)
    } else {
      throw new Error(`${ep.model} HTTP 400: ${bodyText.slice(0, 200)}`)
    }
  }
  if (!resp.ok) throw new Error(`${ep.model} HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`)
  const json = await resp.json() as { choices?: { message?: { content?: string } }[] }
  const text = json.choices?.[0]?.message?.content || ''
  if (!text.trim()) throw new Error(`${ep.model} 返回空内容`)
  return text
}

async function screenshotPreview(previewUrl: string, timeoutMs: number): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(previewUrl, { waitUntil: 'load', timeout: timeoutMs })
    await page.waitForTimeout(1200)
    return await page.screenshot({ type: 'png', fullPage: true })
  } finally {
    await browser.close().catch(() => {})
  }
}

/**
 * 运行 L1 视觉审计（三段调用：A 盲描述 → B 盲描述 → 对照审核）。
 * 任何一步失败 → unavailable（可见，不静默）；成功 → 报告 + 结构化问题落项目文档。
 */
export async function runVisionAuditGate(input: {
  previewUrl: string
  projectId: string
  timeoutMs?: number
}): Promise<VisionGateResult> {
  if (!visionAuditEnabled()) {
    return { status: 'skipped', digest: '视觉审计未执行（BLOMA_VISION_AUDIT=0 紧急停用）', note: 'env kill switch' }
  }
  const timeoutMs = input.timeoutMs ?? 180_000
  let roles: ReturnType<typeof resolveVisionRoles>
  try {
    // 必须用 raw 渠道列表：listChannels() 返回脱敏 api_key='***'，解密会得到空串（401 现场）
    roles = resolveVisionRoles(listEnabledRawChannels() as unknown as ChannelLike[], decryptApiKey)
  } catch (e) {
    return { status: 'unavailable', digest: `视觉审计未执行（渠道读取失败：${(e as Error).message.slice(0, 80)}）`, note: 'channel_error' }
  }
  if (!roles) {
    return {
      status: 'unavailable',
      digest: `视觉审计未执行（缺观察员渠道：A=${VISION_V1_MODEL || V1_PREFERENCE.join('/')} / B=${VISION_V2_MODEL || V2_PREFERENCE.join('/')} 需任一启用渠道含该模型）`,
      note: 'no_channel',
    }
  }
  try {
    const png = await screenshotPreview(input.previewUrl, Math.min(timeoutMs, 40_000))
    // ① A、② B 各自独立盲描述（同一提示词、互不可见）
    const a = await chatVision(roles.a, BLIND_DESCRIBE_PROMPT, png, timeoutMs)
    const b = await chatVision(roles.b, BLIND_DESCRIBE_PROMPT, png, timeoutMs)
    // ③ 对照审核：两份独立描述 + 原图 → 二次识别 + 真实性问题 JSON
    const compareRaw = await chatVision(roles.compare, buildComparePrompt(a, b), png, timeoutMs)
    const compare = parseCompareOutput(compareRaw)
    const { digest, flagged } = digestVisionReport(a, b, compare.problems)

    writeVisionAuditDocument(input.projectId, [
      '# 视觉审计报告（L1：盲描述A + 盲描述B + 对照审核）', '',
      `> 生成：${new Date().toISOString()} | A=${roles.a.model}（${roles.a.channelName}）| B=${roles.b.model}（${roles.b.channelName}）| 对照审核=${roles.compare.model}（${roles.compare.channelName}）`,
      `> 修复者角色：${VISION_FIXER_ROLE}（Bloma 编程模型；本报告只产出问题，不判败、不改代码）`,
      `> 结论：${flagged ? `对照审核提出 ${compare.problems.length} 条问题（产品侧 ${compare.problems.filter((p) => p.target === 'product').length} / 描述质量 ${compare.problems.filter((p) => p.target === 'description').length}）` : '两份描述经对照审核未发现实质问题'}`, '',
      '## 观察员A 盲描述（JSON）', '```json', a, '```', '',
      '## 观察员B 盲描述（JSON）', '```json', b, '```', '',
      '## 对照审核（二次识别 + 真实性核查）', '```json', compareRaw, '```', '',
    ].join('\n'))
    writeVisionProblemsDocument(input.projectId, JSON.stringify({
      generated_at: new Date().toISOString(),
      roles: { a: roles.a.model, b: roles.b.model, compare: roles.compare.model, fixer: VISION_FIXER_ROLE },
      problems: compare.problems,
    }, null, 2))

    return { status: flagged ? 'flagged' : 'passed', digest, problems: compare.problems }
  } catch (e) {
    return { status: 'unavailable', digest: `视觉审计未执行（${(e as Error).message.slice(0, 160)}）`, note: 'run_error' }
  }
}
