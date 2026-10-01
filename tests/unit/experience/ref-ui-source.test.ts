import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ingestResearchIdeasAsCandidates, registerUiModeCard } from '../../../main/experience/ref-ui-source'
import { resetExperienceIndexForTests } from '../../../main/experience/experience-service'

/**
 * G3a 市调 UI 做法入册（UI 模式卡通道，用户 2026-09-07 裁定）：
 * - 恒 candidate + pattern/ui/{slug}_{hash4} 命名空间（与 G2 批跑互斥防撞）
 * - 同 key 窗口折叠不重复建行；跨项目同想法才 merged 计数
 * - 恒入册（EXPERIENCE 开关 2026-10-01 转正删除）；G4 消费端天然排除本通道（build_pass=false）
 */

const originalHome = process.env.PROMA_HOME
const originalRef = process.env.BLOMA_REF_LIBRARY
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ui-ingest-'))
  process.env.PROMA_HOME = home
  delete process.env.BLOMA_REF_LIBRARY
  resetExperienceIndexForTests()
})
afterEach(() => {
  process.env.PROMA_HOME = originalHome
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

  it('恒入册（EXPERIENCE 开关 2026-10-01 转正删除，env 未设也入册）', async () => {
    delete process.env.BLOMA_EXPERIENCE
    const n = await ingestResearchIdeasAsCandidates({
      ideas: [{ label: '任意想法', note: 'x', source: 'y' }],
      demand: 'd',
      projectId: 'p1',
    })
    expect(n).toBe(1)
    expect(existsSync(join(home, 'bloma-experience.jsonl'))).toBe(true)
  })

  it('G4 隔离：UI 卡永不进 ref 物化（build_pass=false 被消费端排除）', async () => {
    await ingestResearchIdeasAsCandidates({
      ideas: [{ label: 'duet 双人模式', note: 'n', source: 's' }],
      demand: 'd',
      projectId: 'p1',
    })
    process.env.BLOMA_REF_LIBRARY = '1'
  })
})

describe('P2b 词典/百科垃圾拒收（狗粮 94f449c6「纵」字案）', () => {
  it('looksLikeDictionaryJunk：百科后缀/词典括注/词典域名/内容标记/单字名命中；正常 UI 想法放行', async () => {
    const { looksLikeDictionaryJunk } = await import('../../../main/experience/ref-ui-source')
    // 当晚 4 张垃圾卡的原始形态（域名与标题全部实测复现）
    expect(looksLikeDictionaryJunk({ label: '纵（汉语文字）_百度百科', source: 'baike.baidu.com/item/纵' })).toBe(true)
    expect(looksLikeDictionaryJunk({ label: '纵 z&#242;ng、zǒng、zōng', source: 'zdic.net' })).toBe(true)
    expect(looksLikeDictionaryJunk({ label: '纵的意思,纵的解释,纵的拼音,纵的部首,', source: 'hanyuguoxue.com' })).toBe(true)
    expect(looksLikeDictionaryJunk({ label: '纵怎么读_纵的拼音 - 新华字典', source: 'zidian.gushici.net' })).toBe(true)
    // 域名缺失但标题是词典内容形态 → 内容标记兑底
    expect(looksLikeDictionaryJunk({ label: '纵怎么读_纵的拼音', source: '' })).toBe(true)
    expect(looksLikeDictionaryJunk({ label: '纵的意思,纵的解释,纵的拼音,纵的部首,', source: '' })).toBe(true)
    // 单字名（剥括注/分隔符后只剩一个汉字）
    expect(looksLikeDictionaryJunk({ label: '纵' })).toBe(true)
    expect(looksLikeDictionaryJunk({ label: '纵 - 打飞机界面风格' })).toBe(false) // 剥分隔符后多字，放行
    // 正常 UI 想法不误杀
    expect(looksLikeDictionaryJunk({ label: '虚拟键盘实时弹奏', note: '点击琴键立即发声', source: 'pianoabc.com' })).toBe(false)
    expect(looksLikeDictionaryJunk({ label: '抽奖转盘', note: '每日一次抽奖机会', source: 'lottery.example.com' })).toBe(false)
    expect(looksLikeDictionaryJunk({ label: '' })).toBe(true)
  })

  it('入册拒收：垃圾想法不落账本、不计入返回计数；干净想法照常入册', async () => {
    const count = await ingestResearchIdeasAsCandidates({
      ideas: [
        { label: '纵（汉语文字）_百度百科', note: '此曰纵，缓也……', source: 'baike.baidu.com/item/纵' },
        { label: '纵 z&#242;ng、zǒng、zōng', note: '本义:松缓', source: 'zdic.net' },
        { label: '纵的意思,纵的解释,纵的拼音,纵的部首,', note: '纵是多音字', source: 'hanyuguoxue.com' },
        { label: '无尽刷分生存的经典 HUD 布局', note: '顶部血条+右上分数', source: 'shmup.example.com/best' },
      ],
      demand: '做一个纵版打飞机',
      projectId: 'proj-ui-junk',
    })
    expect(count).toBe(1)
    const text = ledgerText()
    expect(text).toContain('无尽刷分生存的经典 HUD 布局')
    expect(text).not.toContain('百度百科')
    expect(text).not.toContain('纵（汉语文字）')
  })
})
