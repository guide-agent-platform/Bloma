import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getAgentSessionsIndexPath } from '../../storage/config-paths'
import { migrateLegacySessionsIndexOnce, recordSessionActivity } from '../../main/platform/sessions/session-service'

/**
 * 会话索引独立化（2026-09-04，陷阱 1/40 同模式）：Bloma 索引改 bloma-agent-sessions.json，
 * 与 Proma 的 agent-sessions.json 分离；启动幂等迁移只读旧写新、绝不动 Proma 文件。
 * 双开实测背景：475 条 Bloma 条目混入 Proma 索致其 UI 空标题+NaN 时间戳。
 */

describe('会话索引独立化（bloma-agent-sessions.json）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-sidx-'))
  })

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  it('索引路径指向专属文件（不再共用 agent-sessions.json）', () => {
    expect(getAgentSessionsIndexPath()).toContain('bloma-agent-sessions.json')
  })

  it('recordSessionActivity 写专属索引，不触碰 Proma 的 agent-sessions.json', () => {
    recordSessionActivity('s-new', 'p1')
    expect(existsSync(getAgentSessionsIndexPath())).toBe(true)
    const idx = JSON.parse(readFileSync(getAgentSessionsIndexPath(), 'utf8'))
    expect(idx.sessions.some((s: { session_id?: string }) => s.session_id === 's-new')).toBe(true)
    expect(existsSync(join(process.env.PROMA_HOME!, 'agent-sessions.json'))).toBe(false)
  })

  it('迁移：旧共用索引含 Bloma 条目 → 搬入新索引；Proma 条目留在旧文件原样不动', () => {
    const legacy = {
      version: 2,
      sessions: [
        { id: 'proma-1', title: 'Proma 会话', createdAt: 1788000000000, updatedAt: 1788000000000 },
        { session_id: 'bloma-1', project_id: 'p1', status: 'active', jsonl_path: 'x.jsonl', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' },
        { session_id: 'bloma-2', project_id: 'p1', status: 'active', jsonl_path: 'y.jsonl', created_at: '2026-09-02T00:00:00Z', updated_at: '2026-09-02T00:00:00Z' },
      ],
    }
    writeFileSync(join(process.env.PROMA_HOME!, 'agent-sessions.json'), JSON.stringify(legacy), 'utf8')

    const result = migrateLegacySessionsIndexOnce()
    expect(result.skipped).toBe(false)
    expect(result.migrated).toBe(2)

    const migrated = JSON.parse(readFileSync(getAgentSessionsIndexPath(), 'utf8'))
    expect(migrated.sessions.map((s: { session_id: string }) => s.session_id).sort()).toEqual(['bloma-1', 'bloma-2'])

    // 陷阱 40 保守原则：旧文件逐字节原样（Proma 条目不丢）
    expect(JSON.parse(readFileSync(join(process.env.PROMA_HOME!, 'agent-sessions.json'), 'utf8'))).toEqual(legacy)
  })

  it('迁移幂等：新索引已存在 → 跳过；旧文件不存在 → 跳过', () => {
    expect(migrateLegacySessionsIndexOnce()).toEqual({ migrated: 0, skipped: true }) // 旧不存在

    writeFileSync(join(process.env.PROMA_HOME!, 'agent-sessions.json'), JSON.stringify({
      sessions: [{ session_id: 'bloma-x', status: 'active' }],
    }), 'utf8')
    expect(migrateLegacySessionsIndexOnce().migrated).toBe(1)
    // 第二次：新索引已存在 → 跳过，不重复不覆盖
    expect(migrateLegacySessionsIndexOnce()).toEqual({ migrated: 0, skipped: true })
  })

  it('旧索引损坏（坏 JSON）→ 不迁移不抛错（新索引按需重建）', () => {
    writeFileSync(join(process.env.PROMA_HOME!, 'agent-sessions.json'), '{broken', 'utf8')
    expect(migrateLegacySessionsIndexOnce()).toEqual({ migrated: 0, skipped: true })
    expect(existsSync(getAgentSessionsIndexPath())).toBe(false)
  })
})
