/**
 * vision-audit-gate.ts — L1 双视觉审计门禁（2026-09-07，产出物审计管线固化）。
 *
 * 定位：终验链里 GWT/安全过后的**强制视觉证据采集**：对预览页截图，V1（观察员，
 * 只描述不评价）→ V2（异构审核员，对照图找 V1 的遗漏/不具体/不真实）双模型互证，
 * 报告落项目文档（文档面板可见），摘要以代码注入方式进裁判语义审查腿的 testSummary
 * （不是提示词配置，是调用参数——每次执行必然携带）。
 *
 * 模型对（用户 2026-09-06 指定，仅此两渠道有余额）：
 *   V1 = deepseek-v4-flash-vision-exp（ds 渠道）；V2 = qwen-vl-max（阿里云云工渠道）。
 *   两路均 OpenAI chat 协议（ds 渠道 base_url 存的是 /anthropic，需派生根域）。
 *
 * 权威性边界（与 L0 的分工）：
 * - L0（artifact-ui-gate）确定性判"界面是不是真的"，失败进修复回流；
 * - L1 是 LLM 证据，**不直接判败**——发现以摘要进裁判，由裁判（只判定不修复）决定
 *   return/让渡；避免视觉噪声变成第二套硬门禁误杀交付。
 * - 基础设施失败（无渠道/超时/HTTP 错）→ status='unavailable'：绝不静默，调用方必须
 *   把"视觉审计未执行"落到决策日志与裁判可见处（F9a 不静默纪律）。
 */
import { listEnabledRawChannels, decryptApiKey } from '../channel-manager'
import { writeVisionAuditDocument } from '../document-engine'
import { chromium } from 'playwright'

export const VISION_V1_MODEL = process.env.BLOMA_VISION_V1_MODEL || 'deepseek-v4-flash-vision-exp'
export const VISION_V2_MODEL = process.env.BLOMA_VISION_V2_MODEL || 'qwen-vl-max'

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

export interface VisionGateResult {
  status: 'passed' | 'flagged' | 'unavailable' | 'skipped'
  /** 给裁判 testSummary 的紧凑证据（≤400 字）；unavailable/skipped 时为可见说明 */
  digest: string
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

/** 纯挑选：从渠道表解析 V1/V2 端点（解密函数注入，测试不碰 safeStorage）。缺任一 → null。 */
export function resolveVisionPair(channels: ChannelLike[], decrypt: (hex: string) => string): { v1: VisionEndpoint; v2: VisionEndpoint } | null {
  const find = (model: string): ChannelLike | undefined =>
    channels.find((c) => c.enabled && hasModel(c, model))
  const v1c = find(VISION_V1_MODEL)
  const v2c = find(VISION_V2_MODEL)
  if (!v1c || !v2c) return null
  const mk = (c: ChannelLike, model: string): VisionEndpoint => ({
    chatBase: deriveChatBaseUrl(c.base_url),
    apiKey: decrypt(c.api_key),
    model,
    channelName: c.name,
  })
  return { v1: mk(v1c, VISION_V1_MODEL), v2: mk(v2c, VISION_V2_MODEL) }
}

const V1_PROMPT = [
  '你是 UI 截图观察员（只描述，不评价，不建议，不推测图片之外的信息）。',
  '请完整、客观地描述这张软件界面截图的全部内容，用结构化 Markdown 清单输出，从上到下、从左到右逐项覆盖：',
  '1) 整体布局结构与层级；2) 所有可见文字逐字转录并标注位置；3) 每个按钮、卡片、图标、图形的形状、颜色、相对位置、大小关系；',
  '4) 可见的交互状态（选中/悬停/禁用/加载/空态/错误态），没有就写「未见」；5) 背景、圆角、阴影、边框、间距与字号层级。',
  '要求：宁多勿漏；只写图中确实存在的内容；无法确认的写「不确定」。',
].join('\n')

/** V2 指令：内嵌 V1 全文做互证（异构模型审计补漏）。 */
export function buildV2Prompt(v1Report: string): string {
  return [
    '你是 UI 截图审核员。下面给出的是另一个模型对这张软件界面截图的观察报告（V1）。',
    '你的任务是对照图片逐条核查 V1，只输出三类发现（仍不评价设计好坏）：',
    '① 遗漏：图中清晰可见、但 V1 没有提到的元素/文字/状态；',
    '② 不具体：V1 提到了但描述含糊，应补充精确信息；③ 不真实：V1 声称存在、但图中实际没有或矛盾的内容。',
    '输出结构化 Markdown：## 遗漏 / ## 不具体修正 / ## 不真实纠正；每条注明图中位置证据。',
    '若某类没有发现，写「无」。不确定的一律不要编造；V1 正确时不要为凑数而纠正。',
    '',
    '=== V1 报告开始 ===',
    v1Report,
    '=== V1 报告结束 ===',
  ].join('\n')
}

function countItems(section: string | undefined): number {
  if (!section) return 0
  const body = section.split('\n').filter((l) => /^\s*(\d+\.|[-*])\s+\S/.test(l) && !/^\s*\d+\.\s*无\s*$/.test(l) && l.trim() !== '无' && !/^\s*[-*]\s*无/.test(l))
  return body.length
}

/** V1+V2 → 裁判摘要（≤400 字）：三类计数 + 前两条发现原文截断。 */
export function digestVisionReport(v1: string, v2: string): { digest: string; flagged: boolean } {
  const section = (name: string) => {
    const m = v2.match(new RegExp(`##\\s*${name}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`))
    return m?.[1]
  }
  const omissions = countItems(section('遗漏'))
  const vague = countItems(section('不具体修正'))
  const falseClaims = countItems(section('不真实纠正'))
  const flagged = omissions > 0 || falseClaims > 0
  const topLines = (v2.match(/^\s*(?:\d+\.|[-*])\s+(?!无)\S.*$/gm) || []).slice(0, 2).map((l) => l.trim().slice(0, 90))
  const digest = [
    `视觉审计: V1 详述 ${v1.length} 字; V2 互证发现 遗漏${omissions}/不具体${vague}/不真实${falseClaims}`,
    topLines.length ? `要点: ${topLines.join(' ｜ ')}` : '',
  ].filter(Boolean).join('；').slice(0, 400)
  return { digest, flagged }
}

async function chatVision(ep: VisionEndpoint, instruction: string, imagePng: Buffer, timeoutMs: number): Promise<string> {
  const resp = await fetch(`${ep.chatBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: ep.model, max_tokens: 8192,
      messages: [{ role: 'user', content: [
        { type: 'text', text: instruction },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${imagePng.toString('base64')}` } },
      ] }],
    }),
  })
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
 * 运行 L1 双视觉审计。任何一步失败 → unavailable（可见，不静默）；成功 → passed/flagged
 * 并把完整 V1/V2 报告写进项目文档（vision-audit.md，文档面板可见）。
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
  let pair: ReturnType<typeof resolveVisionPair>
  try {
    // 必须用 raw 渠道列表：listChannels() 返回脱敏 api_key='***'，解密会得到空串（401 现场）
    pair = resolveVisionPair(listEnabledRawChannels() as unknown as ChannelLike[], decryptApiKey)
  } catch (e) {
    return { status: 'unavailable', digest: `视觉审计未执行（渠道读取失败：${(e as Error).message.slice(0, 80)}）`, note: 'channel_error' }
  }
  if (!pair) {
    return { status: 'unavailable', digest: `视觉审计未执行（缺渠道：V1=${VISION_V1_MODEL} / V2=${VISION_V2_MODEL} 需任一启用渠道含该模型）`, note: 'no_channel' }
  }
  try {
    const png = await screenshotPreview(input.previewUrl, Math.min(timeoutMs, 40_000))
    const v1 = await chatVision(pair.v1, V1_PROMPT, png, timeoutMs)
    const v2 = await chatVision(pair.v2, buildV2Prompt(v1), png, timeoutMs)
    const { digest, flagged } = digestVisionReport(v1, v2)
    writeVisionAuditDocument(input.projectId, [
      '# 视觉审计报告（L1 双视觉互证）', '',
      `> 生成：${new Date().toISOString()} | V1=${pair.v1.model}（${pair.v1.channelName}）| V2=${pair.v2.model}（${pair.v2.channelName}）`,
      `> 结论：${flagged ? 'V2 对 V1 有实质补漏/纠正' : 'V1 报告经 V2 核查无实质问题'}`, '',
      '## V1 详述', v1, '', '## V2 互证', v2, '',
    ].join('\n'))
    return { status: flagged ? 'flagged' : 'passed', digest }
  } catch (e) {
    return { status: 'unavailable', digest: `视觉审计未执行（${(e as Error).message.slice(0, 160)}）`, note: 'run_error' }
  }
}
