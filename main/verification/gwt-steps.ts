/**
 * GWT steps 架构（2026-09-26 照抄 Proma-Easy GwtStep schema——AGPL-3.0 同源互搬，
 * 用户拍板「能照抄就照抄」；适配点：对方 selector 三档依赖标注纪律，我们复用
 * gwt-runner 的多信号语义匹配器按目标文本寻址——执行层等价）。
 * 快路径（单步断言）保留在 gwt-runner：无状态断言现状不动；状态转换族走本模块多步。
 */
import type { Page } from 'playwright'
import { collectControlSnapshots, findClickableIndex, visibleControlInventory } from './gwt-runner'

// =========================================================================
// steps 架构（2026-09-26 照抄 Proma-Easy GwtStep schema——AGPL-3.0 同源互搬，
// 用户拍板「能照抄就照抄」；适配点：对方 selector 三档（data-ai-id/#id/aria-label）
// 依赖标注纪律，我们复用多信号语义匹配器按目标文本寻址——执行层等价）。
// 快路径（单步断言）保留：无状态断言 15/16 可过的现状不动；状态转换族走多步。
// =========================================================================

/** op 白名单 v1（对方 v2 词表的状态转换子集：前置填充 + 触发 + 绝对断言三件）。 */
export type StepOpType = 'fill' | 'click' | 'press' | 'assert-text' | 'assert-visible'

/** 单步操作（对方 GwtStepOp 的场景内子集形态）。 */
export interface StepOp {
  type: StepOpType
  /** 语义目标（对方是显式 selector；我们走 findClickableIndex 多信号匹配——适配点） */
  target?: string
  /** fill 值 / press 键名 */
  value?: string
  /** assert-text 期望包含文本（绝对断言——非前后对比） */
  contains?: string
}

/** 三段式步骤（对方 GwtStep 的执行子集：kind/text/op）。 */
export interface GwtStep {
  kind: 'given' | 'when' | 'then'
  text: string
  op: StepOp
}

/** 失败归类（对方 AC L-001 回炉分流的 v1：产品类进修复轮，前置缺失类不烧预算）。 */
export type StepFailureKind = 'product' | 'precondition' | 'selector'

/** 状态转换族断言判定：「清空/归零/重置/删除/撤销」类效果=回到初始态——空态触发无
 * 可观测变化（单步前后对比必假失败）；需要前置填充后再触发（对方 Given 显式步骤）。 */
const STATE_RESET_ASSERTION_RE = /清空|归零|重置|清零|清除|删除|撤销|恢复初始/

export function needsStepCompilation(assertion: string): boolean {
  return STATE_RESET_ASSERTION_RE.test(assertion)
}

/**
 * 规则编译器 v1：状态转换族断言 → 三段步骤（fill 种子 → click 触发 → assert-text 绝对断言）。
 * schema 与对方完全一致——未来换 LLM 编译器（覆盖复杂场景）零结构改动。
 * click 目标复用单步解析的 trigger.target（「清空键」→匹配器同义词命中「清空」控件）。
 */
export function compileStepsForAssertion(assertion: string, target: string | undefined): GwtStep[] {
  return [
    { kind: 'given', text: '已输入种子值 123', op: { type: 'fill', target: 'input', value: '123' } },
    { kind: 'when', text: `执行触发：${target ?? ''}`, op: { type: 'click', target: target ?? '' } },
    { kind: 'then', text: '显示归零（页面包含 0）', op: { type: 'assert-text', contains: '0' } },
  ]
}

/**
 * 多步执行器（对方 runSteps 语义）：顺序执行 given/when 操作，then 绝对断言。
 * 前置填充失败 → precondition（不可自动验证，不烧修复预算）；点击失败 → selector；
 * 断言不过 → product（真产品类，进修复轮）。返回 undefined=通过。
 */
export async function runStepScenario(page: Page, steps: GwtStep[]): Promise<{ reason: string; kind: StepFailureKind } | undefined> {
  for (const step of steps) {
    if (step.op.type === 'fill') {
      const filled = await page.evaluate((value) => {
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
        field.value = value
        field.dispatchEvent(new Event('input', { bubbles: true }))
        field.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      }, step.op.value ?? '123')
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
    if (step.op.type === 'assert-text') {
      await page.waitForTimeout(300) // 对方轮询窗口的简化版：断言前微等待渲染稳定
      const text = await readRenderedText(page)
      const inputs = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')).map((el) => el.value).join(' '),
      )
      const contains = step.op.contains ?? '0'
      if (text.includes(contains) || inputs.includes(contains)) return undefined
      return { reason: `断言未满足（${step.text}）：前置已填充并触发成功，但页面与输入值均不含「${contains}」（页面文本片段：${text.slice(0, 120).replace(/\s+/g, ' ')}）`, kind: 'product' }
    }
  }
  return undefined
}

/** 断言文本读取（gwt-runner.readRenderedText 同构小函数——私有避免跨文件导出耦合）。 */
async function readRenderedText(page: Page): Promise<string> {
  return page.evaluate(() => (document.body ? document.body.innerText : ''))
}
