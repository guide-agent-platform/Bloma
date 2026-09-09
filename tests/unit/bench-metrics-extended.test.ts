import { describe, expect, it } from 'vitest'
import { computeExtendedMetrics } from '../../bench/harness/metrics.mjs'

/**
 * P0 Phase 0.5 指标扩容单测：锁六项新指标的确定性口径（bench/README 指标矩阵）。
 * bench/*.mjs 为零依赖 ESM，vitest 直接 import（与 calibrate-loop-params 同风格）。
 */

const baseEvidence = (overrides = {}) => ({
  project: { id: 'p1', stage: 'ready' },
  session: { userMessages: [{ text: '做一个记账页面' }] },
  docs: { prd: { requirements: [{ description: '记录收入支出' }], positioning: '' } },
  analytics: { mvpDelivered: true, turnTokens: [{ turns: 5, in: 1000 }, { turns: 6, in: 2000 }] },
  artifacts: { hits: {} },
  assistantIntegrity: { assistantTurns: 10, protocolLeakTurns: 0, emptyTextTurns: 0, degenerateTurns: 0 },
  terminal: { kind: 'converged', stage: 'ready' },
  ...overrides,
})

describe('computeExtendedMetrics（指标扩容 8→14）', () => {
  it('基线：健康 CRUD 任务无违规、非 AI 任务 capRetention=n/a、token 汇总', () => {
    const m = computeExtendedMetrics(baseEvidence())
    expect(m.firstConstraintViolation.violated).toBe(false)
    expect(m.coreCapabilityRetention).toBe('n/a')
    expect(m.protocolLeakRate).toBe(0)
    expect(m.emptyBodyRate).toBe(0)
    expect(m.effectiveDeliveryTokens).toBe(3000)
  })

  it('首次约束违规：localStorage 命中且无 serverRoutes/apiLlm → localstorage-only（435ca2c 渠道绕过特征）', () => {
    const m = computeExtendedMetrics(baseEvidence({
      artifacts: { hits: { localStorage: 3, serverRoutes: 0, apiLlm: 0 } },
    }))
    expect(m.firstConstraintViolation.violated).toBe(true)
    expect(m.firstConstraintViolation.details[0]?.code).toBe('localstorage-only')
  })

  it('首次约束违规：有 serverRoutes 时 localStorage 不算违规（前后端分离正常使用）', () => {
    const m = computeExtendedMetrics(baseEvidence({
      artifacts: { hits: { localStorage: 3, serverRoutes: 5, apiLlm: 0 } },
    }))
    expect(m.firstConstraintViolation.violated).toBe(false)
  })

  it('核心能力保留：AI 意图 + PRD 保留语义 + 产物接入 = 1；只保留 PRD = 0.5；蒸馏 = 0', () => {
    const aiWanted = {
      session: { userMessages: [{ text: '做一个 AI 随心记，智能总结' }] },
      docs: { prd: { requirements: [{ description: 'AI 自动总结记录' }], positioning: '' } },
    }
    expect(computeExtendedMetrics(baseEvidence({ ...aiWanted, artifacts: { hits: { apiLlm: 2 } } })).coreCapabilityRetention).toBe(1)
    expect(computeExtendedMetrics(baseEvidence({ ...aiWanted, artifacts: { hits: {} } })).coreCapabilityRetention).toBe(0.5)
    expect(computeExtendedMetrics(baseEvidence({
      session: { userMessages: [{ text: '做一个 AI 随心记，智能总结' }] },
      docs: { prd: { requirements: [{ description: '新增和查看记录' }], positioning: '' },
      },
      artifacts: { hits: {} },
    })).coreCapabilityRetention).toBe(0)
  })

  it('协议泄漏率与空正文率：按 assistant 轮归一', () => {
    const m = computeExtendedMetrics(baseEvidence({
      assistantIntegrity: { assistantTurns: 20, protocolLeakTurns: 1, emptyTextTurns: 2 },
    }))
    expect(m.protocolLeakRate).toBeCloseTo(0.05)
    expect(m.emptyBodyRate).toBeCloseTo(0.1)
  })

  it('有效交付 token：未收敛（stalled）不计入', () => {
    const m = computeExtendedMetrics(baseEvidence({ terminal: { kind: 'stalled', stage: 'generating_mvp' }, project: { id: 'p1', stage: 'generating_mvp' } }))
    expect(m.effectiveDeliveryTokens).toBeNull()
  })

  it('错误触发计数：会话含【历史经验】注入段计数（B0 开关 off 恒 0 的基线占位口径）', () => {
    const m = computeExtendedMetrics(baseEvidence({
      session: { userMessages: [{ text: '【历史经验】xxx' }, { text: '【常见错法】yyy' }] },
    }))
    expect(m.wrongTriggerCount).toBe(2)
  })
})
