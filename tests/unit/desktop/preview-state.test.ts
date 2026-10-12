// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
type Guard = { begin(): object; accept(ticket: object, plan: object): boolean; take(): unknown; invalidate(): void }
describe('preview readiness in the real DOM', () => {
  it('invalidates on input/folder changes, ignores stale responses and consumes once', () => {
    document.body.innerHTML = '<input id="folder" value="C:/owned"><input id="prefix" value="done-"><button id="execute">执行</button>'
    const inputs = Array.from(document.querySelectorAll('input'))
    const button = document.querySelector('button')!
    window.eval(readFileSync(resolve('main/templates/skeletons/desktop-python/ui/preview-state.js'), 'utf8'))
    const guard = (window as unknown as { createPreviewGuard(inputs: HTMLInputElement[], button: HTMLButtonElement): Guard }).createPreviewGuard(inputs, button)
    const plan = { rows: [{ old: 'a.txt', new: 'done-a.txt' }] }
    const old = guard.begin()
    inputs[1]!.value = '../'
    inputs[1]!.dispatchEvent(new Event('input'))
    expect(guard.accept(old, plan)).toBe(false)
    expect(button.disabled).toBe(true)
    expect(guard.take()).toBeNull()
    inputs[1]!.value = 'done-'
    const first = guard.begin(), second = guard.begin()
    expect(guard.accept(first, plan)).toBe(false)
    expect(guard.accept(second, plan)).toBe(true)
    expect(guard.take()).toBe(plan)
    expect(guard.take()).toBeNull()
    expect(button.disabled).toBe(true)
    const next = guard.begin()
    inputs[0]!.value = 'C:/different' // even programmatic edits without events are checked
    expect(guard.accept(next, plan)).toBe(false)
    const empty = guard.begin()
    expect(guard.accept(empty, { rows: [] })).toBe(false)
  })
})
