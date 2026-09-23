import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearEvidenceCacheForTests, computeArtifactFingerprint, getCachedStaticEvidence, setCachedStaticEvidence } from '../../../main/verification/evidence-cache'

describe('W6-D6：静态证据按产物指纹缓存', () => {
  const original = process.env.BLOMA_EVIDENCE_CACHE
  let root: string
  beforeEach(() => {
    process.env.BLOMA_EVIDENCE_CACHE = '1'
    clearEvidenceCacheForTests()
    root = mkdtempSync(join(tmpdir(), 'bloma-evcache-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'app.js'), 'const a = 1\n', 'utf8')
  })
  afterEach(() => {
    clearEvidenceCacheForTests()
    if (original === undefined) delete process.env.BLOMA_EVIDENCE_CACHE
    else process.env.BLOMA_EVIDENCE_CACHE = original
  })

  it('同指纹命中缓存；文件变更（内容/mtime）指纹变化即失效；开关关直通', () => {
    setCachedStaticEvidence('p1', root, 'security-scan', { passed: true })
    expect(getCachedStaticEvidence<{ passed: boolean }>('p1', root, 'security-scan')).toEqual({ passed: true })
    // 未登记 kind / 其他项目 → undefined
    expect(getCachedStaticEvidence('p1', root, 'other')).toBeUndefined()
    expect(getCachedStaticEvidence<{ passed: boolean }>('p2', root, 'security-scan')).toBeUndefined()
    // 改文件（mtime 变）→ 指纹变 → 失效
    const before = computeArtifactFingerprint(root)
    const later = new Date(Date.now() + 5000)
    utimesSync(join(root, 'src', 'app.js'), later, later)
    expect(computeArtifactFingerprint(root)).not.toBe(before)
    expect(getCachedStaticEvidence('p1', root, 'security-scan')).toBeUndefined()
    // 开关关：写入与读取都直通（undefined / 不落缓存）
    delete process.env.BLOMA_EVIDENCE_CACHE
    setCachedStaticEvidence('p1', root, 'security-scan', { passed: false })
    expect(getCachedStaticEvidence('p1', root, 'security-scan')).toBeUndefined()
  })
})
