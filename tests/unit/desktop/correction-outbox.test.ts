import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearCorrectionSubmission, readCorrectionSubmission, saveCorrectionSubmission } from '../../../main/desktop/correction-outbox'

beforeEach(() => vi.stubEnv('PROMA_HOME', mkdtempSync(join(tmpdir(), 'bloma-correction-outbox-'))))
afterEach(() => vi.unstubAllEnvs())
describe('durable correction submission', () => {
  it('keeps feedback and identity until the matching acknowledgement', () => {
    const original = saveCorrectionSubmission('p', '修改按钮', 1)
    expect(readCorrectionSubmission('p')).toEqual(original)
    expect(saveCorrectionSubmission('p', 'another pending request', 2)).toEqual(original)
    expect(readCorrectionSubmission('other')).toBeUndefined()
    expect(clearCorrectionSubmission('p', 'wrong-id')).toBe(false)
    expect(readCorrectionSubmission('p')).toEqual(original)
    expect(clearCorrectionSubmission('p', original.id)).toBe(true)
    expect(readCorrectionSubmission('p')).toBeUndefined()
  })
  it('does not silently replace a corrupt submission', () => {
    saveCorrectionSubmission('p', '修复列表', 1)
    const directory = join(process.env.PROMA_HOME!, 'correction-outbox')
    writeFileSync(join(directory, readdirSync(directory)[0]!), 'broken')
    expect(() => saveCorrectionSubmission('p', 'replacement', 1)).toThrow()
  })
})
