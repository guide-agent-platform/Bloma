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
import { buildDesktopChildBaseSystem, buildDispatcherSystemPrompt } from '../../../main/desktop/dispatcher-prompt'
import { DESKTOP_PHASES } from '../../../main/desktop/dispatcher-phases'

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

  it('真实冻结背板的验收/断言/约束/排除/假设进入调度员和子会话，超过 24 项不丢失', () => {
    const originalHome = process.env.PROMA_HOME
    const home = mkdtempSync(join(tmpdir(), 'bloma-digest-contract-'))
    process.env.PROMA_HOME = home
    try {
      const project = createProject({ request_id: 'digest-project', mode: 'quick' })
      const requirements = Array.from({ length: 30 }, (_, index) => ({
        id: `F-${String(index + 1).padStart(3, '0')}`,
        description: index === 29 ? `${'长描述'.repeat(60)}不能丢失的末尾条件` : `功能 ${index + 1}`,
        behavior_assertions: index === 0 ? ['非法金额不保存', '非法金额不保存'] : [],
        scope_notes: index === 0 ? '不改变币种' : undefined,
      }))
      writeFileSync(join(getDocumentsDir(project.workspace_slug, project.project_id), 'prd.json'), JSON.stringify({
        project_id: project.project_id, name: project.name,
        positioning: '个人记账', requirements,
        acceptance: { 'F-001': '新增两条相同内容的记录都能保存' },
        constraints: ['必须离线可用'], out_of_scope: ['不做云同步'], assumptions: ['默认按时间降序'],
        prd_document: '# 已确认需求\n游戏规则与数值基准：每完成一轮计数加一',
      }), 'utf8')
      const digest = readDesktopRequirementsDigest(project.project_id)!
      for (const prompt of [
        buildDispatcherSystemPrompt(DESKTOP_PHASES['desktop-implement'], { projectName: project.name, requirementsDigest: digest, quickMode: true }),
        buildDesktopChildBaseSystem(DESKTOP_PHASES['desktop-implement'], { projectName: project.name, requirementsDigest: digest, quickMode: true }),
      ]) {
        expect(prompt).toContain('验收要点：新增两条相同内容的记录都能保存')
        expect(prompt).toContain('行为断言：非法金额不保存')
        expect(prompt).toContain('本项范围排除：不改变币种')
        expect(prompt).toContain('必须离线可用')
        expect(prompt).toContain('不做云同步')
        expect(prompt).toContain('默认按时间降序')
        expect(prompt).toContain('F-030')
        expect(prompt).toContain('不能丢失的末尾条件')
        expect(prompt).toContain('游戏规则与数值基准：每完成一轮计数加一')
        expect(prompt).not.toContain('其余 6 项')
      }
      expect(digest.match(/行为断言：非法金额不保存/g)).toHaveLength(1)
    } finally {
      restorePromaHome(originalHome)
      rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
  })
})
