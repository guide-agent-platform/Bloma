/**
 * 桌面调度员裁决围栏测试（批次 A，2026-09-24）。
 *
 * 覆盖：关1 锚定收集（两种锚定形态/句中丢弃/多标记/代码块行首）、关2 目标唯一性
 * （合法/跳级/回退/伪造/终态/防御性放行）、关3 产物验证（缺失/占位符/无门禁恒过）、
 * 三关总入口 evaluateAdvance、工具白名单（写族硬拦/白名单放行/未知拒绝/extraTools）。
 */
import { describe, expect, it } from 'vitest'
import type { MessageContentBlock } from '../../../shared/types'
import {
  DISPATCHER_BASE_TOOLS,
  DISPATCHER_WRITE_TOOLS,
  buildGateRejectionEdu,
  checkDispatcherToolGate,
  collectAdvanceMarks,
  evaluateAdvance,
  validateAdvanceTarget,
  verifyPhaseArtifacts,
} from '../../../main/desktop/dispatcher-gate'
import { DESKTOP_PHASES } from '../../../main/desktop/dispatcher-phases'

/** assistant 轮次构造：单 text 块。 */
function turn(text: string): MessageContentBlock[] {
  return [{ type: 'text', text }]
}

describe('关1：推进标记锚定收集', () => {
  it('注释形态收集', () => {
    const { marks, discarded } = collectAdvanceMarks([turn('骨架完成。\n<!-- PHASE_ADVANCE: desktop-implement -->')])
    expect(marks).toEqual(['desktop-implement'])
    expect(discarded).toEqual([])
  })

  it('行首形态收集（串首/换行后/缩进）', () => {
    const { marks } = collectAdvanceMarks([
      turn('PHASE_ADVANCE: desktop-arch'),
      turn('结论如上\n\n  PHASE_ADVANCE: desktop-scaffold\n后续说明'),
    ])
    expect(marks).toEqual(['desktop-arch', 'desktop-scaffold'])
  })

  it('句中引用丢弃并记观测（含上下文样本）', () => {
    const { marks, discarded } = collectAdvanceMarks([
      turn('下一步我会输出 PHASE_ADVANCE: desktop-implement 来推进流程。'),
    ])
    expect(marks).toEqual([])
    expect(discarded).toHaveLength(1)
    expect(discarded[0].target).toBe('desktop-implement')
    expect(discarded[0].context).toContain('下一步我会输出')
  })

  it('代码块内的行首标记仍收集（独立行声明视为真实意图）', () => {
    const { marks } = collectAdvanceMarks([turn('```text\nPHASE_ADVANCE: delivered\n```')])
    expect(marks).toEqual(['delivered'])
  })

  it('大小写归一', () => {
    const { marks } = collectAdvanceMarks([turn('<!-- phase_advance: Delivered -->'.replace('Delivered', 'delivered'))])
    expect(marks).toEqual(['delivered'])
  })

  it('非 text 块不扫（tool_use/tool_result 跳过）', () => {
    const blocks: MessageContentBlock[] = [
      { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
      { type: 'tool_result', tool_use_id: 't1', content: 'PHASE_ADVANCE: delivered' },
    ]
    const { marks } = collectAdvanceMarks([blocks])
    expect(marks).toEqual([])
  })

  it('同轮多标记按出现序全量保留', () => {
    const { marks } = collectAdvanceMarks([turn('PHASE_ADVANCE: desktop-arch\n<!-- PHASE_ADVANCE: desktop-arch -->')])
    expect(marks).toEqual(['desktop-arch', 'desktop-arch'])
  })
})

describe('关2：推进目标唯一性校验', () => {
  it('合法目标放行（next 唯一）', () => {
    expect(validateAdvanceTarget('desktop-arch', 'desktop-scaffold')).toEqual({ ok: true })
  })

  it('跳级拒绝（desktop-arch → desktop-implement）', () => {
    const result = validateAdvanceTarget('desktop-arch', 'desktop-implement')
    expect(result).toEqual({ ok: false, expected: 'desktop-scaffold', reason: 'not-next' })
  })

  it('回退拒绝（desktop-implement → desktop-arch）', () => {
    const result = validateAdvanceTarget('desktop-implement', 'desktop-arch')
    expect(result).toEqual({ ok: false, expected: 'desktop-verify', reason: 'not-next' })
  })

  it('伪造枚举外目标拒绝', () => {
    const result = validateAdvanceTarget('desktop-arch', 'coding')
    expect(result).toEqual({ ok: false, expected: 'desktop-scaffold', reason: 'unknown-target' })
  })

  it('终态一律拒绝', () => {
    const result = validateAdvanceTarget('delivered', 'requirements')
    expect(result).toEqual({ ok: false, expected: null, reason: 'terminal' })
  })

  it('current 不在表内 → 防御性放行（宁放行不卡死）', () => {
    expect(validateAdvanceTarget('mode-select', 'desktop-arch')).toEqual({ ok: true })
  })
})

describe('关3：产物存在性验证', () => {
  it('门禁产物全部存在 → 通过且记录 checked', () => {
    const exists = (p: string) => p === '00_ARCH/architecture.md' || p === '00_ARCH/env-checklist.json'
    const result = verifyPhaseArtifacts(DESKTOP_PHASES['desktop-arch'], exists)
    expect(result.passed).toBe(true)
    expect(result.checked).toEqual(['00_ARCH/architecture.md', '00_ARCH/env-checklist.json'])
  })

  it('产物缺失 → 失败并按门禁归组', () => {
    const result = verifyPhaseArtifacts(DESKTOP_PHASES['desktop-arch'], () => false)
    expect(result.passed).toBe(false)
    expect(result.missing).toEqual([
      { gateId: 'arch-decision', artifacts: ['00_ARCH/architecture.md'] },
      { gateId: 'env-checklist', artifacts: ['00_ARCH/env-checklist.json'] },
    ])
  })

  it('占位符渲染：{{project_name}} 注入', () => {
    const node = {
      ...DESKTOP_PHASES['desktop-arch'],
      gates: [{ id: 'g1', kind: 'artifact' as const, description: 'd', artifacts: ['00_ARCH/{{project_name}}.md'] }],
    }
    const seen: string[] = []
    const result = verifyPhaseArtifacts(node, (p) => { seen.push(p); return true }, { project_name: 'clip-tool' })
    expect(seen).toEqual(['00_ARCH/clip-tool.md'])
    expect(result.passed).toBe(true)
  })

  it('未知占位符保留原样（不抛错）', () => {
    const node = {
      ...DESKTOP_PHASES['desktop-arch'],
      gates: [{ id: 'g1', kind: 'artifact' as const, description: 'd', artifacts: ['{{unknown_var}}.md'] }],
    }
    const seen: string[] = []
    verifyPhaseArtifacts(node, (p) => { seen.push(p); return true })
    expect(seen).toEqual(['{{unknown_var}}.md'])
  })

  it('driver/manual 门禁不参与存在性核验；无 artifact 门禁恒通过', () => {
    expect(verifyPhaseArtifacts(DESKTOP_PHASES['desktop-implement'], () => false, {}).checked).toEqual(['DELIVERY.md'])
    expect(verifyPhaseArtifacts(DESKTOP_PHASES.requirements, () => false).passed).toBe(true)
  })
})

describe('三关总入口 evaluateAdvance', () => {
  const allExist = () => true

  it('合法推进：目标正确且门禁产物齐备 → advance', () => {
    const decision = evaluateAdvance(
      [turn('架构三件齐备，确认通过。\nPHASE_ADVANCE: desktop-scaffold')],
      'desktop-arch',
      allExist,
    )
    expect(decision).toMatchObject({ decision: 'advance', target: 'desktop-scaffold' })
  })

  it('无标记 → reject(no-marks) + 三段式教育文案', () => {
    const decision = evaluateAdvance([turn('做完了。')], 'desktop-arch', allExist)
    expect(decision.decision).toBe('reject')
    if (decision.decision === 'reject') {
      expect(decision.reason).toBe('no-marks')
      expect(decision.education).toContain('发生了什么')
      expect(decision.education).toContain('为什么拒')
      expect(decision.education).toContain('正确做法')
    }
  })

  it('句中引用不构成推进（丢弃观测随结果返回）', () => {
    const decision = evaluateAdvance(
      [turn('我准备输出 PHASE_ADVANCE: desktop-scaffold 推进')],
      'desktop-arch',
      allExist,
    )
    expect(decision.decision).toBe('reject')
    if (decision.decision === 'reject') {
      expect(decision.reason).toBe('no-marks')
      expect(decision.discardedObservations).toHaveLength(1)
    }
  })

  it('同轮分歧目标 → reject(multiple-divergent)', () => {
    const decision = evaluateAdvance(
      [turn('PHASE_ADVANCE: desktop-scaffold\n<!-- PHASE_ADVANCE: delivered -->')],
      'desktop-arch',
      allExist,
    )
    expect(decision).toMatchObject({ decision: 'reject', reason: 'multiple-divergent' })
  })

  it('跳级 → reject(not-next)，expected 携带唯一合法目标', () => {
    const decision = evaluateAdvance([turn('PHASE_ADVANCE: delivered')], 'desktop-arch', allExist)
    expect(decision).toMatchObject({ decision: 'reject', reason: 'not-next', expected: 'desktop-scaffold' })
  })

  it('产物缺失 → reject(artifacts-missing)，missingArtifacts 归组', () => {
    const decision = evaluateAdvance([turn('PHASE_ADVANCE: desktop-scaffold')], 'desktop-arch', () => false)
    expect(decision.decision).toBe('reject')
    if (decision.decision === 'reject') {
      expect(decision.reason).toBe('artifacts-missing')
      expect(decision.missingArtifacts).toEqual([
        { gateId: 'arch-decision', artifacts: ['00_ARCH/architecture.md'] },
        { gateId: 'env-checklist', artifacts: ['00_ARCH/env-checklist.json'] },
      ])
      expect(decision.education).toContain('00_ARCH/architecture.md')
    }
  })

  it('driver 门禁在批次 A 按 artifacts 存在性核验（执行器批次 C 兑现，声明即核验）', () => {
    const decision = evaluateAdvance([turn('PHASE_ADVANCE: delivered')], 'desktop-verify', allExist)
    expect(decision).toMatchObject({ decision: 'advance', target: 'delivered' })
  })

  it('current 异常 → 与关2 一致防御性放行', () => {
    const decision = evaluateAdvance([turn('PHASE_ADVANCE: desktop-arch')], 'mode-select', allExist)
    expect(decision).toMatchObject({ decision: 'advance', target: 'desktop-arch' })
  })
})

describe('拒收教育文案', () => {
  it('各拒因均有三段式且包含关键信息', () => {
    const cases: Array<[Parameters<typeof buildGateRejectionEdu>[0], string]> = [
      ['no-marks', '未收集到任何锚定形态'],
      ['multiple-divergent', '多个不同目标'],
      ['unknown-target', '不在阶段表枚举内'],
      ['not-next', '唯一合法目标'],
      ['terminal', '终态'],
      ['artifacts-missing', '产物验证未通过'],
    ]
    for (const [reason, keyword] of cases) {
      const text = buildGateRejectionEdu(reason, { current: 'desktop-arch', actual: 'x', expected: 'desktop-scaffold', missing: 'a.md' })
      expect(text, reason).toContain('发生了什么')
      expect(text, reason).toContain('为什么拒')
      expect(text, reason).toContain('正确做法')
      expect(text, reason).toContain(keyword)
    }
  })
})

describe('canUseTool 工具白名单', () => {
  it('写文件族硬拦（含 extraTools 声明了写族的 fail-closed 场景）', () => {
    for (const tool of DISPATCHER_WRITE_TOOLS) {
      const result = checkDispatcherToolGate(DESKTOP_PHASES['desktop-arch'], tool)
      expect(result?.deny, tool).toBe(true)
      expect(result?.message, tool).toContain('不直接写文件')
    }
    // 数据错误防线：extraTools 声明 write_file 仍被硬拦（fail-closed）
    const rogue = { ...DESKTOP_PHASES['desktop-arch'], extraTools: ['write_file'] }
    expect(checkDispatcherToolGate(rogue, 'write_file')?.deny).toBe(true)
  })

  it('基础白名单放行（委派族/只读族/决策卡/会话元工具）', () => {
    for (const tool of ['delegate_agent', 'wait_for_delegations', 'read_file', 'grep', 'guide_decide', 'compact_context']) {
      expect(checkDispatcherToolGate(DESKTOP_PHASES['desktop-scaffold'], tool), tool).toBeNull()
      expect(DISPATCHER_BASE_TOOLS.has(tool), tool).toBe(true)
    }
  })

  it('白名单外工具拒绝并教育（列出可用面）', () => {
    const result = checkDispatcherToolGate(DESKTOP_PHASES['desktop-arch'], 'run_preview')
    expect(result?.deny).toBe(true)
    expect(result?.message).toContain('不在阶段')
    expect(result?.message).toContain('delegate_agent')
  })

  it('阶段 extraTools 扩展放行（如 desktop-implement 的预览工具声明位）', () => {
    const node = { ...DESKTOP_PHASES['desktop-implement'], extraTools: ['run_desktop_preview'] }
    expect(checkDispatcherToolGate(node, 'run_desktop_preview')).toBeNull()
    // 其他阶段不继承该扩展
    expect(checkDispatcherToolGate(DESKTOP_PHASES['desktop-verify'], 'run_desktop_preview')?.deny).toBe(true)
  })
})
