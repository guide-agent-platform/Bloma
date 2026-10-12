/**
 * 人话卡构建器测试（刀1，2026-10-02 确认协议与呈现层战役）。
 *
 * 形态快照：delivered 通知卡（验收结论/运行方式/修改出口——通知≠确认）与
 * blocked 人工介入卡（出什么事/证据/两个选项）；纯函数零 I/O。
 */
import { describe, expect, it } from 'vitest'
import { buildBlockedNoticeCard, buildDeliveredNoticeCard, digestDeliveryDoc } from '../../../main/desktop/notice-cards'

describe('buildDeliveredNoticeCard 交付通知卡', () => {
  it('separates host scope from implementation claims', () => {
    const card = buildDeliveredNoticeCard({ projectName: 'voice', fromPhaseTitle: '验收', coreScope: ['固定音频经真实模型解码'], deliveryDigest: '模型说明' })
    expect(card).toContain('本次宿主验证范围：固定音频经真实模型解码')
    expect(card).toContain('实现者交付说明（能力以宿主验证记录为准）')
  })
  it('完整形态：验收结论 + 运行方式（entry + DELIVERY.md）+ 摘要 + 修改出口', () => {
    const card = buildDeliveredNoticeCard({
      projectName: 'clip-tool',
      fromPhaseTitle: '驱动验收',
      entryFile: 'app.py',
      deliveryDigest: '双击 start.bat 启动\n依赖：Python 3.11+',
      driverSummary: { passed: 7, total: 7 },
    })
    expect(card).toContain('【交付完成】')
    expect(card).toContain('「clip-tool」')
    expect(card).toContain('7/7 PASS')
    expect(card).toContain('程序入口：app.py')
    expect(card).toContain('DELIVERY.md')
    expect(card).toContain('双击 start.bat 启动')
    expect(card).toContain('不用从头再来')
  })

  it('缺省字段渐进降级：无 entry/摘要/统计仍成卡（展示性数据 fail-open）', () => {
    const card = buildDeliveredNoticeCard({ projectName: 'p', fromPhaseTitle: '驱动验收' })
    expect(card).toContain('【交付完成】')
    expect(card).not.toContain('程序入口')
    expect(card).toContain('DELIVERY.md') // 位置提示常在
  })

  it('截图行：刀3 呈现层产物路径入卡', () => {
    const card = buildDeliveredNoticeCard({
      projectName: 'p',
      fromPhaseTitle: '驱动验收',
      screenshotPaths: ['00_VERIFY/screenshots/S1.png', '00_VERIFY/screenshots/S2.png'],
    })
    expect(card).toContain('程序截图（2 张')
    expect(card).toContain('S1.png')
  })
})

describe('buildBlockedNoticeCard 人工介入卡', () => {
  it('完整形态：暂停声明 + 证据 + 两个选项（继续/直接给意见）', () => {
    const card = buildBlockedNoticeCard({
      phaseTitle: '驱动验收',
      whatHappened: '「驱动验收」阶段连续 3 次未通过门禁，自动修复已到上限，流水线暂停。',
      evidence: 'RecursionError: maximum recursion depth exceeded（首个栈帧：File "driver.py", line 10）',
    })
    expect(card).toContain('【已暂停，需要你拿主意】')
    expect(card).toContain('RecursionError')
    expect(card).toContain('回复「继续」')
    expect(card).toContain('直接回复修改意见')
  })

  it('无证据仍成卡（证据行缺省省略）', () => {
    const card = buildBlockedNoticeCard({ phaseTitle: '最小骨架', whatHappened: '用户已叫停。' })
    expect(card).toContain('【已暂停，需要你拿主意】')
    expect(card).not.toContain('最新证据')
  })
})

describe('digestDeliveryDoc 摘要', () => {
  it('取首 6 个非空非标题行，每行截 120 字', () => {
    const doc = '# 交付说明\n\n## 运行\n双击启动\n' + '很长的行'.repeat(40) + '\n' + Array.from({ length: 8 }, (_, i) => `行${i}`).join('\n')
    const digest = digestDeliveryDoc(doc)
    const lines = digest.split('\n')
    expect(lines.length).toBe(6)
    expect(lines[0]).toBe('双击启动')
    expect(lines[1].endsWith('…')).toBe(true)
    expect(lines[1].length).toBeLessThanOrEqual(121)
  })

  it('空文档 → 空串（调用方按缺省处理）', () => {
    expect(digestDeliveryDoc('# 只有标题\n\n')).toBe('')
  })
})
