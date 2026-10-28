import { EventEmitter } from 'node:events'
import type { BrowserContext, Page } from 'playwright'
import { expect, it } from 'vitest'
import { softwareStartupError, waitForSoftwareWindow } from '../../../main/software/startup-diagnostics'
import type { SoftwareProcessSnapshot } from '../../../main/software/process-manager'

const snapshot = (): SoftwareProcessSnapshot => ({ id: 'owned-id', projectId: 'project', sessionId: 'session', state: 'running', stdout: '', stderr: '', startedAt: new Date().toISOString() })
function context() { const context = new EventEmitter() as EventEmitter & { pages: () => Page[] }; context.pages = () => []; return context }
it('returns port/root cause, owned identity and redacted stderr', () => {
  const s = { ...snapshot(), state: 'failed' as const, code: 9, stderr: 'EADDRINUSE\nAuthorization: Bearer PRIVATE_TOKEN' }
  const error = softwareStartupError('window', s, 'page wait failed')
  expect(error.message).toContain('APP_PORT_IN_USE'); expect(error.message).toContain('owned-id'); expect(error.message).toContain('exit_code'); expect(error.message).not.toContain('PRIVATE_TOKEN')
})
it('fails promptly when the owned process exits instead of waiting for the page timeout', async () => {
  const c = context(), s = snapshot(), started = Date.now()
  const waiting = waitForSoftwareWindow(c as unknown as BrowserContext, () => s, new AbortController().signal, 3000)
  s.state = 'failed'; s.code = 7; s.stderr = 'MODULE_NOT_FOUND: ./main.cjs'
  await expect(waiting).rejects.toThrow('APP_MODULE_MISSING')
  expect(Date.now() - started).toBeLessThan(1500); expect(c.listenerCount('page')).toBe(0)
})
it('accepts an actual application page and removes listeners, ignoring devtools', async () => {
  const c = context(), abort = new AbortController()
  const waiting = waitForSoftwareWindow(c as unknown as BrowserContext, snapshot, abort.signal)
  c.emit('page', { isClosed: () => false, url: () => 'devtools://devtools' })
  const page = { isClosed: () => false, url: () => 'file:///index.html' } as Page; c.emit('page', page)
  expect(await waiting).toBe(page); expect(c.listenerCount('page')).toBe(0)
})
it('preserves cancellation and reports an owned, logged window timeout', async () => {
  const c = context(), abort = new AbortController(), reason = Error('user cancelled')
  const waiting = waitForSoftwareWindow(c as unknown as BrowserContext, snapshot, abort.signal)
  abort.abort(reason); await expect(waiting).rejects.toBe(reason); expect(c.listenerCount('page')).toBe(0)
  await expect(waitForSoftwareWindow(c as unknown as BrowserContext, snapshot, new AbortController().signal, 30)).rejects.toThrow('APP_WINDOW_NOT_READY')
  expect(c.listenerCount('page')).toBe(0)
})
