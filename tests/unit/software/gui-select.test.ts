import { existsSync } from 'node:fs'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { observeGuiStep } from '../../../main/software/gui-observer'
import { parseGuiSuite } from '../../../main/desktop/gui-acceptance'
import { guiStepsSchema, SOFTWARE_GUI_ACTION_KINDS } from '../../../main/desktop/gui-tool-contract'
import { validateToolInput } from '../../../main/agent/loop/tool-input-validation'

it('validates one exact select value or label before running a check', () => {
  const suite = (step: unknown) => ({ version: 1, scope_hash: 'a'.repeat(64), covers: ['F-001'], steps: [step] })
  const select = { id: 'choose', kind: 'select', selector: '#status', label: '进行中' }
  expect(parseGuiSuite(suite(select), { allowActionsOnly: true }).steps).toEqual([select])
  expect(validateToolInput('inspect_app', { steps: [select] }, { type: 'object', properties: { steps: guiStepsSchema(32, SOFTWARE_GUI_ACTION_KINDS) } })).toBeUndefined()
  for (const patch of [{ label: undefined }, { value: 'doing' }, { label: 1 }, { label: 'x'.repeat(4097) }]) {
    expect(() => parseGuiSuite(suite({ ...select, ...patch }), { allowActionsOnly: true })).toThrow('GUI_SELECT_INVALID')
  }
})

it('uses native select events and retains fill compatibility without altering product markup', async () => {
  const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: process.platform === 'win32' ? 'msedge' : 'chrome' }) })
  try {
    const page = await browser.newPage()
    await page.setContent('<input id="title"><select id="status"><option value="todo">待办</option><option value="doing">进行中</option><option value="done">已完成</option></select><output id="selected"></output><script>statusField=document.querySelector("#status");statusField.onchange=()=>document.querySelector("#selected").textContent=statusField.value</script>')
    const before = await page.locator('#status').evaluate(element => element.outerHTML)
    expect(await observeGuiStep(page, { id: 'by-value', kind: 'select', selector: '#status', value: 'doing' })).toBe('doing')
    expect(await page.locator('#selected').innerText()).toBe('doing')
    expect(await observeGuiStep(page, { id: 'by-label', kind: 'select', selector: '#status', label: '已完成' })).toBe('done')
    expect(await observeGuiStep(page, { id: 'old-call', kind: 'fill', selector: '#status', value: '待办' })).toBe('todo')
    await observeGuiStep(page, { id: 'text', kind: 'fill', selector: '#title', value: '普通文本' })
    expect(await page.locator('#title').inputValue()).toBe('普通文本')
    await expect(observeGuiStep(page, { id: 'missing', kind: 'select', selector: '#status', value: 'missing' })).rejects.toThrow('GUI_SELECT_OPTION_NOT_UNIQUE')
    expect(await page.locator('#status').inputValue()).toBe('todo')
    expect(await page.locator('#status').evaluate(element => element.outerHTML)).toBe(before)
    await page.locator('body').evaluate(element => element.insertAdjacentHTML('beforeend', '<select id="ambiguous"><option value="a">重复</option><option value="b">重复</option></select>'))
    await expect(observeGuiStep(page, { id: 'duplicate', kind: 'select', selector: '#ambiguous', label: '重复' })).rejects.toThrow('GUI_SELECT_OPTION_NOT_UNIQUE')
  } finally { await browser.close() }
}, 30000)
