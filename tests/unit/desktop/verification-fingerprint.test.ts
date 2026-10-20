import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verificationFingerprint } from '../../../main/desktop/verification-fingerprint'

describe('verification freshness', () => {
  it('does not treat source and test code as disposable data just because of their directory names', () => {
    const root = mkdtempSync(join(tmpdir(), 'fingerprint-code-'))
    try {
      writeFileSync(join(root, 'app.py'), 'old')
      let prior = verificationFingerprint(root)
      for (const directory of ['data', '00_VERIFY', '00_UX']) {
        mkdirSync(join(root, directory))
        writeFileSync(join(root, directory, 'check.py'), 'assert True')
        const next = verificationFingerprint(root)
        expect(next).not.toBe(prior)
        prior = next
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('changes for executable inputs/requirements but not evidence or user data', () => {
    const root = mkdtempSync(join(tmpdir(), 'fingerprint-'))
    try {
      writeFileSync(join(root, 'app.py'), 'old')
      const before = verificationFingerprint(root, 'confirmed')
      for (const dir of ['data', '00_VERIFY']) {
        mkdirSync(join(root, dir))
        writeFileSync(join(root, dir, 'state.json'), '{}')
      }
      writeFileSync(join(root, '00_VERIFY', 'mvp-review.html'), '<html>host report</html>')
      expect(verificationFingerprint(root, 'confirmed')).toBe(before)
      expect(verificationFingerprint(root, 'changed')).not.toBe(before)
      writeFileSync(join(root, 'app.py'), 'new')
      expect(verificationFingerprint(root, 'confirmed')).not.toBe(before)
      expect(verificationFingerprint(join(root, 'missing'))).toBeUndefined()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
