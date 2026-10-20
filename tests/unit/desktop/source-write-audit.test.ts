import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { auditScriptSourceWrites, withProjectWriteLease } from '../../../main/desktop/source-write-audit'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const make = () => { const root = mkdtempSync(join(tmpdir(), 'source-audit-')); roots.push(root); return root }
describe('controlled script source write audit', () => {
  it('rolls back out-of-scope writes even when the invoked tool throws', async () => {
    const root = make(); writeFileSync(join(root, 'other.py'), 'original')
    const result = await auditScriptSourceWrites(root, [], [], async () => {
      writeFileSync(join(root, 'other.py'), 'unexpected'); throw new Error('tool crashed after writing')
    })
    expect(result.isError).toBe(true)
    expect(readFileSync(join(root, 'other.py'), 'utf8')).toBe('original')
  })
  it('restores refused edits, creations and deletions without removing authorized changes', async () => {
    const root = make(); writeFileSync(join(root, 'locked.py'), 'original'); writeFileSync(join(root, 'deleted.py'), 'keep')
    const outcome = await auditScriptSourceWrites(root, ['allowed.py'], [], async () => {
      writeFileSync(join(root, 'locked.py'), 'changed'); writeFileSync(join(root, 'allowed.py'), 'ok'); writeFileSync(join(root, 'new_gui.py'), 'not authorized'); rmSync(join(root, 'deleted.py'))
      return { output: 'PASS claimed', feedback: { schema_version: 1, execution: 'completed', verification: 'passed' } }
    })
    expect(outcome.isError).toBe(true)
    expect(outcome.feedback).toMatchObject({ execution: 'completed', verification: 'unverified', category: 'permission' })
    expect(readFileSync(join(root, 'locked.py'), 'utf8')).toBe('original')
    expect(readFileSync(join(root, 'deleted.py'), 'utf8')).toBe('keep')
    expect(readFileSync(join(root, 'allowed.py'), 'utf8')).toBe('ok')
    expect(existsSync(join(root, 'new_gui.py'))).toBe(false)
  })
  it('keeps frozen inputs protected even for a standalone executor', async () => {
    const root = make(); writeFileSync(join(root, 'confirmed.json'), 'frozen')
    const outcome = await auditScriptSourceWrites(root, undefined, ['confirmed.json'], async () => { writeFileSync(join(root, 'confirmed.json'), 'rewritten'); return { output: 'done' } })
    expect(outcome.isError).toBe(true)
    expect(readFileSync(join(root, 'confirmed.json'), 'utf8')).toBe('frozen')
  })
  it('serializes source mutations and cancels a waiting writer before it executes', async () => {
    const root = make(), signal = new AbortController(), order: string[] = []
    let release!: () => void
    const hold = new Promise<void>(r => { release = r })
    const first = withProjectWriteLease(root, new AbortController().signal, async () => { order.push('first'); await hold })
    await Promise.resolve()
    const second = withProjectWriteLease(root, signal.signal, async () => { order.push('second') })
    signal.abort(new Error('cancel writer'))
    await expect(second).rejects.toThrow('cancel writer')
    release(); await first
    expect(order).toEqual(['first'])
    await withProjectWriteLease(root, new AbortController().signal, async () => { order.push('third') })
    expect(order).toEqual(['first', 'third'])
  })
})
