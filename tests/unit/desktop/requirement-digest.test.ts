/**
 * 需求摘要渲染测试（2026-09-26 首跑修复）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readDesktopRequirementsDigest, renderRequirementsDigest } from '../../../main/desktop/requirement-digest'
import { createProject } from '../../../main/project/project-service'
import { getDocumentsDir } from '../../../storage/config-paths'
import { restorePromaHome } from '../../support/proma-home-guard'



describe('renderRequirementsDigest', () => {
  it('逐条渲染 id/优先级/描述；空清单 → 空串', () => {
    expect(renderRequirementsDigest({ items: [] })).toBe('')
    const text = renderRequirementsDigest({
      items: [
        { id: 'F-001', description: '托盘倒计时工具', priority: 'P0' },
        { id: 'F-002', description: '手动输入时长' },
      ],
    })
    expect(text).toContain('- F-001 [P0] 托盘倒计时工具')
    expect(text).toContain('- F-002 手动输入时长')
  })

  it('超量截断（省略行）+ 单项描述截断（…）', () => {
    const items = Array.from({ length: 30 }, (_, index) => ({
      id: `F-${100 + index}`,
      description: 'x'.repeat(200),
    }))
    const text = renderRequirementsDigest({ items, maxItems: 3, maxDescriptionChars: 10 })
    const lines = text.split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[3]).toContain('其余 27 项')
    expect(lines[0]).toContain('…')
  })

  it('readDesktopRequirementsDigest：背板缺失 fail-open → undefined（不阻断主链）', () => {
    expect(readDesktopRequirementsDigest('missing-project-id')).toBeUndefined()
  })

})
import { bindAcceptance } from '../../../main/project/requirement-contract'
