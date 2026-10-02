/**
 * 桌面调度员阶段表测试（批次 A，2026-09-24）。
 *
 * 覆盖：schema 自洽、表完整性校验（含各类违规形态）、查询函数、
 * 架构验证点演示——插入「打包自检」阶段只改数据零代码改动。
 */
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_PHASES,
  DESKTOP_PHASE_TABLE,
  getDesktopPhase,
  getNextDesktopPhase,
  listDesktopPhases,
  listDispatcherManagedPhases,
  validateDesktopPhaseTable,
  type PhaseNode,
} from '../../../main/desktop/dispatcher-phases'

describe('dispatcher-phases 阶段表 schema', () => {
  it('内置阶段表通过完整性校验', () => {
    const result = validateDesktopPhaseTable()
    expect(result.valid).toBe(true)
    expect(result.violations).toEqual([])
  })

  it('表数组与记录键集一致且保持声明序', () => {
    expect(DESKTOP_PHASE_TABLE).toEqual([
      'requirements',
      'desktop-arch',
      'desktop-scaffold',
      'desktop-implement',
      'desktop-verify',
      'delivered',
    ])
    expect(new Set(Object.keys(DESKTOP_PHASES))).toEqual(new Set(DESKTOP_PHASE_TABLE))
  })

  it('链形态：requirements 起点、delivered 终态、next 线性单链', () => {
    expect(DESKTOP_PHASES.requirements.next).toBe('desktop-arch')
    expect(DESKTOP_PHASES['desktop-arch'].next).toBe('desktop-scaffold')
    expect(DESKTOP_PHASES['desktop-scaffold'].next).toBe('desktop-implement')
    expect(DESKTOP_PHASES['desktop-implement'].next).toBe('desktop-verify')
    expect(DESKTOP_PHASES['desktop-verify'].next).toBe('delivered')
    expect(DESKTOP_PHASES.delivered.next).toBeNull()
  })

  it('requirements 复用向导管线（dispatcherManaged=false），桌面阶段由调度员接管', () => {
    expect(DESKTOP_PHASES.requirements.dispatcherManaged).toBe(false)
    const managed = listDispatcherManagedPhases().map((n) => n.id)
    expect(managed).toEqual(['desktop-arch', 'desktop-scaffold', 'desktop-implement', 'desktop-verify'])
  })

  it('artifact/driver 门禁均声明非空 artifacts（批次 C 执行器契约）', () => {
    for (const node of listDesktopPhases()) {
      for (const gate of node.gates) {
        if (gate.kind === 'artifact' || gate.kind === 'driver') {
          expect(gate.artifacts, `${node.id}/${gate.id}`).toBeDefined()
          expect(gate.artifacts?.length, `${node.id}/${gate.id}`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('刀1 撤 manual 门：接管阶段零 manual 门禁且 requiresUserConfirmation 恒 false（人工只保留 Intent 层）', () => {
    for (const node of listDispatcherManagedPhases()) {
      expect(node.gates.some((g) => g.kind === 'manual'), `${node.id} 不应残留 manual 门`).toBe(false)
      expect(node.requiresUserConfirmation, `${node.id} 接管阶段应为 false`).toBe(false)
      // 防空门禁直通：非终态接管节点仍至少一条 artifact/driver 门
      if (node.next !== null) expect(node.gates.length).toBeGreaterThan(0)
    }
    // Intent 层（requirements 复用向导管线）仍声明确认
    expect(DESKTOP_PHASES.requirements.requiresUserConfirmation).toBe(true)
  })
})

describe('validateDesktopPhaseTable 违规形态', () => {
  const base = (): Record<string, PhaseNode> =>
    DESKTOP_PHASE_TABLE.reduce((acc, id) => {
      acc[id] = { ...DESKTOP_PHASES[id], gates: DESKTOP_PHASES[id].gates.map((g) => ({ ...g })) }
      return acc
    }, {} as Record<string, PhaseNode>)

  it('表数组含节点但记录缺失 → coverage 违规', () => {
    const phases = base()
    delete phases['desktop-verify']
    const result = validateDesktopPhaseTable(phases, DESKTOP_PHASE_TABLE)
    expect(result.valid).toBe(false)
    expect(result.violations.some((v) => v.startsWith('coverage:'))).toBe(true)
  })

  it('记录有节点但未登记进表数组 → coverage 违规', () => {
    const phases = base()
    const table: string[] = [...DESKTOP_PHASE_TABLE, 'desktop-package']
    const result = validateDesktopPhaseTable(phases, table)
    expect(result.valid).toBe(false)
    expect(result.violations.some((v) => v.startsWith('coverage:') && v.includes('desktop-package'))).toBe(true)
  })

  it('next 指向不存在节点 → next 违规且链断', () => {
    const phases = base()
    phases['desktop-verify'].next = 'desktop-nope'
    const result = validateDesktopPhaseTable(phases, DESKTOP_PHASE_TABLE)
    expect(result.valid).toBe(false)
    expect(result.violations.some((v) => v.startsWith('next:'))).toBe(true)
    expect(result.violations.some((v) => v.includes('不可达 delivered'))).toBe(true)
  })

  it('环 → chain 违规（环 + 不可达终态）', () => {
    const phases = base()
    phases['desktop-implement'].next = 'desktop-arch'
    const result = validateDesktopPhaseTable(phases, DESKTOP_PHASE_TABLE)
    expect(result.valid).toBe(false)
    expect(result.violations.some((v) => v.includes('环'))).toBe(true)
    expect(result.violations.some((v) => v.includes('不可达 delivered'))).toBe(true)
  })

  it('artifact 门禁缺 artifacts → gate 违规', () => {
    const phases = base()
    phases['desktop-arch'].gates[0] = { ...phases['desktop-arch'].gates[0], artifacts: undefined }
    const result = validateDesktopPhaseTable(phases, DESKTOP_PHASE_TABLE)
    expect(result.valid).toBe(false)
    expect(result.violations.some((v) => v.startsWith('gate:') && v.includes('arch-decision'))).toBe(true)
  })

  it('非终态节点门禁清空 → gate 违规（防空门禁直通）', () => {
    const phases = base()
    phases['desktop-scaffold'].gates = []
    const result = validateDesktopPhaseTable(phases, DESKTOP_PHASE_TABLE)
    expect(result.valid).toBe(false)
    expect(result.violations.some((v) => v.includes('无任何门禁'))).toBe(true)
  })

  it('双终态 → chain 违规', () => {
    const phases = base()
    phases['desktop-verify'].next = null
    const result = validateDesktopPhaseTable(phases, DESKTOP_PHASE_TABLE)
    expect(result.valid).toBe(false)
    expect(result.violations.some((v) => v.includes('终态不唯一'))).toBe(true)
  })
})

describe('查询函数', () => {
  it('getDesktopPhase：已知 id 返回节点，未知 id 返回 undefined', () => {
    expect(getDesktopPhase('desktop-arch')?.role).toBe('桌面架构师')
    expect(getDesktopPhase('nope')).toBeUndefined()
  })

  it('getNextDesktopPhase：唯一合法目标；终态 null', () => {
    expect(getNextDesktopPhase('desktop-arch')).toBe('desktop-scaffold')
    expect(getNextDesktopPhase('delivered')).toBeNull()
  })

  it('listDesktopPhases 保持声明序', () => {
    expect(listDesktopPhases().map((n) => n.id)).toEqual([...DESKTOP_PHASE_TABLE])
  })
})

describe('架构验证点（实施稿验收 3 演示项）：插阶段只改数据零代码改动', () => {
  it('在 desktop-verify 前插入 desktop-package 后，表校验与查询函数自动成立', () => {
    // ── 只改数据：复制阶段表数据，插入「打包自检」阶段并改两处 next ──
    const phases: Record<string, PhaseNode> = DESKTOP_PHASE_TABLE.reduce((acc, id) => {
      acc[id] = { ...DESKTOP_PHASES[id], gates: DESKTOP_PHASES[id].gates.map((g) => ({ ...g })) }
      return acc
    }, {} as Record<string, PhaseNode>)
    phases['desktop-package'] = {
      id: 'desktop-package',
      role: '桌面打包工程师',
      title: '打包自检（可选插阶段演示）',
      taskTemplate: 'pyinstaller 单文件打包 + 打包产物冒烟自检（启动即退出探活）。',
      outputPath: '00_PACKAGE',
      constraints: ['打包产物必须能脱离 Python 环境启动'],
      requiresUserConfirmation: false,
      retryLimit: 1,
      next: 'delivered',
      gates: [
        { id: 'package-artifact', kind: 'artifact', description: '打包自检清单存在', artifacts: ['00_PACKAGE/checklist.md'] },
      ],
      extraTools: [],
      dispatcherManaged: true,
    }
    phases['desktop-verify'].next = 'desktop-package'
    const table: string[] = [...DESKTOP_PHASE_TABLE]
    table.splice(table.indexOf('delivered'), 0, 'desktop-package')

    // ── 零代码改动：既有校验/查询函数直接认识新阶段 ──
    const validation = validateDesktopPhaseTable(phases, table)
    expect(validation.valid, validation.violations.join('; ')).toBe(true)
    expect(phases['desktop-verify'].next).toBe('desktop-package')

    // 唯一合法目标随之移动：verify 的推进目标不再是 delivered（数据驱动，无硬编码）
    expect(phases['desktop-verify'].next).not.toBe('delivered')
  })
})
