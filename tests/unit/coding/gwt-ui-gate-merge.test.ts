import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * 接线契约测试：runGwtWithApiContract 必须每次执行 L0 UI 完整性门禁，并把失败
 * 合并进 GwtTestResult（复用 api-contract 先例）——这是"硬门禁不是软约束"的
 * 结构保证：初始终验与修复轮重验走同一函数，无法旁路。
 */

vi.mock('../../../main/gwt-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../main/gwt-service')>()
  return { ...actual, runGwtScenarios: vi.fn(async () => ({ total_count: 3, passed_count: 3, failed_count: 0, failure_summary: [] })) }
})
vi.mock('../../../main/document-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../main/document-engine')>()
  return { ...actual, readPrdBackplane: vi.fn(() => '') }
})
vi.mock('../../../main/coding/artifact-ui-gate', () => ({
  runArtifactUiGate: vi.fn(),
  uiGateEnabled: vi.fn(() => true),
}))
vi.mock('../../../main/coding/api-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../main/coding/api-contract')>()
  return { ...actual, checkApiContract: vi.fn(), backplaneInterfaceSpec: vi.fn(() => []) }
})
vi.mock('../../../main/decision-log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../main/decision-log')>()
  return { ...actual, recordDecision: vi.fn() }
})

import { runGwtWithApiContract } from '../../../main/coding/programming-orchestrator'
import { runArtifactUiGate } from '../../../main/coding/artifact-ui-gate'

const gateMock = vi.mocked(runArtifactUiGate)

beforeEach(() => gateMock.mockReset())

describe('runGwtWithApiContract × L0 门禁', () => {
  it('GWT 全绿但门禁判败 → 失败合并进结果（计数与 failure_summary）', async () => {
    gateMock.mockResolvedValue({
      status: 'failed',
      failures: [{ scenario: 'UI-GATE 产物界面必须包含真交互控件', reason: '真控件 0 个，伪装控件 2 个' }],
    })
    const result = await runGwtWithApiContract({ project_id: 'p1', session_id: 's1', preview_url: 'http://127.0.0.1:1/preview' })
    expect(result.total_count).toBe(4)
    expect(result.failed_count).toBe(1)
    expect(result.failure_summary[0].scenario).toContain('UI-GATE')
    expect(gateMock).toHaveBeenCalledTimes(1)
    expect(gateMock.mock.calls[0][0].previewUrl).toBe('http://127.0.0.1:1/preview')
  })

  it('门禁 passed → 结果原样透传', async () => {
    gateMock.mockResolvedValue({ status: 'passed', failures: [] })
    const result = await runGwtWithApiContract({ project_id: 'p1', session_id: 's1', preview_url: 'http://x' })
    expect(result.failed_count).toBe(0)
    expect(result.failure_summary).toEqual([])
  })

  it('门禁 unavailable → 不判败但必须落 unverified 可见（绝不静默放行）', async () => {
    gateMock.mockResolvedValue({ status: 'unavailable', failures: [], note: '预览页导航失败' })
    const result = await runGwtWithApiContract({ project_id: 'p1', session_id: 's1', preview_url: 'http://x' })
    expect(result.failed_count).toBe(0)
    expect(result.unverified?.some((u) => u.includes('UI 完整性门禁未执行'))).toBe(true)
  })

  it('无 preview_url（存量场景）→ 门禁跳过执行但不报错', async () => {
    const result = await runGwtWithApiContract({ project_id: 'p1', session_id: 's1' })
    expect(result.failed_count).toBe(0)
    expect(gateMock).not.toHaveBeenCalled()
  })
})
