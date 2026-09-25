import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'playwright'

/**
 * GWT steps fail-closed 回归（2026-09-26 审计修复批）：把独立审计的合成反例
 * 移植为正式变异测试——no-op 清空、错域种入、未实现 op、删除/撤销映射缺口
 * 都必须失败或阻断，绝不默认通过。夹具是显式合成 DOM（非真浏览器 E2E：
 * 证明控制流语义，与审计反例同口径）。
 */

// ── 合成 DOM 夹具（审计 counterexamples.cjs 同构：global.document/window + fake Page） ──

interface FakeElement {
  textContent: string
  className: string
  value: string
  click: () => void
  getBoundingClientRect: () => { x: number; y: number; width: number; height: number }
  getAttribute: (name: string) => string | null
  dispatchEvent: () => void
}

function el(text = '', props: Partial<FakeElement> = {}): FakeElement {
  return {
    textContent: text,
    className: '',
    value: '',
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 20 }),
    getAttribute: () => null,
    dispatchEvent: () => {},
    click: () => {},
    ...props,
  }
}

function fakePage() {
  let bodyText = ''
  let inputs: FakeElement[] = []
  let controls: FakeElement[] = []
  const page = {
    evaluate: async (fn: (arg?: unknown) => unknown, arg?: unknown) => fn(arg),
    waitForTimeout: async () => {},
  } as unknown as Page
  const reset = (text: string, fields: FakeElement[], buttons: FakeElement[]): void => {
    bodyText = text
    inputs = fields
    controls = buttons
  }
  return { page, reset, getBodyText: () => bodyText }
}

let cleanup: (() => void) | undefined

beforeEach(() => {
  const win = { getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }) }
  const doc: { body: { get innerText(): string }; querySelectorAll: (sel: string) => unknown[] } = {
    body: { get innerText() { return '' } },
    querySelectorAll: () => [],
  }
  // 每个用例构造自己的 bodyText 闭包后重挂
  globalThis.window = win as unknown as typeof globalThis.window
  globalThis.document = doc as unknown as Document
  cleanup = () => {
    delete (globalThis as Record<string, unknown>).window
    delete (globalThis as Record<string, unknown>).document
  }
})

afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

function mountDom(bodyTextRef: { text: string }, inputs: FakeElement[], controls: FakeElement[]): void {
  ;(globalThis.document as unknown as { body: { get innerText(): string } }).body = {
    get innerText() { return bodyTextRef.text },
  }
  ;(globalThis.document as unknown as { querySelectorAll: (sel: string) => unknown[] }).querySelectorAll = (sel: string) =>
    sel === 'input, textarea' ? inputs : controls
}

describe('GWT steps fail-closed（审计 P0-01 变异基准）', () => {
  it('no-op 清空按钮（输入域模式）：种入后点击无效果 → product 失败，不得 PASS', async () => {
    const { runStepScenario, compileResetSteps } = await import('../../main/verification/gwt-steps')
    const fixture = fakePage()
    const bodyTextRef = { text: '计算器 0 1 2 3 清空' }
    const input = el('', { value: '7' })
    let clearClicks = 0
    const clearBtn = el('清空', { click: () => { clearClicks += 1 /* no-op：不改 input */ } })
    mountDom(bodyTextRef, [input], [clearBtn])
    fixture.reset(bodyTextRef.text, [input], [clearBtn])

    const compiled = compileResetSteps('点击清空键→当前输入与结果归零', '清空')
    expect(compiled.status).toBe('compiled')
    const outcome = await runStepScenario(fixture.page, compiled.status === 'compiled' ? compiled.steps : [])

    // 审计反例 broken-clear-keypad-zero：v1 判 PASS（页面含 0）；v2 必须失败
    expect(outcome).toBeDefined()
    expect(outcome?.kind).toBe('product')
    expect(outcome?.reason).toContain('清空')
    expect(input.value).toBe('123') // 种入仍在——按钮确实没生效
    expect(clearClicks).toBe(1)
  })

  it('正常清空（输入域模式）：种入→点击→回到初值 → PASS', async () => {
    const { runStepScenario, compileResetSteps } = await import('../../main/verification/gwt-steps')
    const fixture = fakePage()
    const input = el('', { value: '' })
    const clearBtn = el('清空', { click: () => { input.value = '' } })
    mountDom({ text: '计算器 清空' }, [input], [clearBtn])

    const compiled = compileResetSteps('点击清空键→当前输入与结果归零', '清空')
    const outcome = await runStepScenario(fixture.page, compiled.status === 'compiled' ? compiled.steps : [])
    expect(outcome).toBeUndefined()
  })

  it('键盘计算器（无输入域）：按键种入显示区，no-op 清空 → product 失败', async () => {
    const { runStepScenario, compileResetSteps } = await import('../../main/verification/gwt-steps')
    const fixture = fakePage()
    const display = { text: '0' }
    const digits = ['1', '2', '3', '0'].map((d) => el(d, { click: () => { display.text += d } }))
    const clearBtn = el('清空', { click: () => { /* no-op：坏按钮 */ } })
    mountDom(display, [], [...digits, clearBtn])
    // bodyText 必须联动显示区（innerText getter 读 display.text）
    ;(globalThis.document as unknown as { body: { get innerText(): string } }).body = {
      get innerText() { return `计算器 ${display.text}` },
    }

    const compiled = compileResetSteps('点击清空键→当前输入与结果归零', '清空')
    const outcome = await runStepScenario(fixture.page, compiled.status === 'compiled' ? compiled.steps : [])
    expect(outcome).toBeDefined()
    expect(outcome?.kind).toBe('product')
    expect(display.text).toContain('123') // 种入仍在——清空没生效
  })

  it('键盘计算器：正常清空回 0 → PASS（种入串从显示区消失）', async () => {
    const { runStepScenario, compileResetSteps } = await import('../../main/verification/gwt-steps')
    const fixture = fakePage()
    const display = { text: '0' }
    const digits = ['1', '2', '3', '0'].map((d) => el(d, { click: () => { display.text += d } }))
    const clearBtn = el('清空', { click: () => { display.text = '0' } })
    mountDom(display, [], [...digits, clearBtn])
    ;(globalThis.document as unknown as { body: { get innerText(): string } }).body = {
      get innerText() { return `计算器 ${display.text}` },
    }

    const compiled = compileResetSteps('点击清空键→当前输入与结果归零', '清空')
    const outcome = await runStepScenario(fixture.page, compiled.status === 'compiled' ? compiled.steps : [])
    expect(outcome).toBeUndefined()
  })

  it('错域防护（房贷案形态）：页面同时有无关输入域和数字键盘 → 键盘种入显示区，不填无关输入域', async () => {
    const { runStepScenario, compileResetSteps } = await import('../../main/verification/gwt-steps')
    const fixture = fakePage()
    const display = { text: '0' }
    const mortgageInput = el('', { value: '' }) // 房贷区输入框（错误域——v1 会填它）
    const digits = ['1', '2', '3', '0'].map((d) => el(d, { click: () => { display.text += d } }))
    const clearBtn = el('清空', { click: () => { display.text = '0' } })
    mountDom(display, [mortgageInput], [...digits, clearBtn])
    ;(globalThis.document as unknown as { body: { get innerText(): string } }).body = {
      get innerText() { return `房贷 计算器 ${display.text}` },
    }

    const compiled = compileResetSteps('点击清空键→当前输入与结果归零', '清空')
    const outcome = await runStepScenario(fixture.page, compiled.status === 'compiled' ? compiled.steps : [])
    expect(outcome).toBeUndefined()
    expect(mortgageInput.value).toBe('') // 键盘模式：不碰无关输入域（审计 P0-01 机制③）
  })

  it('删除/撤销族：mapping 阻断（fail-closed），不生成「页面包含 0」替代断言', async () => {
    const { compileResetSteps, classifyResetIntent } = await import('../../main/verification/gwt-steps')
    expect(classifyResetIntent('点击删除按钮→目标记录消失')).toBe('delete')
    expect(classifyResetIntent('点击撤销按钮→上一次修改恢复')).toBe('undo')
    expect(classifyResetIntent('点击清空键→当前输入与结果归零')).toBe('clear')

    const del = compileResetSteps('点击删除按钮→目标记录消失', '目标')
    expect(del.status).toBe('mapping_blocked')
    const undo = compileResetSteps('点击撤销按钮→上一次修改恢复', '目标')
    expect(undo.status).toBe('mapping_blocked')
    // 同一编译器不再把三种语义压成同一组步骤（审计反例 non-equivalent-assertions-same-compiler）
    if (del.status === 'mapping_blocked' && undo.status === 'mapping_blocked') {
      expect(del.reason).not.toBe(undo.reason)
    }
  })

  it('未实现 op（press/assert-visible/未知）：显式失败，不默认通过', async () => {
    const { runStepScenario } = await import('../../main/verification/gwt-steps')
    const fixture = fakePage()
    mountDom({ text: '真实页面' }, [], [el('按钮')])
    const steps = [
      { kind: 'when' as const, text: 'press required', op: { type: 'press' as const, value: 'Enter' } },
      { kind: 'then' as const, text: 'must see missing element', op: { type: 'assert-visible' as const, target: '#missing' } },
    ]
    const outcome = await runStepScenario(fixture.page, steps)
    expect(outcome).toBeDefined()
    expect(outcome?.kind).toBe('mapping')
    expect(outcome?.reason).toContain('未在执行器实现')
  })

  it('无可种入域（无输入域无数字键盘）→ precondition（不可自动验证，但不放行）', async () => {
    const { runStepScenario, compileResetSteps } = await import('../../main/verification/gwt-steps')
    const fixture = fakePage()
    mountDom({ text: '显示区 123 清空' }, [], [el('清空')])
    const compiled = compileResetSteps('点击清空键→当前输入与结果归零', '清空')
    const outcome = await runStepScenario(fixture.page, compiled.status === 'compiled' ? compiled.steps : [])
    expect(outcome).toBeDefined()
    expect(outcome?.kind).toBe('precondition')
  })

  it('找不到清空控件 → selector 失败（带页面控件清单）', async () => {
    const { runStepScenario, compileResetSteps } = await import('../../main/verification/gwt-steps')
    const fixture = fakePage()
    const input = el('', { value: '' })
    mountDom({ text: '计算器' }, [input], [el('等号'), el('加号')])
    const compiled = compileResetSteps('点击清空键→当前输入与结果归零', '清空')
    const outcome = await runStepScenario(fixture.page, compiled.status === 'compiled' ? compiled.steps : [])
    expect(outcome).toBeDefined()
    expect(outcome?.kind).toBe('selector')
    expect(outcome?.reason).toContain('找不到可点击的')
  })
})
