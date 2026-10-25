import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { observeGuiStep } from '../../../main/software/gui-observer'
import { parseGuiSuite } from '../../../main/desktop/gui-acceptance'

it('selects records by visible identity after sorting and reports genuine wrong output without editing expectations', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'bloma-text-locator-'))
  const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? { executablePath: chromium.executablePath() } : { channel: process.platform === 'win32' ? 'msedge' : 'chrome' }) })
  try {
    const page = await browser.newPage()
    await page.setContent('<button id="sort" onclick="items.prepend(items.lastElementChild)">Sort</button><div id="items"><button class="record" onclick="out.textContent=this.textContent">Note A</button><button class="record" onclick="out.textContent=this.textContent">Note B</button></div><div id="out"></div>')
    await expect(observeGuiStep(page, { id: 'ambiguous', kind: 'expect', selector: '.record', nonempty: true })).rejects.toMatchObject({
      actual: { matched: 2, candidates: [{ text: 'Note A' }, { text: 'Note B' }] },
    })
    expect(await observeGuiStep(page, { id: 'count', kind: 'expect', selector: '.record', property: 'count', equals: '2' })).toBe('2')
    expect(await observeGuiStep(page, { id: 'some', kind: 'expect', selector: '.record', property: 'count', nonempty: true })).toBe('2')
    await expect(observeGuiStep(page, { id: 'none', kind: 'expect', selector: '.missing-record', property: 'count', nonempty: true, timeout_ms: 100 })).rejects.toMatchObject({ actual: '0' })
    const suite = parseGuiSuite({ version: 1, scope_hash: 'a'.repeat(64), covers: ['F-001'], steps: [{ id: 'pick', kind: 'click', selector: '.record', has_text: 'Note B' }, { id: 'result', kind: 'expect', selector: '#out', equals: 'Note B' }] })
    for (const step of suite.steps) await observeGuiStep(page, step)
    await page.locator('#sort').click()
    for (const step of suite.steps) await observeGuiStep(page, step)
    await expect(observeGuiStep(page, { id: 'wrong', kind: 'expect', selector: '#out', equals: 'Note A', timeout_ms: 100 })).rejects.toMatchObject({ message: 'GUI_ASSERTION_FAILED:wrong', actual: 'Note B', expected: 'Note A' })
    expect(() => parseGuiSuite({ ...suite, steps: [{ id: 'bad', kind: 'click', selector: '.record', has_text: 42 }] })).toThrow('TEXT_LOCATOR_INVALID')
  } finally {
    await browser.close()
    const target = realpathSync(temporary); if (dirname(target) !== realpathSync(tmpdir())) throw Error('unsafe fixture cleanup')
    rmSync(target, { recursive: true, force: true })
  }
}, 30000)
