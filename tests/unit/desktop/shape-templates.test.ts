/**
 * 批9 形状体系单测（2026-10-07）：
 * - parseProductShape 白名单解析与降级（prd-engine-llm）；
 * - evaluateShapeGate 确定性拦截规则（open questions 铁律/结构缺口/空候选）；
 * - renderShapeDigest / renderUxDigest 九态（requirement-digest）；
 * - shape-templates 表完整性校验 + renderShapeBrief/renderShapeVerifyBrief 条件求值。
 */
import { describe, expect, it } from 'vitest'
import {
  parseProductShape,
  evaluateShapeGate,
  parseUxExperience,
  buildBackplaneFromParsed,
} from '../../../main/guide/legacy-prd-parser'
import { renderShapeDigest, renderUxDigest } from '../../../main/desktop/requirement-digest'
import {
  SHAPE_TEMPLATES,
  validateShapeTemplateTable,
  evalShapeCondition,
  renderShapeBrief,
  renderShapeVerifyBrief,
  listShapeDefaults,
} from '../../../main/desktop/shape-templates'
import type { ProductShape } from '../../../main/model/prd-backplane'

/** 合法最小 shape 原始对象（record_manager）。 */
function validShapeRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    host_template: 'record_manager',
    modules: [],
    primary_loop: '打开→记一笔→列表可见',
    fact_source: '每笔记录',
    needs_resident: false,
    needs_network: false,
    task_duration: 'instant',
    destructive_ops: [],
    llm_role: 'none',
    job_policy: { cancellable: true, progress: true, close_policy: 'wait_or_confirm' },
    candidates: [{ template: 'record_manager', reasons: ['事实来源是记录'] }],
    architecture_open_questions: [],
    ...overrides,
  }
}

describe('parseProductShape（批9 工件1：白名单解析）', () => {
  it('合法输入完整采纳（含默认值兑底）', () => {
    const shape = parseProductShape(validShapeRaw())
    expect(shape).toBeDefined()
    expect(shape?.host_template).toBe('record_manager')
    expect(shape?.job_policy.close_policy).toBe('wait_or_confirm')
    expect(shape?.candidates).toHaveLength(1)
  })

  it('host_template 非四模板白名单 → undefined（降级不 fail）', () => {
    expect(parseProductShape(validShapeRaw({ host_template: 'data_workspace' }))).toBeUndefined()
    expect(parseProductShape(validShapeRaw({ host_template: '桌面工具' }))).toBeUndefined()
  })

  it('llm_role 白名单外 → undefined；五档合法', () => {
    expect(parseProductShape(validShapeRaw({ llm_role: 'strong' }))).toBeUndefined()
    for (const role of ['none', 'core', 'optional', 'preview', 'user_config']) {
      expect(parseProductShape(validShapeRaw({ llm_role: role }))?.llm_role).toBe(role)
    }
  })

  it('task_duration 白名单外 / primary_loop 或 fact_source 缺失 → undefined', () => {
    expect(parseProductShape(validShapeRaw({ task_duration: 'forever' }))).toBeUndefined()
    expect(parseProductShape(validShapeRaw({ primary_loop: '' }))).toBeUndefined()
    expect(parseProductShape(validShapeRaw({ fact_source: '  ' }))).toBeUndefined()
  })

  it('非法输入类型（null/数组/字符串）→ undefined', () => {
    expect(parseProductShape(null)).toBeUndefined()
    expect(parseProductShape([])).toBeUndefined()
    expect(parseProductShape('record_manager')).toBeUndefined()
  })

  it('非对象输入与脏字段保守过滤（candidates 脏条丢弃）', () => {
    const shape = parseProductShape(
      validShapeRaw({
        candidates: [{ template: '' }, 'garbage', { template: 'file_pipeline', reasons: ['批量'] }, null],
      }),
    )
    expect(shape?.candidates).toHaveLength(1)
    expect(shape?.candidates[0].template).toBe('file_pipeline')
  })

  it('job_policy 用户口径保留：cancellable=false 采纳（progress 缺省 true）', () => {
    const shape = parseProductShape(validShapeRaw({ job_policy: { cancellable: false, close_policy: 'wait' } }))
    expect(shape?.job_policy.cancellable).toBe(false)
    expect(shape?.job_policy.progress).toBe(true)
    expect(shape?.job_policy.close_policy).toBe('wait')
  })
})

describe('evaluateShapeGate（批9 工件1：确定性拦截规则）', () => {
  it('shape 缺省 → pass（无形状增强不拦截）', () => {
    expect(evaluateShapeGate(undefined)).toEqual({ pass: true, questions: [] })
  })

  it('architecture_open_questions 非空 → 拦截（铁律：高置信也不豁免）', () => {
    const shape = parseProductShape(validShapeRaw({ architecture_open_questions: ['数据只在本次会话还是要关掉不丢？'] }))
    const gate = evaluateShapeGate(shape)
    expect(gate.pass).toBe(false)
    expect(gate.questions).toContain('数据只在本次会话还是要关掉不丢？')
  })

  it('结构齐备且无未决 → pass', () => {
    expect(evaluateShapeGate(parseProductShape(validShapeRaw())).pass).toBe(true)
  })

  it('结构字段缺失（绕过 parse 的存量背板）→ 拦截并给出缺口清单', () => {
    const broken = { ...(parseProductShape(validShapeRaw()) as ProductShape) }
    delete (broken as Record<string, unknown>).task_duration
    delete (broken as Record<string, unknown>).llm_role
    const gate = evaluateShapeGate(broken as ProductShape)
    expect(gate.pass).toBe(false)
    expect(gate.questions.some((q) => q.includes('任务时长档') && q.includes('AI 角色'))).toBe(true)
  })

  it('candidates 为空 → 拦截（无法想象任何形状）', () => {
    const shape = parseProductShape(validShapeRaw({ candidates: [] }))
    expect(evaluateShapeGate(shape).pass).toBe(false)
  })
})

describe('parseUxExperience 九态（批9 工件5 扩展）', () => {
  it('cancelled/unconfigured 进白名单可解析', () => {
    const ux = parseUxExperience({
      states: [
        { id: 'empty', observable: '空态' },
        { id: 'cancelled', observable: '任务取消后显示已取消徽章' },
        { id: 'unconfigured', observable: '无 key 时显示配置引导' },
      ],
      feedback_rules: [],
    })
    expect(ux?.states.map((s) => s.id)).toEqual(['empty', 'cancelled', 'unconfigured'])
  })

  it('白名单外状态仍被过滤', () => {
    const ux = parseUxExperience({ states: [{ id: 'loading_forever', observable: 'x' }] })
    expect(ux).toBeUndefined()
  })
})

describe('buildBackplaneFromParsed shape 挂接', () => {
  it('parsed.shape 合法 → 背板携带 shape（冻结载体）', () => {
    const backplane = buildBackplaneFromParsed(
      {
        document: '# PRD',
        positioning: '测试',
        acceptance: {},
        ux: undefined,
        shape: parseProductShape(validShapeRaw({ host_template: 'job_runner', task_duration: 'long_running' })),
        out_of_scope: [],
        assumptions: [],
      },
      [{ id: 'F-001', description: '挂机下载器' }],
      'proj-1',
    )
    expect(backplane.shape?.host_template).toBe('job_runner')
    expect(backplane.shape?.task_duration).toBe('long_running')
  })
})

describe('renderShapeDigest / renderUxDigest（requirement-digest 九态）', () => {
  it('shape 摘要含主循环/事实来源/job_policy 与 LLM 角色语义', () => {
    const shape = parseProductShape(
      validShapeRaw({ llm_role: 'user_config', host_template: 'record_manager' }),
    )
    const digest = renderShapeDigest(shape)
    expect(digest).toContain('打开→记一笔→列表可见')
    expect(digest).toContain('每笔记录')
    expect(digest).toContain('user_config')
    expect(digest).toContain('unconfigured') // 无 key 引导界面语义（待配置态）
  })

  it('llm_role=none 不渲染 AI 角色行；shape 缺省返回 undefined', () => {
    const digest = renderShapeDigest(parseProductShape(validShapeRaw()))
    expect(digest).not.toContain('AI 角色')
    expect(renderShapeDigest(undefined)).toBeUndefined()
  })

  it('destructive_ops 非空时渲染破坏性操作行', () => {
    const digest = renderShapeDigest(
      parseProductShape(validShapeRaw({ destructive_ops: ['覆盖原文件'] })),
    )
    expect(digest).toContain('覆盖原文件')
    expect(digest).toContain('必须确认或备份')
  })
})

describe('shape-templates 表完整性（批9 工件2）', () => {
  it('四模板表校验通过（conditional 带 condition/invariant+forbidden 最小骨架/九态白名单）', () => {
    const validation = validateShapeTemplateTable()
    expect(validation.violations).toEqual([])
    expect(validation.valid).toBe(true)
  })

  it('缺模板/坏规则被校验捕获', () => {
    const broken = { ...SHAPE_TEMPLATES } as Record<string, typeof SHAPE_TEMPLATES.record_manager>
    delete broken.instant_utility
    const validation = validateShapeTemplateTable(broken)
    expect(validation.violations.some((v) => v.includes('缺模板 instant_utility'))).toBe(true)

    const badRule = {
      ...SHAPE_TEMPLATES.record_manager,
      rules: [{ kind: 'conditional', requirement: '无条件的条件规则' } as never],
    }
    const validation2 = validateShapeTemplateTable({ ...SHAPE_TEMPLATES, record_manager: badRule })
    expect(validation2.violations.some((v) => v.includes('conditional 规则缺 condition'))).toBe(true)
  })

  it('listShapeDefaults 返回 default 规则子集', () => {
    const defaults = listShapeDefaults('job_runner')
    expect(defaults.length).toBeGreaterThan(0)
    expect(defaults.every((rule) => rule.kind === 'default')).toBe(true)
  })
})

describe('evalShapeCondition（条件求值器）', () => {
  const base = parseProductShape(validShapeRaw()) as ProductShape
  it('task_duration/llm_role/job_policy/destructive_ops 求值', () => {
    expect(evalShapeCondition('task_duration == instant', base)).toBe(true)
    expect(evalShapeCondition('task_duration != instant', base)).toBe(false)
    expect(evalShapeCondition('llm_role != none', base)).toBe(false)
    expect(evalShapeCondition('job_policy.cancellable == true', base)).toBe(true)
    expect(evalShapeCondition('destructive_ops != empty', base)).toBe(false)
  })

  it('字段白名单外/语法非法 → 保守不命中', () => {
    expect(evalShapeCondition('theme == dark', base)).toBe(false)
    expect(evalShapeCondition('随便写的', base)).toBe(false)
  })
})

describe('renderShapeBrief / renderShapeVerifyBrief（任务书注入渲染）', () => {
  it('record_manager：硬门/禁实现/UI 拼装进 brief；required_tests 进 verify brief', () => {
    const brief = renderShapeBrief(parseProductShape(validShapeRaw()))
    expect(brief).toContain('形状纪律')
    expect(brief).toContain('关掉重新打开数据仍在')
    expect(brief).toContain('禁无确认的不可逆删除')
    expect(brief).toContain('App.renderList')

    const verify = renderShapeVerifyBrief(parseProductShape(validShapeRaw()))
    expect(verify).toContain('重启读取')
    expect(verify).toContain('未保存关闭')
    expect(verify).toContain('导入导出+备份恢复')
  })

  it('job_runner cancellable=false：取消规则不渲染、不可取消规则渲染（job_policy 条件展开）', () => {
    const noCancel = parseProductShape(
      validShapeRaw({ host_template: 'job_runner', job_policy: { cancellable: false, progress: true, close_policy: 'wait' } }),
    )
    const brief = renderShapeBrief(noCancel) ?? ''
    expect(brief).not.toContain('执行中可取消')
    expect(brief).toContain('关闭窗口按 close_policy 执行')

    const verify = renderShapeVerifyBrief(noCancel) ?? ''
    expect(verify).not.toContain('取消生效：状态转入已取消')
    expect(verify).toContain('处理中关闭')
  })

  it('job_runner cancellable=true：取消规则渲染 + verify 必备测试含取消项', () => {
    const cancellable = parseProductShape(
      validShapeRaw({ host_template: 'job_runner', task_duration: 'long_running' }),
    )
    const brief = renderShapeBrief(cancellable) ?? ''
    expect(brief).toContain('执行中可取消')
    expect(brief).toContain('长任务必须有进度反馈') // conditional 命中渲染
    const verify = renderShapeVerifyBrief(cancellable) ?? ''
    expect(verify).toContain('取消生效：状态转入已取消')
  })

  it('llm_role≠none：LLM 交付语义进 brief + 分层断言进 verify brief', () => {
    const llmShape = parseProductShape(validShapeRaw({ llm_role: 'core', host_template: 'record_manager' }))
    expect(renderShapeBrief(llmShape)).toContain('Provider Qualification')
    expect(renderShapeVerifyBrief(llmShape)).toContain('分层断言')
    // user_config：待配置态语义
    const userConfig = parseProductShape(validShapeRaw({ llm_role: 'user_config' }))
    expect(renderShapeBrief(userConfig)).toContain('待配置态')
  })

  it('shape 缺省 → 两渲染均 undefined（无形状增强，行为等同批8）', () => {
    expect(renderShapeBrief(undefined)).toBeUndefined()
    expect(renderShapeVerifyBrief(undefined)).toBeUndefined()
  })
})
