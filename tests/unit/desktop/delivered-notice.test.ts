import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../main/project/project-service', () => ({ findProject: vi.fn() }))
vi.mock('../../../main/project/document-engine', () => ({ readPrdBackplane: vi.fn() }))
import { findProject } from '../../../main/project/project-service'
import { readPrdBackplane } from '../../../main/project/document-engine'
import { requirementVerificationContext } from '../../../main/project/requirement-contract'
import { verificationFingerprint } from '../../../main/desktop/verification-fingerprint'
import { assembleDeliveredNotice } from '../../../main/desktop/delivered-notice'
let root: string
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })
describe('current delivery evidence presentation', () => {
  it('removes verified scope after source or external PRD changes, without rewriting history', () => {
    root = mkdtempSync(join(tmpdir(), 'bloma-delivered-notice-'))
    writeFileSync(join(root, 'app.py'), '# original product')
    mkdirSync(join(root, '00_VERIFY'))
    const backplane = { requirements: [{ id: 'F-001', description: '原需求' }] } as never
    vi.mocked(findProject).mockReturnValue({ root_path: root } as never)
    vi.mocked(readPrdBackplane).mockReturnValue(backplane)
    const report = { status: 'passed', llm: { status: 'passed' }, fingerprint: verificationFingerprint(root, requirementVerificationContext(backplane)) }
    writeFileSync(join(root, '00_VERIFY/core-verification.json'), JSON.stringify(report))
    const notice = () => assembleDeliveredNotice('p', '产品', 'desktop-implement', {} as never)
    expect(notice().coreScope?.join(' ')).toContain('本机 HTTP')
    vi.mocked(readPrdBackplane).mockReturnValue({ requirements: [{ id: 'F-001', description: '新需求' }] } as never)
    expect(notice().coreScope).toBeUndefined()
    vi.mocked(readPrdBackplane).mockReturnValue(backplane)
    writeFileSync(join(root, 'app.py'), '# changed product')
    expect(notice().coreScope).toBeUndefined()
  })
})
