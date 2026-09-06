/**
 * artifact-ui-gate.ts — L0 产物 UI 完整性硬门禁（2026-09-07，产出物审计管线固化）。
 *
 * 定位：终验链里的确定性 UI 真实性检查，**零 LLM、零提示词依赖**——判定全部来自
 * Playwright 对预览页的实测探针。案源：G-07dbf2c2「Proma 产品工作台」——整页 0 个
 * 真控件（div 伪装按钮）、点击零反应、验收断言话术印进产物页面，视觉层面完全"像
 * 一个正常界面"，单靠双视觉与文本型 GWT 断言均会漏判/假绿。
 *
 * 接线（硬约束的结构性保证）：`runGwtWithApiContract` 内与 api-contract 同款合并
 * ——初始终验与修复轮全量重验共用本函数，不存在旁路路径。失败合成 `UI-GATE` 前缀的
 * GwtFailureSummary 进入既有 repair-loop（buildRepairTasks 的 gwt 腿）与熔断口径，
 * 不新增第二套修复流。
 *
 * 边界：
 * - 判定只针对"界面是不是真的"（控件真实性/点击活性/内部信息泄漏/白屏）；
 * - console 错误、占位人设等噪声只作信息位（unverified/note），不判败——防误杀；
 * - 采集失败（导航超时等）→ `unavailable`：不判败但必须显式可见（绝不静默放行），
 *   由调用方落 unverified 供裁判与用户看见（F9a 不静默纪律）。
 */
import type { GwtFailureSummary } from '../gwt-service'
import { chromium } from 'playwright'

export interface UiProbeData {
  title: string
  bodyChars: number
  /** 真交互控件数：button/input/textarea/select/[contenteditable]/a[href]/[role=button|textbox] */
  realControls: number
  realByTag: Record<string, number>
  /** class/文本像按钮却是 div/span 的伪装控件（上限 12 条） */
  pretendWidgets: { tag: string; cls: string; text: string }[]
  /** 对按钮类元素的点击活性采样：domChanged=false 即死点击 */
  deadClicks: { text: string; clicked: boolean; domChanged: boolean }[]
  /** 命中的内部验收话术黑名单 id（不含 placeholder-persona，那是信息位） */
  leakedPatterns: string[]
  placeholderPersona: boolean
  consoleErrors: string[]
}

export interface ArtifactUiGateResult {
  status: 'passed' | 'failed' | 'unavailable' | 'skipped'
  failures: GwtFailureSummary[]
  probe?: UiProbeData
  note?: string
}

/** 内部验收话术黑名单：产物页面出现即判泄漏（断言印进产物 → 文本探针假绿的根因）。 */
export const ASSERTION_LEAK_PATTERNS: { id: string; re: RegExp }[] = [
  { id: 'assert-visible-interactive', re: /可见\s*且\s*可交互|可见且可交互/ },
  { id: 'assert-behavior-wording', re: /行为断言|该功能项在产物中/ },
  { id: 'feature-id-leak', re: /\bF-\d{3}\b/ },
  { id: 'gwt-leak', re: /\b(Given|When|Then)\b.{0,40}\b(Given|When|Then)\b/ },
]
const PLACEHOLDER_PERSONA_RE = /J\.\s*Doe|John Doe|lorem ipsum|example\.com/i

/** 紧急逃生门（对齐 BLOMA_AGENT_LOOP 口径：仅显式 '0' 关闭，缺省硬执行）。 */
export function uiGateEnabled(): boolean {
  return process.env.BLOMA_UI_GATE !== '0'
}

/** 纯判定：探针数据 → 合成失败清单（scenario 统一 `UI-GATE ` 前缀，claim 供修复卡）。 */
export function analyzeUiProbe(probe: UiProbeData): GwtFailureSummary[] {
  const failures: GwtFailureSummary[] = []

  if (probe.bodyChars < 20 && probe.realControls === 0 && probe.pretendWidgets.length === 0) {
    failures.push({
      scenario: 'UI-GATE 产物首屏不得为白屏或近空页面（可见文本、真控件、可点元素全缺）',
      reason: `bodyChars=${probe.bodyChars}，真控件 0，伪装控件 0，title="${probe.title}"`,
    })
    return failures // 白屏时控件/泄漏判定无意义，单条收口
  }

  if (probe.realControls === 0 && probe.pretendWidgets.length > 0) {
    failures.push({
      scenario: 'UI-GATE 产物界面必须包含真交互控件（button/input/textarea/select/contenteditable/带 href 链接），禁止 div/span 伪装按钮',
      reason: `真控件 0 个；伪装控件 ${probe.pretendWidgets.length} 个：${probe.pretendWidgets.map((w) => `<${w.tag} class="${w.cls}">${w.text}</${w.tag}>`).join('、').slice(0, 300)}`,
    })
  } else if (probe.realControls === 0 && probe.pretendWidgets.length === 0) {
    failures.push({
      scenario: 'UI-GATE 产物界面必须包含真交互控件（button/input/textarea/select/contenteditable/带 href 链接）',
      reason: '真控件 0 个且无任何可点元素——纯静态展示页不构成软件',
    })
  }

  const actionable = probe.deadClicks.filter((d) => d.clicked)
  if (actionable.length > 0 && actionable.every((d) => !d.domChanged) && probe.realControls === 0) {
    failures.push({
      scenario: 'UI-GATE 按钮类控件点击必须产生可见界面变化（DOM 变更或导航）',
      reason: `真控件 0 且采样点击 ${actionable.length} 个按钮类元素（${actionable.map((d) => d.text).join('、').slice(0, 120)}）全部无任何反应`,
    })
  }

  if (probe.leakedPatterns.length > 0) {
    failures.push({
      scenario: 'UI-GATE 验收断言与内部需求信息不得出现在产物界面（泄漏会让文本型 GWT 探针假绿，并把内部编号暴露给用户）',
      reason: `命中黑名单：${probe.leakedPatterns.join('、')}`,
    })
  }

  return failures
}

/** 信息位（不判败，进 unverified 让裁判/用户看见）：死点击嫌疑/占位人设/console 错误。 */
export function uiProbeNotes(probe: UiProbeData): string[] {
  const notes: string[] = []
  const actionable = probe.deadClicks.filter((d) => d.clicked)
  if (actionable.length > 0 && actionable.every((d) => !d.domChanged) && probe.realControls > 0) {
    notes.push(`疑似死点击：${actionable.length} 个按钮类采样全部无 DOM 变化（${actionable.map((d) => d.text).join('、').slice(0, 120)}）`)
  }
  if (probe.placeholderPersona) notes.push('产物含占位人设/示例域名（J. Doe、lorem、example.com 等），疑似模板残留')
  if (probe.consoleErrors.length > 0) notes.push(`页面存在 ${probe.consoleErrors.length} 条控制台错误（外链 404 等噪声不判败，供裁判参考）`)
  return notes
}

/** 探针页内脚本（与 evaluate 交互的唯一桥；返回 UiProbeData 主体）。 */
function collectProbeInPage(): Promise<Omit<UiProbeData, 'deadClicks'>> {
  const q = (s: string) => Array.from(document.querySelectorAll(s))
  const real = q('button, input, textarea, select, [contenteditable="true"], a[href]:not([href="#"]), [role="button"], [role="textbox"]')
  const realByTag: Record<string, number> = {}
  for (const el of real) {
    const tag = el.tagName.toLowerCase()
    realByTag[tag] = (realByTag[tag] || 0) + 1
  }
  const pretend = q('div, span, li, p').filter((el) => {
    const cn = String((el as HTMLElement).className || '')
    if (!/btn|button|submit|action/i.test(cn)) return false
    const t = (el.textContent || '').trim()
    return t.length > 0 && t.length < 24 && !real.includes(el)
  }).slice(0, 12).map((el) => ({
    tag: el.tagName.toLowerCase(),
    cls: String((el as HTMLElement).className || '').slice(0, 60),
    text: (el.textContent || '').trim().slice(0, 24),
  }))
  const bodyText = (document.body?.innerText || '')
  return Promise.resolve({
    title: document.title || '',
    bodyChars: bodyText.trim().length,
    realControls: real.length,
    realByTag,
    pretendWidgets: pretend,
    leakedPatterns: [],
    placeholderPersona: /J\.\s*Doe|John Doe|lorem ipsum|example\.com/i.test(bodyText),
    consoleErrors: [],
  })
}

/**
 * 运行 L0 门禁：导航预览页 → 采集探针 → 点击活性采样 → 黑名单扫描 → 纯判定。
 * 全程限时（缺省 25s），任何采集异常 → status='unavailable'（调用方负责可见化）。
 */
export async function runArtifactUiGate(input: {
  previewUrl: string
  timeoutMs?: number
  clickSampleLimit?: number
}): Promise<ArtifactUiGateResult> {
  if (!uiGateEnabled()) return { status: 'skipped', failures: [] }
  const timeoutMs = input.timeoutMs ?? 25_000
  const clickLimit = input.clickSampleLimit ?? 6

  let browser
  try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const consoleErrors: string[] = []
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)) })
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e.message).slice(0, 160)}`))

    await page.goto(input.previewUrl, { waitUntil: 'load', timeout: timeoutMs })
    await page.waitForTimeout(1200) // 首屏水合/settle 窗口

    const base = await page.evaluate(collectProbeInPage)

    // 泄漏扫描在页外做（黑名单正则是本模块资产，不注入页面）
    const bodyTextForLeakScan = await page.evaluate(() => document.body?.innerText || '')
    const leakedPatterns = ASSERTION_LEAK_PATTERNS.filter((p) => p.re.test(bodyTextForLeakScan)).map((p) => p.id)

    // 点击活性采样：优先伪装控件，其次按钮类真控件
    const candidates = [...base.pretendWidgets.map((w) => w.text), ...await page.$$eval(
      'button, [role="button"], a[href]:not([href="#"])',
      (els) => els.map((e) => (e.textContent || '').trim()).filter((t) => t.length > 0 && t.length < 24),
    )]
    const deadClicks: { text: string; clicked: boolean; domChanged: boolean }[] = []
    let sampled = 0
    for (const text of candidates) {
      if (sampled >= clickLimit) break
      const el = await page.$(`text="${text}"`)
      if (!el) continue
      const before = await page.evaluate(() => (document.body?.innerHTML || '').length)
      const errBefore = consoleErrors.length
      await el.click({ timeout: 1500 }).catch(() => {})
      await page.waitForTimeout(450)
      const after = await page.evaluate(() => (document.body?.innerHTML || '').length)
      const navigated = page.url() !== input.previewUrl.replace(/\/$/, '')
      deadClicks.push({ text, clicked: true, domChanged: after !== before || navigated || consoleErrors.length > errBefore })
      sampled++
      if (navigated) break // 导航后页面已换，采样终止（视为有反应）
    }

    await browser.close()
    const probe: UiProbeData = { ...base, leakedPatterns, consoleErrors: consoleErrors.slice(0, 8), deadClicks }
    const failures = analyzeUiProbe(probe)
    return { status: failures.length > 0 ? 'failed' : 'passed', failures, probe }
  } catch (e) {
    try { await browser?.close() } catch { /* 尽力回收 */ }
    return { status: 'unavailable', failures: [], note: `UI 门禁探针失败：${(e as Error).message.slice(0, 200)}` }
  }
}
