import type { Page } from 'playwright'
import { expect, it, vi } from 'vitest'
import { captureDiagnosticScreenshot } from '../../../main/software/ui-observation'

it('records diagnostic screenshot failure without inventing an image or losing user cancellation', async () => {
  const screenshot = vi.fn(async () => { throw Error('font wait timeout api_key=PRIVATE_KEY') })
  const result = await captureDiagnosticScreenshot({ screenshot } as unknown as Page, '/owned/evidence.png', new AbortController().signal)
  expect(result.path).toBeUndefined(); expect(result.error).toContain('font wait timeout'); expect(result.error).not.toContain('PRIVATE_KEY')
  expect(screenshot).toHaveBeenCalledWith({ path: '/owned/evidence.png', timeout: 10000 })
  const controller = new AbortController(), reason = Error('explicit cancellation')
  const cancelled = { screenshot: async () => { controller.abort(reason); throw Error('capture aborted') } } as unknown as Page
  await expect(captureDiagnosticScreenshot(cancelled, '/owned/evidence.png', controller.signal)).rejects.toBe(reason)
})
