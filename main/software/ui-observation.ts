import type { Page } from 'playwright'
import { redactSoftwareOutput } from './process-manager'

/** A diagnostic PNG is separate from business assertions or an explicitly
 * requested visual check. A missing PNG never becomes visual PASS evidence. */
export async function captureDiagnosticScreenshot(page: Page, path: string, signal: AbortSignal) {
  signal.throwIfAborted()
  try { await page.screenshot({ path, timeout: 10000 }); signal.throwIfAborted(); return { path, error: undefined } }
  catch (error) { signal.throwIfAborted(); return { path: undefined, error: redactSoftwareOutput(String(error)).slice(-2000) } }
}

/** A bounded DOM observation, never injected business logic or a PASS script.
 * Prefer editable controls before long lists, as in Proma observation policy. */
export async function observeSoftwareUi(page: Page) {
  return page.evaluate(() => {
    const controls: Array<{ selector: string; has_text?: string; name: string; value?: string }> = []
    const nodes = [...new Set([...document.querySelectorAll('input,textarea,select'), ...document.querySelectorAll('button,a,[role],[data-testid]')])]
    for (const element of nodes) {
      if (!(element instanceof HTMLElement) || !element.getClientRects().length) continue
      const tag = element.tagName.toLowerCase(), text = (element.innerText || '').trim(), id = element.id, testId = element.getAttribute('data-testid')
      const field = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
      const label = field ? [...(element.labels ?? [])].map(item => item.innerText).join(' ').trim() : ''
      const name = (element.getAttribute('aria-label') || label || element.getAttribute('placeholder') || element.getAttribute('title') || text || id || tag).slice(0, 100)
      const selector = id ? `#${CSS.escape(id)}` : testId ? `[data-testid=${JSON.stringify(testId)}]` : tag
      const sensitive = /password|secret|token|api.?key|\bkey\b|密钥|密码|令牌/i.test(`${id} ${element.getAttribute('name') ?? ''} ${element.getAttribute('type') ?? ''} ${name}`)
      controls.push({ selector, ...(!id && !testId && text ? { has_text: text.slice(0, 100) } : {}), name,
        ...(field ? { value: sensitive ? '[REDACTED]' : element.value.slice(0, 200) } : {}) })
      if (controls.length >= 40) break
    }
    const result = { title: document.title.slice(0, 200), text: document.body.innerText.slice(0, 1600), controls }
    while (JSON.stringify(result).length > 8000 && controls.length > 1) controls.pop()
    return result
  })
}
