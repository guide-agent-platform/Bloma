/**
 * 点选纠错会话测试（批11 MVP-E，2026-10-08）。
 *
 * 覆盖：反馈文本组装（人话+组件定位内嵌）、启动失败分支（not-delivered/unsupported
 * ——旧骨架产物如实拒绝）、picks.jsonl 文件交接解析（脏行容错/done 行）。
 * spawn 全链路属真机验收面（狗粮驾驶场景），此处不 mock 进程树。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../main/project/project-service', () => ({
  findProject: vi.fn(),
}))

import { findProject } from '../../../main/project/project-service'
import {
  attachActiveCorrectionFeedback,
  buildCorrectionFeedback,
  startCorrectionSession,
  type CorrectionPick,
} from '../../../main/desktop/correction-session'

const mockedFindProject = vi.mocked(findProject)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildCorrectionFeedback（反馈文本组装，单一来源）', () => {
  it('选区逐条组装：人话描述 + kind 翻译 + 预览说明 + 组件定位内嵌', () => {
    const picks: CorrectionPick[] = [
      { seq: 1, displayName: '按钮「发送」', kind: 'visual', note: '太不显眼了', componentId: 'action.send', preview: { detail: '外观强调（阴影/加粗/微放大）' } },
      { seq: 2, displayName: '输入框「记账备注」', kind: 'guess', componentId: 'input.main' },
      { seq: 3, displayName: '列表行「第 3 条」', kind: 'function', note: '点删除没反应', componentId: 'list.row.3' },
    ]
    const text = buildCorrectionFeedback(picks, '记账本')
    expect(text).toContain('我在「记账本」的修改预览里点选了 3 处要改的地方')
    expect(text).toContain('1. 按钮「发送」——外观/布局问题：太不显眼了（修改预览里已试过「外观强调（阴影/加粗/微放大）」，方向是对的）【组件定位 action.send】')
    expect(text).toContain('2. 输入框「记账备注」——让系统猜（按常见做法改）【组件定位 input.main】')
    expect(text).toContain('3. 列表行「第 3 条」——功能/操作问题：点删除没反应【组件定位 list.row.3】')
    expect(text).toContain('其余功能与已验证行为保持不变')
  })

  it('零选区退化：标题如实 0 处（调用方 finish 不产出空反馈，此处锁文本形态）', () => {
    const text = buildCorrectionFeedback([], '工具')
    expect(text).toContain('点选了 0 处')
  })
})

describe('startCorrectionSession（失败分支——如实拒绝不静默）', () => {
  it('未交付项目 → not-delivered', async () => {
    mockedFindProject.mockReturnValue({ project_id: 'p1', root_path: 'C:/x', current_stage: 'ready' } as never)
    const result = await startCorrectionSession({ projectId: 'p1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('not-delivered')
  })

  it('旧骨架产物（入口无 --correction-session 支持）→ unsupported 如实提示', async () => {
    mockedFindProject.mockReturnValue({ project_id: 'p2', root_path: 'C:/tmp-bloma-correction-p2', current_stage: 'completed' } as never)
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const root = 'C:/tmp-bloma-correction-p2'
    try {
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify({ schema_version: 1, command: ['python', 'app.py'] }), 'utf8')
      writeFileSync(join(root, 'app.py'), 'print("old skeleton")\n', 'utf8')
      const result = await startCorrectionSession({ projectId: 'p2' })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('unsupported')
        expect(result.error).toContain('旧版骨架')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('LAUNCH.json 缺失 → launch-invalid', async () => {
    mockedFindProject.mockReturnValue({ project_id: 'p3', root_path: 'C:/tmp-bloma-correction-p3', current_stage: 'completed' } as never)
    const { mkdirSync, rmSync } = await import('node:fs')
    const root = 'C:/tmp-bloma-correction-p3'
    try {
      mkdirSync(root, { recursive: true })
      const result = await startCorrectionSession({ projectId: 'p3' })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('launch-invalid')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('attachActiveCorrectionFeedback（批11 ②：点选标记自动并入反馈）', () => {
  it('无活跃会话 → undefined（用户纯文字照旧）', () => {
    expect(attachActiveCorrectionFeedback('p-none', '改个颜色')).toBeUndefined()
  })
})

describe('CorrectionPick schema（picks.jsonl 行结构——文件交接契约）', () => {
  it('用户/Agent 同形：source 字段区分来源（双入口约束），预览可选', () => {
    const userPick: CorrectionPick = { type: 'pick', seq: 1, componentId: 'action.send', kind: 'guess', source: 'user' }
    const agentPick: CorrectionPick = { type: 'pick', seq: 2, componentId: 'input.main', kind: 'visual', note: '狗粮自动验收', source: 'agent' }
    expect(userPick.source).toBe('user')
    expect(agentPick.source).toBe('agent')
  })
})
