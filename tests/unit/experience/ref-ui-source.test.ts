import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ingestResearchIdeasAsCandidates, registerUiModeCard } from '../../../main/experience/ref-ui-source'
import { listRefPatternModules } from '../../../main/experience/ref-source'
import { resetExperienceIndexForTests } from '../../../main/experience/experience-service'

/**
 * G3a 市调 UI 做法入册（UI 模式卡通道，用户 2026-09-07 裁定）：
 * - 恒 candidate + pattern/ui/{slug}_{hash4} 命名空间（与 G2 批跑互斥防撞）
 * - 同 key 窗口折叠不重复建行；跨项目同想法才 merged 计数
 * - off → 0 计数零文件副作用；G4 消费端天然排除本通道（build_pass=false）
 */

const originalHome = process.env.PROMA_HOME
const originalExp = process.env.BLOMA_EXPERIENCE
const originalRef = process.env.BLOMA_REF_LIBRARY
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ui-ingest-'))
  process.env.PROMA_HOME = home
  process.env.BLOMA_EXPERIENCE = '1'
  delete process.env.BLOMA_REF_LIBRARY
  resetExperienceIndexForTests()
})
afterEach(() => {
  process.env.PROMA_HOME = originalHome
  if (originalExp === undefined) delete process.env.BLOMA_EXPERIENCE
  else process.env.BLOMA_EXPERIENCE = originalExp
  if (originalRef === undefined) delete process.env.BLOMA_REF_LIBRARY
  else process.env.BLOMA_REF_LIBRARY = originalRef
  resetExperienceIndexForTests()
})

function ledgerText() {
  const p = join(home, 'bloma-experience.jsonl')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

describe('ref-ui-source：市调 UI 做法入册', () => {
  it('入册恒 candidate、tag 命名空间 pattern/ui/、source=user_feedback', async () => {
    const id = await registerUiModeCard({
      idea: { label: '虚拟键盘实时弹奏', note: '点击琴键立即发声并高亮', source: 'pianoabc.com' },
      demand: '做一个网页钢琴陪练',
      projectId: 'proj-ui-1',
    })
    expect(id).toBeTruthy()
    const lines = ledgerText().trim().split('\n')
    expect(lines).toHaveLength(1)
    const card = JSON.parse(lines[0])
    expect(card.kind).toBe('pattern')
    expect(card.status).toBe('candidate')
    expect(card.tag.startsWith('pattern/ui/')).toBe(true)
    expect(card.source.type).toBe('user_feedback')
    expect(card.body.language_family).toBe('universal')
    expect(card.body.sandbox_result.build_pass).toBe(false)
  })

  it('同想法重复投喂 → 窗口折叠不重复建行', async () => {
    const n1 = await ingestResearchIdeasAsCandidates({
      ideas: [{ label: '跟琴谱滚动高亮', note: 'n', source: 's.com' }],
      demand: 'd',
      projectId: 'p1',
    })
    const n2 = await ingestResearchIdeasAsCandidates({
      ideas: [{ label: '跟琴谱滚动高亮', note: 'n', source: 's.com' }],
      demand: 'd',
      projectId: 'p1',
    })
    expect(n1 + n2).toBe(2)
    expect(ledgerText().trim().split('\n')).toHaveLength(1)
  })

  it('开关 off → 计数 0 且账本文件不创建', async () => {
    process.env.BLOMA_EXPERIENCE = 'off'
    const n = await ingestResearchIdeasAsCandidates({
      ideas: [{ label: '任意想法', note: 'x', source: 'y' }],
      demand: 'd',
      projectId: 'p1',
    })
    expect(n).toBe(0)
    expect(existsSync(join(home, 'bloma-experience.jsonl'))).toBe(false)
  })

  it('G4 隔离：UI 卡永不进 ref 物化（build_pass=false 被消费端排除）', async () => {
    await ingestResearchIdeasAsCandidates({
      ideas: [{ label: 'duet 双人模式', note: 'n', source: 's' }],
      demand: 'd',
      projectId: 'p1',
    })
    process.env.BLOMA_REF_LIBRARY = '1'
    expect(listRefPatternModules('personal_tool', home)).toEqual([])
  })
})
