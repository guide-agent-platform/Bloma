import type { Browser, Page } from 'playwright'
import type { GwtTestResult, RunGwtInput } from './gwt-service'
import { readLastSketchRequirements } from './project-service'
import type { SketchRequirement } from './sketch-engine'
import { requirementAssertions, requirementStory } from './sketch-engine'
import { parseBehaviorAssertion, describeEffect, type AssertionPlan } from './behavior-assertions'

/**
 * GWT 真实执行器（A2-07 / api-spec §12.4 `run_gwt_tests`；2026-08-17 M3 重写为 per-assertion）。
 *
 * 用 Playwright chromium 无头加载预览页，**逐条行为断言**执行「模拟用户操作 → 断言状态变化」：
 * - 解析断言（behavior-assertions）：「按右方向键→车辆 x 坐标增加」→ 触发 ArrowRight 按键
 *   → 校验页面上确有元素右移（位移/显隐/条目数/文本四类效果探针）；
 * - 解析不出触发器或效果的断言（含默认断言「可见且可交互」）→ 存在性检查兜底
 *   （渲染文本含功能项故事，或页面提供交互控件），与改造前语义同构；
 * - 捕获未捕获异常（pageerror）作为「运行时报错」的失败原因。
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
  } catch {
    return null
  } finally {
    await browser.close().catch(() => undefined)
  }
}

/** 组装逐断言执行计划：每个功能项的每条 behavior_assertion 各成一个场景。 */
export function planScenarios(requirements: SketchRequirement[]): ScenarioPlan[] {
  const items = requirements.length
    ? requirements
    : [{ id: 'F-001', description: '核心功能页面可访问' }]
  return items.flatMap((item) =>
    requirementAssertions(item).map((assertion) => ({
      item,
      assertion,
      plan: parseBehaviorAssertion(assertion),
    })),
  )
}

/** 场景名：`${itemId} ${assertion}`——judge 按此前缀对账运行证据。 */
export function scenarioName(itemId: string, assertion: string): string {
  return `${itemId} ${assertion}`
}

async function executeScenarios(browser: Browser, input: RunGwtInput): Promise<GwtTestResult> {
  const scenarios = planScenarios(readLastSketchRequirements(input.project_id))

  const page = await browser.newPage()
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  const failureSummary: GwtTestResult['failure_summary'] = []
  let passedCount = 0
  try {
    await page.goto(input.preview_url!, { waitUntil: 'domcontentloaded', timeout: 10_000 })

    for (const scenario of scenarios) {
      // 每个场景独立记录运行时报错（触发后新出现的 pageerror 归属当前断言）
      const errorsBefore = pageErrors.length
      const reason = await runScenario(page, scenario)
      if (reason === undefined) {
        passedCount += 1
        continue
      }
      const runtimeError = pageErrors.length > errorsBefore ? `页面运行时报错：${pageErrors[errorsBefore]}` : undefined
      failureSummary.push({
        scenario: scenarioName(scenario.item.id, scenario.assertion),
        reason: runtimeError ?? reason,
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
  if (triggerError) return triggerError
  // 交互生效的微小等待（CSS transition / requestAnimationFrame 后再采样）
  await page.waitForTimeout(150)
  const after = await capturePageState(page)

  return checkEffect(scenario, before, after)
}

/** 页面状态快照：元素签名→位置 + 可见元素数 + 全文（效果探针的比对基础）。 */
interface PageState {
  elements: Array<{ sig: string; x: number; y: number }>
  visibleCount: number
  text: string
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
    return { elements, visibleCount, text: document.body ? document.body.innerText : '' }
  })
}

/** 派发触发器：按键派发到 document（keydown+keyup）；点击按文本/语义 class 找控件。 */
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
      const controls = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], input[type="button"], a, [class]'))
      const hit = controls.find((el) => {
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
    return after.text !== before.text ? undefined : fail('触发后页面文字没有任何变化')
  }
  return undefined
}

/** 读取渲染后的页面文本（浏览器解码/执行 JS 后的最终文本）。 */
async function readRenderedText(page: Page): Promise<string> {
  return page.evaluate(() => (document.body ? document.body.innerText : ''))
}

/** 页面是否提供可交互控件（按钮/输入框/链接/表单等）。 */
async function hasInteractiveControl(page: Page): Promise<boolean> {
  return page.evaluate(() => document.querySelector('button, input, select, textarea, a, form') !== null)
}
