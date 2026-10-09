import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve('main/templates/skeletons/desktop-python/ui/bridge.js'), 'utf8')
function bridge(result: unknown, drive: boolean) {
  const api = { list_records: async () => JSON.stringify(result) }
  const context = { window: { location: { search: drive ? '?dport=8800' : '' }, pywebview: { api } }, pywebview: { api }, fetch: async () => ({ json: async () => ({ ok: true, result }) }), setTimeout }
  runInNewContext(source, context)
  return (context.window as unknown as { App: { call(op: string): Promise<Record<string, unknown>> } }).App
}

describe('webview bridge API contract', () => {
  it.each([false, true])('supports envelope and flat UI readers (drive=%s)', async (drive) => {
    const payload = { ok: true, data: { records: [{ id: '1' }], summary: { count: 1 } } }
    const result = await bridge(payload, drive).call('list_records')
    expect(result.records).toEqual([{ id: '1' }])
    expect(result.summary).toEqual({ count: 1 })
    expect(result.data).toEqual(payload.data)
    expect(result.ok).toBe(true)
  })
  it.each([false, true])('keeps raw arrays and failure/correction results unchanged (drive=%s)', async (drive) => {
    for (const payload of [[{ id: '1' }], { ok: false, error: 'failed' }, { ok: true, seq: 1 }]) {
      expect(await bridge(payload, drive).call('list_records')).toEqual(payload)
    }
  })
  it('does not overwrite existing envelope fields or mutate its prototype', async () => {
    const payload = JSON.parse('{"ok":true,"data":{"ok":false,"__proto__":{"polluted":true},"records":[]}}')
    const result = await bridge(payload, false).call('list_records')
    expect(result.ok).toBe(true)
    expect(Object.getPrototypeOf(result).polluted).toBeUndefined()
  })
})
