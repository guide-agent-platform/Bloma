// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const html = readFileSync(resolve('tests/fixtures/dispatch-experiment/r5a-ui.html'), 'utf8')
const bridge = readFileSync(resolve('main/templates/skeletons/desktop-python/ui/bridge.js'), 'utf8')
const business = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(text => text.trim())!
const nativeWindow = window as unknown as { pywebview?: { api: Record<string, () => Promise<string>> }; App: { call(op: string): Promise<unknown> } }
afterEach(() => { vi.useRealTimers(); delete nativeWindow.pywebview; document.body.innerHTML = '' })
function load() {
  document.documentElement.innerHTML = html.replace(/<script[\s\S]*?<\/script>/g, '')
  window.eval(bridge); window.eval(business)
  document.dispatchEvent(new Event('DOMContentLoaded'))
}
describe('normal pywebview bridge readiness with the captured r5 UI', () => {
  it('loads saved tasks when native injection arrives after the old 420ms failure window', async () => {
    vi.useFakeTimers(); load()
    await vi.advanceTimersByTimeAsync(2000)
    expect(document.querySelector('.w-banner')?.textContent).not.toContain('加载失败')
    nativeWindow.pywebview = { api: { list_tasks: async () => JSON.stringify({ ok: true, view: 'all', tasks: [{ id: 'a', title: 'saved', done: true }], counts: { all: 1, active: 0, completed: 1 } }) } }
    window.dispatchEvent(new Event('pywebviewready'))
    await vi.advanceTimersByTimeAsync(0)
    expect(document.querySelector('.task-title')?.textContent).toBe('saved')
    expect(document.querySelector('#count-all')?.textContent).toBe('1')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('keeps missing native injection bounded and surfaces the error', async () => {
    vi.useFakeTimers(); window.eval(bridge)
    const result = nativeWindow.App.call('list_tasks')
    const checked = expect(result).rejects.toThrow('桥未就绪')
    await vi.advanceTimersByTimeAsync(10000); await checked
    expect(vi.getTimerCount()).toBe(0)
  })
})
