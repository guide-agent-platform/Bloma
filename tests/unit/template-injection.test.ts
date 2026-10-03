import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildClarifyInjection,
  buildPrdFewShotInjection,
} from '../../main/agent/prompting/template-injection'
import type { PrdBackplane, SketchRequirement } from '../../main/coding/sketch-engine'
// 2026-10-03 删留执行：buildLoopInjection/buildSketchInjection/gwtRequiredCategories/
// externalResourceViolation/renderGwtSkeleton 为历史删除用例遗留死 import，已清。

/** 注入点②-⑦接线（P5）：每点独立开关（=现状语义）+ 切片内容。 */

vi.mock('../../main/project/decision-log', () => ({ recordDecision: vi.fn() }))

const requirements: SketchRequirement[] = [
  { id: 'F-001', description: '番茄钟', priority: 'P0', behavior_assertions: ['WHEN 点击开始按钮 → 计时启动', 'WHILE 列表为空 → 显示空状态'] },
]

function makeBackplane(): PrdBackplane {
  return {
    project_id: 'p1',
    name: '番茄钟',
    positioning: '专注计时',
    requirements,
    acceptance: {},
    out_of_scope: [],
    assumptions: [],
    template_meta: { type: 'personal_tool', level: 'loose', version: 1 },
  }
}

describe('template-injection（P5：注入点开关与切片）', () => {
  const originalEnv = { ...process.env }
  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-inject-'))
  })
  afterEach(() => {
    // 只清理本文件设过的注入开关（防测试污染，陷阱 34 精神）
    for (const key of ['BLOMA_INJECT_CLARIFY', 'BLOMA_INJECT_PRD', 'BLOMA_INJECT_SKETCH', 'BLOMA_INJECT_LOOP', 'BLOMA_INJECT_GWT']) {
      delete process.env[key]
    }
    process.env = { ...originalEnv }
  })

  describe('② clarify 切片', () => {
    it('quick：五必填 + ≤3 问纪律', () => {
      const section = buildClarifyInjection('personal_tool', 'quick')
      expect(section).toContain('产品定位')
      expect(section).toContain('至多 3 问')
      expect(section).toContain('个人小工具')
    })

    it('longterm：全章节框架 + 目标用户/术语', () => {
      const section = buildClarifyInjection('web_fullstack', 'longterm')
      expect(section).toContain('目标用户')
      expect(section).toContain('长期模式')
    })

  })

  describe('③ prd few-shot 切片', () => {
    it('含同类型样例（模板 sample 段，500 token 硬截断）', () => {
      const section = buildPrdFewShotInjection('personal_tool')
      expect(section).toContain('同类型产品示例')
      expect(section!.length).toBeLessThan(900)
    })

  })
})
