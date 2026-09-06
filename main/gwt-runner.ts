import type { Browser, Page } from 'playwright'
import type { GwtTestResult, RunGwtInput } from './gwt-service'
import { readLastSketchRequirements } from './project-service'
import type { SketchRequirement } from './sketch-engine'
import { requirementAssertions, requirementStory, isPlaceholderAssertion } from './sketch-engine'
import { parseBehaviorAssertion, describeEffect, type AssertionPlan } from './behavior-assertions'
import { replayRequirements } from './experience/replay-compiler'

/**
 * GWT 真实执行器（A2-07 / api-spec §12.4 `run_gwt_tests`；2026-08-17 M3 重写为 per-assertion）。
 *
 * 用 Playwright chromium 无头加载预览页，**逐条行为断言**执行「模拟用户操作 → 断言状态变化」：
 * - 解析断言（behavior-assertions）：「按右方向键→车辆 x 坐标增加」→ 触发 ArrowRight 按键
 *   → 校验页面上确有元素右移（位移/显隐/条目数/文本四类效果探针）；
 * - 解析不出触发器或效果的断言（含默认断言「可见且可交互」）→ 存在性检查兜底
 *   （渲染文本含功能项故事，或页面提供交互控件），与改造前语义同构；
 * - 捕获页面诊断（pageerror 运行时报错 / console error·warning / requestfailed 资源
 *   加载失败）：**只附加到失败场景的原因里，不改变通过/失败判定**——通过的场景
 *   即使有 console 噪音也判过，防误杀（随感 39 诊断补盲）。
 *
 * 优雅降级：Playwright 不可导入 / chromium 未安装 / 启动失败 / 导航失败，一律返回
 * `null`，交由 gwt-service 的静态启发式兜底，绝不阻断测试链路。浏览器可用性首次失败
 * 后缓存，避免后续每次修复验证都重复尝试启动。
 */

let browserAvailable: boolean | undefined

/**
 * 测试 seam：单测固定走 gwt-service 的静态兜底路径（模拟 chromium 不可用）。
 * 这些用例的 mock 产物只喂静态词表、无真实交互元素，真探针会误判失败；
 * 与 sandbox 的 setSandboxRuntimeForTests 同一模式。
 */
let disabledForTests = false
export function setBrowserGwtDisabledForTests(disabled: boolean): void {
  disabledForTests = disabled
}

/** 单条断言的执行计划（含所属功能项，供场景命名与裁判对账）。 */
interface ScenarioPlan {
  item: SketchRequirement
  assertion: string
  plan: AssertionPlan
}

export async function runBrowserGwt(input: RunGwtInput): Promise<GwtTestResult | null> {
  if (disabledForTests) return null
  if (browserAvailable === false) return null
  if (!input.preview_url) return null

  let browser: Browser | undefined
  try {
    // 动态导入：playwright 不进 esbuild 主进程 bundle（见 package.json build:main --external:playwright）
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
  } catch {
    browserAvailable = false
    return null
  }

  browserAvailable = true
  try {
    return await executeScenarios(browser, input)
  } catch (error) {
    // m-10：探针异常降级静态兑底必须留痕（对齐「模板回退必须留痕」纪律——
    // 此前静默 return null，降级事实无任何观测点）
    console.error('[gwt-runner] 浏览器探针异常，降级静态兑底：', error)
    return null
  } finally {
    await browser.close().catch(() => undefined)
  }
}

/** 组装逐断言执行计划：每个功能项的每条「真实」behavior_assertion 各成一个场景。
 *  P1-6：占位断言（「可见且可交互」类存在性泛化）不派生独立场景——同一功能项多条占位
 *  断言派生的 presenceFallback 场景完全同构、纯冗余，虚增 total_count 制造「N/N 全绿」假象。
 *  只保留真实行为断言；全部占位则保留一条最低档存在性回退（「至少有个入口」门槛仍在）。 */
export function planScenarios(requirements: SketchRequirement[]): ScenarioPlan[] {
  const items = requirements.length
    ? requirements
    : [{ id: 'F-001', description: '核心功能页面可访问' }]
  return items.flatMap((item) => {
    const assertions = requirementAssertions(item)
    const real = assertions.filter((assertion) => !isPlaceholderAssertion(assertion))
    const effective = real.length > 0 ? real : assertions.slice(0, 1)
    return effective.map((assertion) => ({
      item,
      assertion,
      plan: parseBehaviorAssertion(assertion),
    }))
  })
}

/** 场景名：`${itemId} ${assertion}`——judge 按此前缀对账运行证据。 */
export function scenarioName(itemId: string, assertion: string): string {
  return `${itemId} ${assertion}`
}

/** 页面诊断采集（随感 39 补盲）：pageerror / console error·warning / requestfailed 三路。 */
export interface PageDiagnostics {
  pageErrors: string[]
  consoleErrors: string[]
  requestFailures: string[]
}

/** 诊断计数快照（per-scenario 差值归属的基准）。 */
export interface DiagnosticsSnapshot {
  pageErrors: number
  consoleErrors: number
  requestFailures: number
}

/** 每类诊断的采集上限（防超大页面把失败原因淹没）。 */
const DIAGNOSTICS_LIMIT = 20

/**
 * 挂接页面诊断采集：三类事件各自计入独立数组，超上限丢弃（先到先得）。
 * console 只采 error / warning；文本截 200 字符；URL 截 120 字符。
 */
export function attachPageDiagnostics(page: Page): PageDiagnostics {
  const diag: PageDiagnostics = { pageErrors: [], consoleErrors: [], requestFailures: [] }
  page.on('pageerror', (error) => {
    if (diag.pageErrors.length < DIAGNOSTICS_LIMIT) diag.pageErrors.push(error.message)
  })
  page.on('console', (msg) => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return
    const text = msg.text().slice(0, 200)
    if (diag.consoleErrors.length < DIAGNOSTICS_LIMIT) diag.consoleErrors.push(`[${msg.type()}] ${text}`)
  })
  page.on('requestfailed', (req) => {
    const failure = req.failure()?.errorText ?? 'failed'
    if (diag.requestFailures.length < DIAGNOSTICS_LIMIT)
      diag.requestFailures.push(`${req.url().slice(0, 120)}（${failure}）`)
  })
  return diag
}

export function snapshotDiagnostics(d: PageDiagnostics): DiagnosticsSnapshot {
  return {
    pageErrors: d.pageErrors.length,
    consoleErrors: d.consoleErrors.length,
    requestFailures: d.requestFailures.length,
  }
}

/** 快照之后新增的诊断（归属当前场景），按 页面报错→控制台→资源失败 排序。 */
export function newDiagnosticsSince(d: PageDiagnostics, s: DiagnosticsSnapshot): string[] {
  return [
    ...d.pageErrors.slice(s.pageErrors).map((t) => `页面运行时报错：${t}`),
    ...d.consoleErrors.slice(s.consoleErrors).map((t) => `控制台输出：${t}`),
    ...d.requestFailures.slice(s.requestFailures).map((t) => `资源加载失败：${t}`),
  ]
}

/**
 * 失败原因拼装：诊断只是附加信息（最多 3 条），原失败原因保持前缀不变——
 * 这也是「诊断不改变判定」的语义锚点（通过的场景根本不会走到这里）。
 */
export function composeFailureReason(reason: string, extra: string[]): string {
  if (extra.length === 0) return reason
  return `${reason}\n附带诊断（最多 3 条）：\n- ${extra.slice(0, 3).join('\n- ')}`
}

/**
 * 单场景结局归约（executeScenarios 接线点，可单测）：
 * 通过的场景即使有诊断噪音也判过（防误杀锚点）；失败的场景拼 ≤3 条附加诊断。
 */
export function evaluateScenarioOutcome(
  reason: string | undefined,
  diagnostics: PageDiagnostics,
  before: DiagnosticsSnapshot,
): string | undefined {
  if (reason === undefined) return undefined
  return composeFailureReason(reason, newDiagnosticsSince(diagnostics, before))
}

async function executeScenarios(browser: Browser, input: RunGwtInput): Promise<GwtTestResult> {
  const scenarios = planScenarios([...readLastSketchRequirements(input.project_id), ...replayRequirements(input.project_id)])

  const page = await browser.newPage()
  const diagnostics = attachPageDiagnostics(page)

  const failureSummary: GwtTestResult['failure_summary'] = []
  let passedCount = 0
  try {
    // ?mock=1（完整程序渠道，2026-09-06）：AI 功能经 /api/llm 的确定性 mock 应答收口——
    // 探针不消耗真实模型调用、不受网络/延迟抖动影响；用户正常访问（无 mock 参数）走真实调用
    const probedUrl = new URL(input.preview_url!)
    probedUrl.searchParams.set('mock', '1')
    await page.goto(probedUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 10_000 })

    for (const scenario of scenarios) {
      // 每个场景独立快照（触发后新出现的诊断归属当前断言）；结局归约统一走
      // evaluateScenarioOutcome（诊断只附加不替换，不改通过/失败判定）
      const before = snapshotDiagnostics(diagnostics)
      const reason = evaluateScenarioOutcome(await runScenario(page, scenario), diagnostics, before)
      if (reason === undefined) {
        passedCount += 1
        continue
      }
      failureSummary.push({
        scenario: scenarioName(scenario.item.id, scenario.assertion),
        reason,
      })
    }

    return {
      total_count: scenarios.length,
      passed_count: passedCount,
      failed_count: scenarios.length - passedCount,
      failure_summary: failureSummary,
    }
  } finally {
    await page.close().catch(() => undefined)
  }
}

/**
 * 执行单条断言场景。返回 undefined = 通过；返回字符串 = 失败原因（P0 可读）。
 * 行为探针失败的原因要写明「触发→预期效果→实际」三层，供裁判退回与修复定位。
 */
async function runScenario(page: Page, scenario: ScenarioPlan): Promise<string | undefined> {
  if (scenario.plan.presenceFallback || !scenario.plan.trigger || !scenario.plan.effect) {
    // 存在性兜底（默认断言/无法解析）：渲染文本含功能项故事，或页面提供交互控件
    const renderedText = await readRenderedText(page)
    const hasControl = await hasInteractiveControl(page)
    if (renderedText.includes(requirementStory(scenario.item)) || hasControl) return undefined
    return `页面缺少功能入口：${requirementStory(scenario.item)}`
  }

  const before = await capturePageState(page)
  const triggerError = await dispatchTrigger(page, scenario.plan.trigger)
  if (triggerError) {
    // C4：找不到控件时附页面实际清单——模型可直接判断该改控件文案还是补控件
    const inventory = await collectControlInventory(page)
    return inventory ? `${triggerError}；探针视角：${inventory}` : triggerError
  }
  // 交互生效的微小等待（CSS transition / requestAnimationFrame 后再采样）
  await page.waitForTimeout(150)
  const after = await capturePageState(page)

  const failed = checkEffect(scenario, before, after)
  if (!failed) return undefined
  // C4：断言未满足时附触发执行事实与前后状态 + 控件清单（消除探针黑盒盲猜）
  const trigger = scenario.plan.trigger
  const targetDesc = !trigger
    ? '（无触发解析）'
    : trigger.kind === 'key'
      ? `按键「${trigger.key ?? ''}」已派发`
      : `目标「${trigger.target ?? ''}」已执行`
  const inventory = await collectControlInventory(page)
  return `${failed}（触发状态：${targetDesc}；可见元素 ${before.visibleCount}→${after.visibleCount}${inventory ? `；探针视角：${inventory}` : ''}）`
}

/** 探针视角清单（C4，2026-09-03）：失败原因附页面实际控件/输入框清单——线上案例
 * （058c86a3）：编程 Agent 看不到探针内部，为猜「保存」控件为何不命中烧掉 24 轮。
 * 清单直接展示探针能看见什么，把盲猜变成对账。失败路径才采集（通过零开销）。 */
async function collectControlInventory(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => {
      // P0-1（2026-09-04）：探针视角清单只展示「真可见」控件——此前把 display:none 隐藏
      // overlay 里的按钮（继续/放弃本局…）也列入可点击清单，F-005「点击暂停→菜单显示」
      // 因此三连假失败（探针视角 69→69 恒不变，模型盲修 3 轮）。可见性判据与 capturePageState
      // 的「可见元素计数」同口径：非零尺寸 + 非 hidden/none + 非零透明度。
      const isVisible = (el: Element): boolean => {
        const rect = el.getBoundingClientRect()
        const style = window.getComputedStyle(el)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0
      }
      const clickables = Array.from(
        document.querySelectorAll<HTMLElement>('button, [role="button"], a, input[type="button"]'),
      )
        .filter(isVisible)
        .map((el) => ((el.textContent ?? '').trim() || el.getAttribute('value') || '').trim())
        .filter(Boolean)
        .slice(0, 8)
      const fields = Array.from(
        document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'),
      )
        .filter((el) => !['button', 'submit', 'checkbox', 'radio', 'file'].includes((el.getAttribute('type') || 'text').toLowerCase()))
        .slice(0, 6)
        .map((el) => el.id || el.name || el.getAttribute('placeholder') || '未命名输入框')
      const clickText = clickables.map((t) => `「${t.slice(0, 12)}」`).join('') || '（无）'
      const fieldText = fields.join('、') || '（无）'
      return `可点击控件：${clickText}；输入框：${fieldText}`
    })
  } catch {
    return ''
  }
}

/** 页面状态快照：元素签名→位置 + 可见元素数 + 全文 + 输入框值（效果探针的比对基础）。 */
interface PageState {
  elements: Array<{ sig: string; x: number; y: number }>
  visibleCount: number
  text: string
  /** 所有 input/textarea 的 value 拼接（fill 触发后的 text-change 断言比对，M-4） */
  inputValues: string
}

async function capturePageState(page: Page): Promise<PageState> {
  return page.evaluate(() => {
    const elements: Array<{ sig: string; x: number; y: number }> = []
    let visibleCount = 0
    const all = document.querySelectorAll<HTMLElement>('*')
    // 上限采样（防超大 DOM 把探针拖垮）
    for (let index = 0; index < all.length && index < 500; index += 1) {
      const el = all[index]
      const rect = el.getBoundingClientRect()
      const style = window.getComputedStyle(el)
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0
      if (visible) visibleCount += 1
      const sig = `${el.tagName}.${el.className && typeof el.className === 'string' ? el.className : ''}#${(el.textContent ?? '').slice(0, 24)}@${Math.round(rect.width)}x${Math.round(rect.height)}`
      elements.push({ sig, x: Math.round(rect.left), y: Math.round(rect.top) })
    }
    const fields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'))
    const inputValues = fields.map((el) => el.value).join('|').slice(0, 2000)
    return { elements, visibleCount, text: document.body ? document.body.innerText : '', inputValues }
  })
}

/** 派发触发器：按键派发到 document（keydown+keyup）；点击/双击按文本或语义 class 找控件；
 *  fill/select 为 M-4 新增可探针类（输入框填值派发 input+change、下拉切换选项）。 */
async function dispatchTrigger(page: Page, trigger: AssertionPlan['trigger']): Promise<string | undefined> {
  if (!trigger) return undefined
  if (trigger.kind === 'key' && trigger.key) {
    await page.evaluate((key) => {
      for (const type of ['keydown', 'keyup'] as const) {
        document.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true }))
        document.activeElement?.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true }))
      }
    }, trigger.key)
    return undefined
  }
  if (trigger.kind === 'click' && trigger.target) {
    const clicked = await page.evaluate((target) => {
      // P0-1：点击匹配同样只认真可见控件——隐藏 overlay 的「继续/放弃」按钮不再抢跑命中，
      // 保证「点击暂停」真正点到可见的暂停按钮（否则点中 display:none 控件 = 无效果 = 假失败）。
      const isVisible = (el: Element): boolean => {
        const rect = el.getBoundingClientRect()
        const style = window.getComputedStyle(el)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0
      }
      const controls = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], input[type="button"], a, [class]'))
      const hit = controls.find((el) => {
        if (!isVisible(el)) return false
        const text = (el.textContent ?? '').trim()
        const cls = typeof el.className === 'string' ? el.className : ''
        return (text.length > 0 && text.includes(target)) || cls.includes(target)
      })
      if (!hit) return false
      hit.click()
      return true
    }, trigger.target)
    if (!clicked) return `找不到可点击的「${trigger.target}」控件，断言无法执行`
    return undefined
  }
  if (trigger.kind === 'dblclick' && trigger.target) {
    const hit = await page.evaluate((target) => {
      const isVisible = (el: Element): boolean => {
        const rect = el.getBoundingClientRect()
        const style = window.getComputedStyle(el)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0
      }
      const controls = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], a, li, tr, [class]'))
      const hit = controls.find((el) => {
        if (!isVisible(el)) return false
        const text = (el.textContent ?? '').trim()
        const cls = typeof el.className === 'string' ? el.className : ''
        return (text.length > 0 && text.includes(target)) || cls.includes(target)
      })
      if (!hit) return false
      hit.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      return true
    }, trigger.target)
    if (!hit) return `找不到可双击的「${trigger.target}」目标，断言无法执行`
    return undefined
  }
  if (trigger.kind === 'fill' && trigger.target) {
    // a8c7d17d 次级发现①：fill 值从固定「测试输入」改为触发器语义提取（trigger.value，
    // 缺省仍固定值）——「输入关键词→显示匹配项」类断言需要值与效果语义对齐才能命中
    const fillValue = trigger.value || '测试输入'
    const filled = await page.evaluate(([target, value]) => {
      const fields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')).filter((el) => {
        const type = (el.getAttribute('type') || 'text').toLowerCase()
        return type !== 'button' && type !== 'submit' && type !== 'checkbox' && type !== 'radio' && type !== 'file'
      })
      const generic = target === 'input'
      const hit = fields.find((el) => {
        const hint = `${el.id} ${el.name} ${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('aria-label') ?? ''} ${typeof el.className === 'string' ? el.className : ''}`
        return generic || hint.includes(target) || (el.textContent ?? '').includes(target)
      })
      if (!hit) return false
      hit.focus()
      hit.value = value
      hit.dispatchEvent(new Event('input', { bubbles: true }))
      hit.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }, [trigger.target, fillValue] as [string, string])
    if (!filled) return `找不到可输入的「${trigger.target}」输入框，断言无法执行`
    return undefined
  }
  if (trigger.kind === 'select' && trigger.target) {
    const picked = await page.evaluate((target) => {
      const selects = Array.from(document.querySelectorAll<HTMLSelectElement>('select'))
      if (selects.length === 0) return false
      const hit = selects.find((el) => {
        const hint = `${el.id} ${el.name} ${el.getAttribute('aria-label') ?? ''} ${el.previousElementSibling && el.previousElementSibling.textContent ? el.previousElementSibling.textContent : ''}`
        return hint.includes(target)
      }) ?? selects[0]!
      if (hit.options.length === 0) return false
      const next = Array.from(hit.options).find((option) => option.value !== hit.value) ?? hit.options[0]!
      hit.value = next.value
      hit.dispatchEvent(new Event('input', { bubbles: true }))
      hit.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }, trigger.target)
    if (!picked) return `找不到可选择的「${trigger.target}」下拉控件，断言无法执行`
    return undefined
  }
  return undefined
}

/** 效果探针：按效果种类比对前后状态。返回失败原因或 undefined（通过）。 */
function checkEffect(scenario: ScenarioPlan, before: PageState, after: PageState): string | undefined {
  const { effect, trigger, assertion } = scenario.plan
  if (!effect || !trigger) return undefined
  const expected = describeEffect(effect)
  const fail = (actual: string): string => `断言未满足：${assertion}（预期${expected}，实际${actual}）`

  const afterBySig = new Map<string, { x: number; y: number }>()
  for (const el of after.elements) {
    if (!afterBySig.has(el.sig)) afterBySig.set(el.sig, { x: el.x, y: el.y })
  }

  if (effect.kind === 'move-right' || effect.kind === 'move-left') {
    const minDelta = 2
    let moved = false
    for (const el of before.elements) {
      const next = afterBySig.get(el.sig)
      if (!next) continue
      const delta = next.x - el.x
      if (effect.kind === 'move-right' && delta >= minDelta) moved = true
      if (effect.kind === 'move-left' && delta <= -minDelta) moved = true
    }
    return moved ? undefined : fail('触发后没有任何元素发生水平位移')
  }
  if (effect.kind === 'move-up' || effect.kind === 'move-down') {
    const minDelta = 2
    let moved = false
    for (const el of before.elements) {
      const next = afterBySig.get(el.sig)
      if (!next) continue
      const delta = next.y - el.y
      if (effect.kind === 'move-down' && delta >= minDelta) moved = true
      if (effect.kind === 'move-up' && delta <= -minDelta) moved = true
    }
    return moved ? undefined : fail('触发后没有任何元素发生垂直位移')
  }
  if (effect.kind === 'hide') {
    const disappeared = before.elements.some((el) => !afterBySig.has(el.sig))
    return disappeared ? undefined : fail('触发后没有元素消失或隐藏')
  }
  if (effect.kind === 'show') {
    const appeared = after.elements.some((el) => !before.elements.some((b) => b.sig === el.sig))
    return appeared ? undefined : fail('触发后没有新元素出现')
  }
  if (effect.kind === 'add-item') {
    return after.visibleCount > before.visibleCount ? undefined : fail('触发后页面可见元素数没有增加')
  }
  if (effect.kind === 'text-change') {
    // 比对含输入框 value（M-4）：fill 触发的「输入内容更新」类断言不落在 body.innerText
    return after.text !== before.text || after.inputValues !== before.inputValues
      ? undefined
      : fail('触发后页面文字没有任何变化')
  }
  return undefined
}

/** 读取渲染后的页面文本（浏览器解码/执行 JS 后的最终文本）。 */
async function readRenderedText(page: Page): Promise<string> {
  return page.evaluate(() => (document.body ? document.body.innerText : ''))
}

/** 页面是否提供可交互控件（按钮/输入框/链接/表单等）。P0-1：只认真可见控件，
 *  隐藏 overlay 里的控件不计——避免「存在性兜底」被 display:none 的假控件骗过。 */
async function hasInteractiveControl(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const isVisible = (el: Element): boolean => {
      const rect = el.getBoundingClientRect()
      const style = window.getComputedStyle(el)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0
    }
    return Array.from(document.querySelectorAll('button, input, select, textarea, a, form')).some(isVisible)
  })
}
