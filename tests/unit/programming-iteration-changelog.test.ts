import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncIterationCompleted } from '../../main/coding/programming-orchestrator'

const { syncDocumentsMock } = vi.hoisted(() => ({
  syncDocumentsMock: vi.fn(() => ({ documents: [{ type: 'changelog', status: 'synced' }], stale_documents: [] })),
}))

vi.mock('../../main/project/document-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/project/document-engine')>()
  return { ...actual, syncDocuments: syncDocumentsMock }
})

vi.mock('../../main/project/project-service', () => ({
  findProject: () => ({
    project_id: 'project-iter-changelog',
    name: '迭代变更记录项目',
    mode: 'quick',
    workspace_slug: 'test-workspace',
    root_path: '/tmp/proma-test-root',
    current_stage: 'ready',
    created_at: Date.now(),
    updated_at: Date.now(),
  }),
  updateProject: vi.fn(() => ({})),
  readLastSketchRequirements: () => [
    { id: 'F-001', description: '记录收入与支出' },
    { id: 'F-002', description: '导出月度报表' },
  ],
  recordSketchGenerated: vi.fn(),
}))

vi.mock('../../main/platform/llm/channel-manager', () => ({
  getChannelByIdRaw: () => undefined,
  decryptApiKey: () => '',
  getFirstEnabledChannel: () => undefined,
}))

/**
 * GA-03 后半（PRD §7.1 触发节点「每轮迭代结束后」）：
 * runIterationTask 成功收尾时经 syncIterationCompleted 触发 iteration_completed
 * 检查点追加 Changelog。helper 采用 fire-and-forget（与 distillProjectMemorySafely
 * 同模式）：文档同步失败绝不阻断迭代收尾；熔断/取消路径不调用本 helper。
 */
describe('syncIterationCompleted（迭代收尾 changelog 触发）', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('[S4-DOCUMENT-002] 以 iteration_completed 检查点同步文档，字段正确透传', () => {
    const result = syncIterationCompleted({
      request_id: 'req-iter',
      session_id: 'session-iter',
      project_id: 'project-iter-changelog',
    })

    expect(syncDocumentsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: 'req-iter',
        session_id: 'session-iter',
        project_id: 'project-iter-changelog',
        checkpoint: 'iteration_completed',
      }),
    )
    expect(syncDocumentsMock).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ documents: [{ type: 'changelog', status: 'synced' }], stale_documents: [] })
  })

  it('[S4-DOCUMENT-003] changelog 写盘失败时静默降级，返回空结果且不阻断迭代收尾（fire-and-forget）', () => {
    syncDocumentsMock.mockImplementationOnce(() => {
      throw new Error('DISK_FULL')
    })

    const result = syncIterationCompleted({
      request_id: 'req-iter',
      session_id: 'session-iter',
      project_id: 'project-iter-changelog',
    })
    // 静默降级契约：返回空结果而非 undefined/半成品
    expect(result).toEqual({ documents: [], stale_documents: [] })
  })
})
