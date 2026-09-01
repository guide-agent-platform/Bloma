import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getProjectTemplatePath } from '../../storage/config-paths'
import {
  SAMPLE_MAX_CHARS,
  loadProjectTemplate,
  templateSection,
} from '../../main/project-templates'
import type { TemplateType } from '../../shared/types'

/** 模板包加载器（P4）：内置三包结构齐、外置覆盖生效、非法外置 fail-closed 回退+决策日志。 */

vi.mock('../../main/decision-log', () => ({
  recordDecision: vi.fn(),
}))

import { recordDecision } from '../../main/decision-log'

const ALL_TYPES: TemplateType[] = ['web_fullstack', 'desktop_tool', 'personal_tool']

describe('project-templates（P4：模板包 + 内外置加载 fail-closed）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    vi.mocked(recordDecision).mockClear()
  })

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  describe('内置模板包（main/templates/ 三种）', () => {
    it.each(ALL_TYPES)('%s：加载成功且结构齐全（frontmatter 四字段 + sample 非空）', (type) => {
      process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-tpl-'))
      const template = loadProjectTemplate(type)
      expect(template).not.toBeNull()
      expect(template!.type).toBe(type)
      expect(['loose', 'standard']).toContain(template!.level)
      expect(template!.version).toBeGreaterThanOrEqual(1)
      expect(template!.name.length).toBeGreaterThan(0)
      expect(template!.sample.length).toBeGreaterThan(0)
      expect(template!.source).toBe('builtin')
    })

    it('等级映射符合 PRD 12.3：personal=loose，web/desktop=standard', () => {
      process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-tpl-'))
      expect(loadProjectTemplate('personal_tool')?.level).toBe('loose')
      expect(loadProjectTemplate('web_fullstack')?.level).toBe('standard')
      expect(loadProjectTemplate('desktop_tool')?.level).toBe('standard')
    })

    it('sample 硬截断 ≤800 字符（500 token few-shot 配额）', () => {
      process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-tpl-'))
      for (const type of ALL_TYPES) {
        expect(loadProjectTemplate(type)!.sample.length).toBeLessThanOrEqual(SAMPLE_MAX_CHARS)
      }
    })

    it('模板正文含方案 §5.2 六要素章节', () => {
      process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-tpl-'))
      const template = loadProjectTemplate('web_fullstack')!
      for (const section of ['硬约束等级', 'PRD 章节必填子集', '依赖白名单', 'tech_skeleton', '测试策略', '同类型脱敏样例']) {
        expect(template.body).toContain(section)
      }
    })

    it('ai_app 二期回退 personal-tool 内置（不阻断）', () => {
      process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-tpl-'))
      const template = loadProjectTemplate('ai_app')
      // ai-app.md 不存在 → 候选 personal-tool；type 校验 personal_tool≠ai_app → null（fail-closed 不阻断）
      expect(template).toBeNull()
    })

    it('templateSection 按消费者切片（依赖白名单段可独立取出）', () => {
      process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-tpl-'))
      const template = loadProjectTemplate('web_fullstack')!
      const allowlist = templateSection(template, '依赖白名单')
      expect(allowlist).toContain('允许')
      expect(allowlist).toContain('禁止')
      expect(templateSection(template, '不存在章节')).toBe('')
    })
  })

  describe('外置覆盖（~/.proma/templates/{type}.md）', () => {
    it('合法外置生效（source=override，改文件即时生效无需重启）', () => {
      const home = mkdtempSync(join(tmpdir(), 'proma-tpl-override-'))
      process.env.PROMA_HOME = home
      mkdirSync(join(home, 'templates'), { recursive: true })
      writeFileSync(
        getProjectTemplatePath('web-fullstack.md'),
        '---\ntype: web_fullstack\nlevel: strict\nversion: 2\nname: 自定义 Web 模板\n---\n\n## 同类型脱敏样例\n自定义样例内容',
        'utf8',
      )
      const template = loadProjectTemplate('web_fullstack')
      expect(template?.source).toBe('override')
      expect(template?.level).toBe('strict')
      expect(template?.name).toBe('自定义 Web 模板')
      expect(template?.sample).toContain('自定义样例内容')
    })

    it('frontmatter 缺失 → 回退内置 + 决策日志 template_override_rejected（§九验收 5）', () => {
      const home = mkdtempSync(join(tmpdir(), 'proma-tpl-broken-'))
      process.env.PROMA_HOME = home
      mkdirSync(join(home, 'templates'), { recursive: true })
      writeFileSync(getProjectTemplatePath('web-fullstack.md'), '就是一段没有 frontmatter 的文本', 'utf8')
      const template = loadProjectTemplate('web_fullstack', { project_id: 'p1', session_id: 's1' })
      expect(template?.source).toBe('builtin_fallback')
      expect(template?.name).toBe('Web 全栈') // 内置内容
      expect(recordDecision).toHaveBeenCalledTimes(1)
      const entry = vi.mocked(recordDecision).mock.calls[0][0].entry
      expect(entry.type).toBe('template_override_rejected')
      expect(entry.detail?.template_type).toBe('web_fullstack')
    })

    it('type 不匹配（外置冒充他类型）→ 回退内置', () => {
      const home = mkdtempSync(join(tmpdir(), 'proma-tpl-mismatch-'))
      process.env.PROMA_HOME = home
      mkdirSync(join(home, 'templates'), { recursive: true })
      writeFileSync(
        getProjectTemplatePath('web-fullstack.md'),
        '---\ntype: desktop_tool\nlevel: standard\nname: 冒充\n---\n\n## 同类型脱敏样例\nx',
        'utf8',
      )
      expect(loadProjectTemplate('web_fullstack')?.source).toBe('builtin_fallback')
    })

    it('level 非法 → 回退内置', () => {
      const home = mkdtempSync(join(tmpdir(), 'proma-tpl-badlevel-'))
      process.env.PROMA_HOME = home
      mkdirSync(join(home, 'templates'), { recursive: true })
      writeFileSync(
        getProjectTemplatePath('personal-tool.md'),
        '---\ntype: personal_tool\nlevel: 超级\nname: x\n---\n\n## 同类型脱敏样例\nx',
        'utf8',
      )
      expect(loadProjectTemplate('personal_tool')?.source).toBe('builtin_fallback')
    })

    it('外置空文件 → 回退内置（prompt-config 同款空白判定）', () => {
      const home = mkdtempSync(join(tmpdir(), 'proma-tpl-empty-'))
      process.env.PROMA_HOME = home
      mkdirSync(join(home, 'templates'), { recursive: true })
      writeFileSync(getProjectTemplatePath('personal-tool.md'), '', 'utf8')
      // 空文件 frontmatter 解析失败 → builtin_fallback
      expect(loadProjectTemplate('personal_tool')?.source).toBe('builtin_fallback')
    })
  })
})
