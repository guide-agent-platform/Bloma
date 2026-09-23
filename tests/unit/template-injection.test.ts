import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildClarifyInjection,
  buildLoopInjection,
  buildPrdFewShotInjection,
  buildSketchInjection,
  gwtRequiredCategories,
  isInjectionEnabled,
} from '../../main/template-injection'
import { externalResourceViolation } from '../../main/coding/agent-tools'
import { buildAgentLoopSystemPrompt } from '../../main/coding/programming-orchestrator'
import { renderGwtSkeleton } from '../../main/document-engine'
import type { PrdBackplane, SketchRequirement } from '../../main/coding/sketch-engine'

/** 注入点②-⑦接线（P5）：每点独立开关（=现状语义）+ 切片内容。 */

vi.mock('../../main/decision-log', () => ({ recordDecision: vi.fn() }))

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

  describe('开关语义（§九验收 6：关闭后行为=现状）', () => {
    it('缺省全开', () => {
      expect(isInjectionEnabled('clarify')).toBe(true)
      expect(isInjectionEnabled('prd')).toBe(true)
      expect(isInjectionEnabled('loop')).toBe(true)
      expect(isInjectionEnabled('gwt')).toBe(true)
    })

    it.each([
      ['BLOMA_INJECT_CLARIFY', 'clarify'],
      ['BLOMA_INJECT_PRD', 'prd'],
      ['BLOMA_INJECT_SKETCH', 'sketch'],
      ['BLOMA_INJECT_LOOP', 'loop'],
      ['BLOMA_INJECT_GWT', 'gwt'],
    ])('%s=0 关闭 %s 且不影响其他点', (envKey, point) => {
      process.env[envKey] = '0'
      expect(isInjectionEnabled(point as 'clarify')).toBe(false)
      const others = (['clarify', 'prd', 'sketch', 'loop', 'gwt'] as const).filter((p) => p !== point)
      for (const other of others) expect(isInjectionEnabled(other)).toBe(true)
    })

    it('off/false 同义关闭', () => {
      process.env.BLOMA_INJECT_PRD = 'off'
      expect(isInjectionEnabled('prd')).toBe(false)
      process.env.BLOMA_INJECT_PRD = 'FALSE'
      expect(isInjectionEnabled('prd')).toBe(false)
    })
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

    it('开关关闭 → null（现状）', () => {
      process.env.BLOMA_INJECT_CLARIFY = '0'
      expect(buildClarifyInjection('personal_tool', 'quick')).toBeNull()
    })
  })

  describe('③ prd few-shot 切片', () => {
    it('含同类型样例（模板 sample 段，500 token 硬截断）', () => {
      const section = buildPrdFewShotInjection('personal_tool')
      expect(section).toContain('同类型产品示例')
      expect(section!.length).toBeLessThan(900)
    })

    it('开关关闭 → null', () => {
      process.env.BLOMA_INJECT_PRD = '0'
      expect(buildPrdFewShotInjection('personal_tool')).toBeNull()
    })
  })

  describe('⑤ sketch 切片', () => {
    it('pages 清单注入（背板 pages 优先）', () => {
      const backplane = makeBackplane()
      backplane.pages = [{ name: '计时页', purpose: '主界面' }]
      const section = buildSketchInjection('personal_tool', 'quick', backplane)
      expect(section).toContain('计时页')
      expect(section).toContain('不要自创页面')
    })

    it('longterm 追加布局惯例段', () => {
      const section = buildSketchInjection('desktop_tool', 'longterm', makeBackplane())
      expect(section).toContain('布局惯例')
    })

    it('开关关闭 → null', () => {
      process.env.BLOMA_INJECT_SKETCH = '0'
      expect(buildSketchInjection('personal_tool', 'quick', makeBackplane())).toBeNull()
    })
  })

  describe('⑥ loop 切片 + 工具层拦截', () => {
    it('tech_skeleton/依赖白名单进背板锚定段', () => {
      const system = buildAgentLoopSystemPrompt(makeBackplane(), 'whole')
      expect(system).toContain('工程模板')
      expect(system).toContain('依赖白名单')
      expect(system).toContain('index.html')
    })

    it('注入段位于项目锚之后、工作方式之前（锚定优先级）', () => {
      const system = buildAgentLoopSystemPrompt(makeBackplane(), 'whole')
      const anchorIdx = system.indexOf('【项目锚')
      const templateIdx = system.indexOf('【工程模板')
      const workIdx = system.indexOf('【工作方式】')
      expect(anchorIdx).toBeGreaterThan(-1)
      expect(templateIdx).toBeGreaterThan(anchorIdx)
      expect(workIdx).toBeGreaterThan(templateIdx)
    })

    it('开关关闭 → system 无模板段（现状）', () => {
      process.env.BLOMA_INJECT_LOOP = '0'
      const system = buildAgentLoopSystemPrompt(makeBackplane(), 'whole')
      expect(system).not.toContain('【工程模板')
      expect(system).toContain('【项目锚') // 锚定段不受影响
    })

    it('PR-2 产物形态条件化：无骨架 → 维持「不使用 import/ESM」现状话术', () => {
      const system = buildAgentLoopSystemPrompt(makeBackplane(), 'whole')
      expect(system).toContain('不使用 import/ESM 模块语法')
      expect(system).not.toContain('模块化优先')
    })

    it('P5 模式库章节注入：常见模式范式切片进模板段（防章节静默不注入）', () => {
      const system = buildAgentLoopSystemPrompt(makeBackplane(), 'whole')
      expect(system).toContain('常见模式范式（实现要点提示，非必选）')
      // personal_tool 模板差异化内容（无悬浮球/无分页）
      expect(system).toContain('防抖 200ms')
      expect(system).toContain('容错 JSON 损坏')
      expect(system).not.toContain('悬浮球')
      // 切片独立性：buildLoopInjection 直连同样携带
      const direct = buildLoopInjection('personal_tool')
      expect(direct).toContain('常见模式范式')
    })

    it('PR-2 产物形态条件化：工程骨架（skeletonMap）→ 解禁模块化 + 构建门禁说明', () => {
      const system = buildAgentLoopSystemPrompt(makeBackplane(), 'whole', undefined, '工程骨架已就位（测试地图）')
      expect(system).toContain('模块化优先')
      expect(system).toContain('构建门禁')
      expect(system).not.toContain('不使用 import/ESM 模块语法') // 静态约束在工程形态下解除
      expect(system).toContain('工程骨架已就位')
    })

    it('外部 CDN script 引用被工具层拦截', () => {
      const violation = externalResourceViolation('<html><script src="https://cdn.example.com/lib.js"></script></html>')
      expect(violation).toContain('外部脚本')
    })

    it('外部样式 link 引用被拦截；内联与 img 不拦', () => {
      expect(externalResourceViolation('<link rel="stylesheet" href="https://cdn.example.com/a.css">')).toContain('外部样式')
      expect(externalResourceViolation('<style>body{}</style><img src="https://pics.example.com/a.png">')).toBeNull()
      expect(externalResourceViolation('<script src="./src/app.js"></script>')).toBeNull() // 本地相对路径放行
    })

    it('开关关闭 → 不拦截（现状）', () => {
      process.env.BLOMA_INJECT_LOOP = '0'
      expect(externalResourceViolation('<script src="https://cdn.example.com/lib.js"></script>')).toBeNull()
    })
  })

  describe('⑦ GWT 必测类别与句式标注', () => {
    it('quick×loose = 主路径+边界+异常；longterm = +空态', () => {
      expect(gwtRequiredCategories('quick', 'loose')).toEqual(['主路径(P0)', '边界', '异常'])
      expect(gwtRequiredCategories('longterm', 'standard')).toContain('空态')
    })

    it('feature 文件：EARS 句式类别标注（WHEN=主路径/WHILE=空态）+ 必测类别头注', () => {
      const bp = makeBackplane()
      // M-4 后「计时启动」入效果词表 → 真行为场景（When/Then 骨架，非存在性兑底）；
      // presenceFallback 分支的类别标注改用效果不可断言的断言验证
      bp.requirements = [
        { id: 'F-001', description: '番茄钟', priority: 'P0', behavior_assertions: ['WHEN 点击开始按钮 → 计时启动', 'WHILE 列表为空 → 显示空状态', 'WHEN 点击开始按钮 → 拥有掌控感'] },
      ]
      const features = renderGwtSkeleton(bp, 'longterm')
      const content = features[0].content
      expect(content).toContain('必测类别')
      expect(content).toContain('[空态]')
      // 「计时启动」走真场景骨架（M-4：效果词表放宽后可探针）
      expect(content).toContain('Scenario: [主路径]：WHEN 点击开始按钮 → 计时启动')
      expect(content).toContain('When 点击「开始」控件')
      // presenceFallback 分支同样携带句式类别标注（效果不可断言 → 存在性骨架）
      expect(content).toContain('核心路径可运行[主路径]（WHEN 点击开始按钮 → 拥有掌控感')
    })

    it('无 mode 参数（现状调用）→ 无头注；开关关闭 → 无类别', () => {
      const plain = renderGwtSkeleton(makeBackplane())
      expect(plain[0].content).not.toContain('必测类别')
      process.env.BLOMA_INJECT_GWT = '0'
      const off = renderGwtSkeleton(makeBackplane(), 'longterm')
      expect(off[0].content).not.toContain('必测类别')
    })

    it('场景名保持 itemId+断言对账兼容（judge 前缀对账不受类别标注破坏——标注在 Scenario 标题，gwt-runner 场景名独立生成）', () => {
      const features = renderGwtSkeleton(makeBackplane(), 'quick')
      expect(features[0].content).toContain('Scenario:')
    })

    it('P1-9：game 类型必测类别差异化（状态机/碰撞/胜负边界，替代边界/异常输入）', () => {
      expect(gwtRequiredCategories('quick', 'standard', 'game')).toEqual(['主路径(P0)', '状态机', '碰撞', '胜负边界'])
      const bp = makeBackplane()
      bp.template_meta = { type: 'game', level: 'standard', version: 1 }
      bp.requirements = [{ id: 'F-001', description: '贪吃蛇', priority: 'P0', behavior_assertions: ['点击暂停→菜单显示'] }]
      const content = renderGwtSkeleton(bp, 'quick')[0].content
      expect(content).toContain('状态机')
      expect(content).toContain('碰撞')
      expect(content).toContain('胜负边界')
      expect(content).not.toContain('Scenario: 边界输入不崩溃')
      expect(content).not.toContain('Scenario: 异常输入不崩溃')
    })
  })
})
