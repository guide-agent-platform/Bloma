/**
 * GWT steps 架构 v2（2026-09-26 审计修复批：P0-01 假绿根治）。
 * v1（92ec4c3 照抄 Proma-Easy GwtStep schema）的教训：清空/删除/撤销统一编译成
 * `fill 123 → click → 页面包含 0` —— no-op 清空按钮也判 PASS（审计反例
 * broken-clear-keypad-zero），且首个可见输入框可能与触发控件不同域（房贷案）。
 * v2 契约（审计 P0-01 机制改动直译）：
 * 1. 清空/重置族：运行时自适应种入（数字键盘≥2 → 按键种入显示区；否则填输入域并
 *    记录初值），断言绑定**种入域**回到初始/零态——不是页面包含 0。
 * 2. 删除/撤销族：当前规则编译器无法构造可靠前置与精确谓词 → mapping 阻断
 *    （fail-closed：不放行、不冒充 product 失败烧预算；挂账 steps LLM 编译器）。
 * 3. 未实现 op（press/assert-visible/未知）：显式失败，禁止循环后默认通过。
 * 4. 种入必须证明生效（输入值=123 / 显示区出现 123），否则 precondition——
 *    构造不出前态的断言不可自动验证，但绝不静默通过。
 */
import type { Page } from 'playwright'
import { collectControlSnapshots, findClickableIndex, visibleControlInventory } from './gwt-runner'

// =========================================================================
// steps 架构（GwtStep schema 沿用 92ec4c3；编译与执行语义按审计 P0-01 重写）
// =========================================================================

/** op 白名单 v2（v1 三件 + 种入/精确重置断言两个 typed op）。 */
export type StepOpType = 'fill' | 'click' | 'press' | 'assert-text' | 'assert-visible' | 'seed-state' | 'assert-reset'

/** 单步操作。target 走 findClickableIndex 多信号语义匹配（与单步快路径同构）。 */
export interface StepOp {
  type: StepOpType
  /** 语义目标 */
  target?: string
  /** fill 值 / press 键名 / seed-state 种子值 */
  value?: string
  /** assert-text 期望包含文本（遗留 op：非绑定断言，仅兼容保留） */
  contains?: string
}

/** 三段式步骤（given 种入 / when 触发 / then 精确断言）。 */
export interface GwtStep {
  kind: 'given' | 'when' | 'then'
  text: string
  op: StepOp
}

/**
 * 失败归类 v2：product=产品类（进修复轮）；precondition=前置缺失（不可自动验证，
 * 不烧修复预算）；selector=映射类（找不到控件，失败原因带控件清单——修复轮处理）；
 * mapping=编译器无法构造可靠步骤（删除/撤销族、未实现 op）——不烧预算不放行，
 * 与 precondition 同属「测试侧能力缺口」而非产品缺陷（审计 P1-03 failure_domain 雏形）。
 */
export type StepFailureKind = 'product' | 'precondition' | 'selector' | 'mapping'

/** 步骤路径失败（reason 供裁判/修复轮定位，kind 供预算分流）。 */
export interface StepFailure {
  reason: string
  kind: StepFailureKind
}

/** 状态转换族意图分类：clear（清空/重置）/ delete（删除）/ undo（撤销）。 */
export type ResetIntent = 'clear' | 'delete' | 'undo'

/** 状态转换族断言判定（路由用）：四族全部进入 steps 路径（delete/undo 诚实阻断）。 */
const STATE_RESET_ASSERTION_RE = /清空|归零|重置|清零|清除|删除|撤销|恢复初始/

export function needsStepCompilation(assertion: string): boolean {
  return STATE_RESET_ASSERTION_RE.test(assertion)
}

/** 意图分类（判定顺序：撤销/删除先于清空——「删除」同时命中清空词表时以更具体的为准）。 */
export function classifyResetIntent(assertion: string): ResetIntent | null {
  if (/撤销|撤回/.test(assertion)) return 'undo'
  if (/删除|移除|去掉/.test(assertion)) return 'delete'
  if (/清空|归零|重置|清零|清除|恢复初始|回到初始/.test(assertion)) return 'clear'
  return null
}

/** 编译结果：compiled=可执行三段式；mapping_blocked=无法可靠编译（fail-closed 阻断）。 */
export type ResetCompilation =
  | { status: 'compiled'; intent: ResetIntent; steps: GwtStep[] }
  | { status: 'mapping_blocked'; intent: ResetIntent | null; reason: string }

/**
 * 规则编译器 v2：按意图分流。
 * - clear：三段式（seed-state 种入 → click 触发 → assert-reset 绑定种入域的精确断言）。
 * - delete/undo：mapping_blocked——删除需绑定具体记录项、撤销需构造两步前态，
 *   规则编译器无法给出可靠谓词；生成通用替代断言（v1 的「页面包含 0」）是假绿来源，
 *   明令禁止。后续由 steps LLM 编译器补齐（schema 已对齐，零结构改动挂账）。
 */
export function compileResetSteps(assertion: string, target: string | undefined): ResetCompilation {
  const intent = classifyResetIntent(assertion)
  if (intent === null) {
    return { status: 'mapping_blocked', intent: null, reason: `断言「${assertion}」命中状态转换族路由但无法分类意图——不生成通用替代断言` }
  }
  if (intent === 'delete') {
    return {
      status: 'mapping_blocked',
      intent,
      reason: `删除类断言「${assertion}」需要绑定具体记录项（前置构造+消失谓词），当前规则编译器无法可靠映射——需 steps LLM 编译器；本条不计为产品缺陷、不烧修复预算`,
    }
  }
  if (intent === 'undo') {
    return {
      status: 'mapping_blocked',
      intent,
      reason: `撤销类断言「${assertion}」需要两步前态与回退谓词，当前规则编译器无法可靠映射——需 steps LLM 编译器；本条不计为产品缺陷、不烧修复预算`,
    }
  }
  return {
    status: 'compiled',
    intent,
    steps: [
      { kind: 'given', text: '种入状态 123（有数字键盘则按键种入显示区，否则填入输入域并记录初值）', op: { type: 'seed-state', value: '123' } },
      { kind: 'when', text: `执行触发：${target ?? ''}`, op: { type: 'click', target: target ?? '' } },
      { kind: 'then', text: '种入域回到初始/零态（清空生效——绑定种入域的精确谓词，非页面包含 0）', op: { type: 'assert-reset' } },
    ],
  }
}

/** 种入域上下文（seed-state 采集，assert-reset 消费；同一次 runStepScenario 内传递）。 */
interface SeedContext {
  mode: 'input' | 'keypad'
  seedValue: string
  /** input 模式：种入前的初始值（清空应回到 '' 或该值或零态）。 */
  initialValue: string
}

/**
 * 多步执行器 v2：顺序执行 given/when，then 精确断言。返回 undefined=通过。
 * 未实现/未知 op 显式失败（fail-closed）——v1 循环后默认通过是审计反例
 * declared-ops-not-executed 的假绿来源。
 */
export async function runStepScenario(page: Page, steps: GwtStep[]): Promise<StepFailure | undefined> {
  let seed: SeedContext | undefined
  for (const step of steps) {
    if (step.op.type === 'seed-state') {
      const seeded = await seedState(page, step.op.value ?? '123')
      if (typeof seeded === 'string') return { reason: `前置步骤失败（${step.text}）：${seeded}`, kind: 'precondition' }
      seed = seeded
      continue
    }
    if (step.op.type === 'fill') {
      const filled = await fillFirstVisibleInput(page, step.op.value ?? '123')
      if (!filled) {
        return { reason: `前置步骤失败（${step.text}）：页面没有可见可输入域——本断言需要先有输入再触发，当前不可自动验证`, kind: 'precondition' }
      }
      continue
    }
    if (step.op.type === 'click') {
      const snapshots = await collectControlSnapshots(page, 'button, [role="button"], input[type="button"], a, [class]')
      const hitIndex = findClickableIndex(snapshots, step.op.target ?? '')
      if (hitIndex < 0) {
        const inventory = visibleControlInventory(snapshots)
        return {
          reason: `触发步骤失败（${step.text}）：找不到可点击的「${step.op.target ?? ''}」控件${inventory.length > 0 ? `；页面可见控件：${inventory.join('、')}` : '；页面无可见可点击控件'}`,
          kind: 'selector',
        }
      }
      await page.evaluate((index) => {
        const controls = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], input[type="button"], a, [class]'))
        controls[index]?.click()
      }, hitIndex)
      await page.waitForTimeout(150)
      continue
    }
    if (step.op.type === 'assert-reset') {
      if (!seed) {
        return { reason: `断言步骤失败（${step.text}）：缺少种入上下文（seed-state 未执行）——无法构造精确断言`, kind: 'precondition' }
      }
      await page.waitForTimeout(300)
      return assessReset(page, seed)
    }
    if (step.op.type === 'assert-text') {
      await page.waitForTimeout(300)
      const text = await readRenderedText(page)
      const inputs = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')).map((el) => el.value).join(' '),
      )
      const contains = step.op.contains ?? '0'
      if (text.includes(contains) || inputs.includes(contains)) return undefined
      return { reason: `断言未满足（${step.text}）：前置已填充并触发成功，但页面与输入值均不含「${contains}」（页面文本片段：${text.slice(0, 120).replace(/\s+/g, ' ')}）`, kind: 'product' }
    }
    // press / assert-visible / 未知 op：显式失败（fail-closed），不默认通过
    return {
      reason: `步骤「${step.text}」的 op「${step.op.type}」未在执行器实现——拒绝默认通过（fail-closed）；编译器不应产出该 op`,
      kind: 'mapping',
    }
  }
  return undefined
}

/**
 * 运行时自适应种入（审计 P0-01 机制改动③：正确构造前态）。
 * 数字键盘优先：可见可点击控件中单数字文本 ≥2 个 → 按键种入显示区（键盘计算器
 * 场景——第一个可见输入框可能在无关业务域，房贷案教训）；否则有输入域 → 填入并
 * 记录初值；两者皆无 → precondition（不可自动验证）。
 */
async function seedState(page: Page, seedValue: string): Promise<SeedContext | string> {
  const survey = await page.evaluate(() => {
    const isVisible = (el: Element): boolean => {
      const rect = el.getBoundingClientRect()
      const style = window.getComputedStyle(el)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    const digitText = (el: Element): string => (el.textContent ?? '').trim()
    const controls = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], input[type="button"], a, [class]')).filter(isVisible)
    const digitControls = controls.filter((el) => /^[0-9]$/.test(digitText(el)))
    const fields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')).filter((el) => {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      return type !== 'button' && type !== 'submit' && type !== 'checkbox' && type !== 'radio' && type !== 'file'
    })
    const visibleField = fields.find(isVisible)
    return {
      digitCount: digitControls.length,
      digits: digitControls.map((el) => digitText(el)),
      bodyText: document.body ? document.body.innerText : '',
      initialFieldValue: visibleField ? visibleField.value : null,
    }
  })
  // 键盘模式：数字键依次种入（如 123），要求显示区文本出现种入串——证明种入生效
  if (survey.digitCount >= 2) {
    const seeded = await page.evaluate((value) => {
      const isVisible = (el: Element): boolean => {
        const rect = el.getBoundingClientRect()
        const style = window.getComputedStyle(el)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      }
      const digits = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], input[type="button"], a, [class]'))
        .filter(isVisible)
        .filter((el) => /^[0-9]$/.test((el.textContent ?? '').trim()))
      for (const ch of value.split('')) {
        digits.find((el) => (el.textContent ?? '').trim() === ch)?.click()
      }
      return document.body ? document.body.innerText : ''
    }, seedValue)
    if (!seeded.includes(seedValue)) {
      return `页面有数字键盘但按键后显示区未出现种入值「${seedValue}」（实际文本片段：${seeded.slice(0, 120).replace(/\s+/g, ' ')}）——无法构造可观测前态`
    }
    return { mode: 'keypad', seedValue, initialValue: survey.bodyText }
  }
  // 输入域模式：填入第一个可见输入域并记录初值，要求填充生效
  if (survey.initialFieldValue !== null) {
    const filled = await fillFirstVisibleInput(page, seedValue)
    if (!filled) return '页面有输入域但不可填充——无法构造前态'
    const valueNow = await page.evaluate(() => {
      const isVisible = (el: Element): boolean => {
        const rect = el.getBoundingClientRect()
        const style = window.getComputedStyle(el)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      }
      const fields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')).filter((el) => {
        const type = (el.getAttribute('type') || 'text').toLowerCase()
        return type !== 'button' && type !== 'submit' && type !== 'checkbox' && type !== 'radio' && type !== 'file'
      })
      const field = fields.find(isVisible)
      return field ? field.value : null
    })
    if (valueNow !== seedValue) {
      return `输入域填充后值为「${valueNow ?? '(无输入域)'}」而非「${seedValue}」——种入未生效（可能被脚本重置）`
    }
    return { mode: 'input', seedValue, initialValue: survey.initialFieldValue }
  }
  return '页面既无可点击数字键盘也无可见输入域——本断言需要先构造输入态再触发，当前不可自动验证'
}

/** 清空/重置的精确断言：绑定种入域（审计 P0-01 机制改动②——不复用「页面包含 0」）。 */
async function assessReset(page: Page, seed: SeedContext): Promise<StepFailure | undefined> {
  if (seed.mode === 'keypad') {
    const text = await readRenderedText(page)
    if (!text.includes(seed.seedValue)) return undefined
    return {
      reason: `断言未满足：点击触发后显示区仍含种入值「${seed.seedValue}」（页面文本片段：${text.slice(0, 120).replace(/\s+/g, ' ')}）——清空/重置控件未生效或未绑定该显示区`,
      kind: 'product',
    }
  }
  const valueNow = await page.evaluate(() => {
    const isVisible = (el: Element): boolean => {
      const rect = el.getBoundingClientRect()
      const style = window.getComputedStyle(el)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    const fields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')).filter((el) => {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      return type !== 'button' && type !== 'submit' && type !== 'checkbox' && type !== 'radio' && type !== 'file'
    })
    const field = fields.find(isVisible)
    return field ? field.value : null
  })
  const isCleared = valueNow === '' || valueNow === seed.initialValue || (valueNow !== null && isZeroState(valueNow))
  if (isCleared) return undefined
  return {
    reason: `断言未满足：点击触发后种入输入域的值为「${valueNow ?? '(输入域消失)'}」（种入值「${seed.seedValue}」未被清空/重置——期望回到初始值「${seed.initialValue || '(空)'}」或零态）`,
    kind: 'product',
  }
}

/** 零态判定（清空到 0 的计算器惯例：'0'、'0.0'、'00' 等，排除非零数值与残留输入）。 */
function isZeroState(value: string): boolean {
  return /^0+[.]?0*$/.test(value.trim())
}

/** 填入第一个可见输入域（input/change 事件派发，与产物监听口兼容）。 */
async function fillFirstVisibleInput(page: Page, value: string): Promise<boolean> {
  return page.evaluate((fillValue) => {
    const isVisible = (el: Element): boolean => {
      const rect = el.getBoundingClientRect()
      const style = window.getComputedStyle(el)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    const fields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')).filter((el) => {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      return type !== 'button' && type !== 'submit' && type !== 'checkbox' && type !== 'radio' && type !== 'file'
    })
    const field = fields.find((el) => isVisible(el))
    if (!field) return false
    field.value = fillValue
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }, value)
}

/** 页面是否提供可交互控件（占位断言存在性兑底用；只认真可见控件，隐藏 overlay 不计）。 */
export async function hasInteractiveControl(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const isVisible = (el: Element): boolean => {
      const rect = el.getBoundingClientRect()
      const style = window.getComputedStyle(el)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0
    }
    return Array.from(document.querySelectorAll('button, input, select, textarea, a, form')).some(isVisible)
  })
}

/** 断言文本读取（gwt-runner.readRenderedText 同构小函数——私有避免跨文件导出耦合）。 */
async function readRenderedText(page: Page): Promise<string> {
  return page.evaluate(() => (document.body ? document.body.innerText : ''))
}
