/**
 * 阶段推进 checkpoint 测试（刀2，2026-10-02 确认协议与呈现层战役）。
 *
 * 覆盖：结论构建形态（勿重验/推进目标/快照存证行）、写入链路（快照成功落库 /
 * 快照失败容错——结论仍有效 / 落库失败返回 null 不阻断）。
 * updateProject/createSnapshot 均 mock（真实 I/O 链路已由 dispatcher-loop 的
 * PROMA_HOME 真实目录测试覆盖）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopCheckpoint } from '../../../shared/types'

vi.mock('../../../main/project/project-service', () => ({
  updateProject: vi.fn(),
}))
vi.mock('../../../main/delivery/snapshots', () => ({
  createSnapshot: vi.fn(),
}))

import { updateProject } from '../../../main/project/project-service'
import { createSnapshot } from '../../../main/delivery/snapshots'
import { buildCheckpointConclusion, recordPhaseCheckpoint } from '../../../main/desktop/phase-checkpoint'

const mockUpdateProject = vi.mocked(updateProject)
const mockCreateSnapshot = vi.mocked(createSnapshot)

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('buildCheckpointConclusion 续跑注入形态', () => {
  const checkpoint: DesktopCheckpoint = {
    stage: 'desktop-verify',
    at: '2026-10-02T15:00:00.000Z',
    snapshot_id: 'snap-1',
    verified_gates: ['driver-report: 7/7 场景 PASS（pass）', 'security-scan: 通过（42 文件扫描，0 高危）', 'judge-gate: 硬约束通过'],
  }

  it('完整形态：结论清单 + 快照存证行 + 勿重验指示与推进目标', () => {
    const text = buildCheckpointConclusion(checkpoint, 'delivered')
    expect(text).toContain('上一轮（2026-10-02T15:00:00.000Z）本阶段门禁已全部验证通过')
    expect(text).toContain('- driver-report: 7/7 场景 PASS（pass）')
    expect(text).toContain('- security-scan: 通过（42 文件扫描，0 高危）')
    expect(text).toContain('- 阶段快照已存证：snap-1')
    expect(text).toContain('勿重验')
    expect(text).toContain('PHASE_ADVANCE: delivered')
    expect(text).toContain('不要重新执行驱动、安全扫描或任何已通过的验证')
  })

  it('无快照 id 时省略存证行（快照失败结论仍有效）', () => {
    const text = buildCheckpointConclusion({ ...checkpoint, snapshot_id: undefined }, 'delivered')
    expect(text).not.toContain('阶段快照已存证')
  })

  it('终态目标（next=null）：只给结论清单，不出推进标记行', () => {
    const text = buildCheckpointConclusion(checkpoint, null)
    expect(text).not.toContain('PHASE_ADVANCE')
  })
})

describe('recordPhaseCheckpoint 写入链路', () => {
  it('快照成功 → snapshot_id 入 checkpoint + updateProject 落库', async () => {
    mockCreateSnapshot.mockResolvedValue({
      snapshot_id: 'snap-9', project_id: 'p1', kind: 'mvp', name: '', summary: '',
      files_archive_path: '', health_status: 'healthy', verification: 'verified', created_at: new Date().toISOString(),
    } as never)
    const result = await recordPhaseCheckpoint({
      projectId: 'p1', requestId: 'r1', stage: 'desktop-verify',
      gates: ['driver-report: 3/3 PASS'], summary: 's', verification: 'verified',
    })
    expect(mockCreateSnapshot).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p1', verification: 'verified', include_documents: true }))
    expect(result).toMatchObject({ stage: 'desktop-verify', snapshot_id: 'snap-9', verified_gates: ['driver-report: 3/3 PASS'] })
    expect(mockUpdateProject).toHaveBeenCalledWith('p1', expect.objectContaining({
      desktop_checkpoint: expect.objectContaining({ stage: 'desktop-verify' }),
    }))
  })

  it('快照失败 → 容错继续：checkpoint 无 snapshot_id，结论仍落库（fail-open）', async () => {
    mockCreateSnapshot.mockRejectedValue(new Error('DISK_FULL'))
    const result = await recordPhaseCheckpoint({
      projectId: 'p1', requestId: 'r1', stage: 'desktop-scaffold',
      gates: ['scaffold-contract: 产物核验通过'], summary: 's', verification: 'recoverable',
    })
    expect(result).toMatchObject({ stage: 'desktop-scaffold' })
    expect(result?.snapshot_id).toBeUndefined()
    expect(mockUpdateProject).toHaveBeenCalled()
  })

  it('落库失败 → 返回 null（不阻断推进）', async () => {
    mockCreateSnapshot.mockResolvedValue({
      snapshot_id: 's', project_id: 'p1', kind: 'mvp', name: '', summary: '',
      files_archive_path: '', health_status: 'healthy', created_at: new Date().toISOString(),
    } as never)
    mockUpdateProject.mockImplementation(() => { throw new Error('PROJECT_NOT_FOUND') })
    const result = await recordPhaseCheckpoint({
      projectId: 'ghost', requestId: 'r1', stage: 'desktop-arch', gates: [], summary: 's', verification: 'recoverable',
    })
    expect(result).toBeNull()
  })
})
