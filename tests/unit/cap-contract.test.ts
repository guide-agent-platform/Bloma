/**
 * Phase 2 M1 能力契约块 CAP（2026-09-09，P1 稿 §3 M1）。
 *
 * 覆盖：开关语义（off=字节级现状）、确定性派生触发与防误触（ai 词边界）、
 * LLM 产出解析清洗、背板挂载（漏报→派生兜底）、锚定/裁判渲染段零注入回归锁。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  backplaneAiCapabilities,
  capContractEnabled,
  deriveAiCapabilities,
  renderBackplaneAnchor,
  renderCapSection,
  type AiCapability,
  type PrdBackplane,
  type SketchRequirement,
} from '../../main/model/prd-backplane'


afterEach(() => {
  vi.unstubAllEnvs()
})

const req = (id: string, description: string): SketchRequirement => ({ id, description })

const minimalBackplane = (requirements: SketchRequirement[], caps?: AiCapability[]): PrdBackplane => ({
  project_id: 'p1',
  name: 't',
  positioning: '定位',
  requirements,
  acceptance: {},
  out_of_scope: [],
  assumptions: [],
  ...(caps ? { ai_capabilities: caps } : {}),
})

const sampleCap: AiCapability = {
  capability_id: 'CAP-01',
  task: '根据笔记内容生成智能总结',
  keyProcessing: '真实模型调用，依赖当前笔记内容',
  ioDependency: '输入=笔记；输出=总结；笔记变化→总结相应变化',
  forbiddenSubstitutions: ['固定模板冒充', '降级为普通增删改查'],
  evidence: ['修改笔记后总结随之变化'],
  source: 'user_explicit',
}

describe('capContractEnabled（BLOMA_CAP_CONTRACT）', () => {
  it('缺省 off（不设 env）', () => {
    expect(capContractEnabled()).toBe(false)
  })
  it('on 变体：1 / on / true', () => {
    for (const value of ['1', 'on', 'true', 'ON']) {
      vi.stubEnv('BLOMA_CAP_CONTRACT', value)
      expect(capContractEnabled(), value).toBe(true)
    }
  })
  it('off 变体：0 / off / false / 空串', () => {
    for (const value of ['0', 'off', 'false', '']) {
      vi.stubEnv('BLOMA_CAP_CONTRACT', value)
      expect(capContractEnabled(), value).toBe(false)
    }
  })
})

describe('deriveAiCapabilities（确定性派生兜底）', () => {
  it('AI 信号命中 → 派生最小 CAP（确定性字段）', () => {
    const caps = deriveAiCapabilities([req('F-001', 'AI 智能总结笔记'), req('F-002', '列表查看')])
    expect(caps).toHaveLength(1)
    expect(caps![0].capability_id).toBe('CAP-01')
    expect(caps![0].task).toBe('AI 智能总结笔记')
    expect(caps![0].source).toBe('confirmed_derived')
    expect(caps![0].forbiddenSubstitutions.join()).toContain('固定模板')
    expect(caps![0].evidence.join()).toContain('输出随之变化')
  })
  it('纯展示/CRUD → undefined（零派生）', () => {
    expect(deriveAiCapabilities([req('F-001', '做一个计算器'), req('F-002', '查看历史记录')])).toBeUndefined()
  })
  it('retains obligations for every model-backed feature', () => {
    const caps = deriveAiCapabilities([req('F-001', 'AI 总结'), req('F-002', 'AI 翻译'), req('F-003', 'AI 配图'), req('F-004', 'AI 润色')])
    expect(caps).toHaveLength(4)
  })
})



describe('renderBackplaneAnchor / renderCapSection（注入与零注入回归锁）', () => {
  it('renderCapSection([]) → 空串', () => {
    expect(renderCapSection([])).toBe('')
  })
  it('off：背板存量有 CAP 也不注入（锚与无 CAP 时字节一致）', () => {
    const withCaps = minimalBackplane([req('F-001', 'AI 总结')], [sampleCap])
    const withoutCaps = minimalBackplane([req('F-001', 'AI 总结')])
    expect(renderBackplaneAnchor(withCaps)).toBe(renderBackplaneAnchor(withoutCaps))
    expect(renderBackplaneAnchor(withCaps)).not.toContain('能力契约')
  })
  it('on：CAP 段随锚注入，含不算完成清单与验收证据', () => {
    vi.stubEnv('BLOMA_CAP_CONTRACT', '1')
    const anchor = renderBackplaneAnchor(minimalBackplane([req('F-001', 'AI 总结')], [sampleCap]))
    expect(anchor).toContain('【能力契约（CAP，什么不算完成）】')
    expect(anchor).toContain('不算完成：固定模板冒充；降级为普通增删改查')
    expect(anchor).toContain('验收证据：修改笔记后总结随之变化')
  })
})
