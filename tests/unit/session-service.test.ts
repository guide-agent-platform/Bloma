import { restorePromaHome } from '../support/proma-home-guard'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { archiveProject, createProject, findProject, listProjects, updateProject } from '../../main/project/project-service'
import {
  cleanOrphanSessions,
  listSessions,
  loadConversationHistory,
  loadMessages,
  readPrimaryIntent,
  readSessionsForTest,
  recordSessionActivity,
  setProjectTouchHandler,
  writeSessionsForTest,
} from '../../main/platform/sessions/session-service'

// PR4 后续：平台件已去域依赖，测试接真源（与 main/index 接线同款；项目缺席静默）
setProjectTouchHandler((projectId, patch) => {
  try {
    updateProject(projectId, patch)
  } catch {
    /* 测试场景项目缺席静默 */
  }
})
import { getAgentSessionPath } from '../../storage/config-paths'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function useTemporaryHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix))
  process.env.PROMA_HOME = home
  return home
}

function writeSessionJsonl(home: string, sessionId: string, lines: unknown[]): void {
  const path = join(home, 'agent-sessions', sessionId)
  mkdirSync(dirname(`${path}.jsonl`), { recursive: true })
  writeFileSync(`${path}.jsonl`, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8')
}

describe('project conversation recovery', () => {
  it('recovers consecutive main sessions, nested collaboration and cancelled settle without including other projects or forks', () => {
    const oldHome = process.env.PROMA_HOME
    const home = useTemporaryHome('project-history-')
    try {
      recordSessionActivity('early', 'p')
      recordSessionActivity('latest', 'p')
      recordSessionActivity('other', 'other-project')
      recordSessionActivity('child', 'p', { parentSessionId: 'early', sourceDelegationId: 'd' })
      const index = readSessionsForTest()
      index.sessions.push({ ...index.sessions[0]!, session_id: 'alternative', parent_session_id: 'early', fork_entry_id: 'first' })
      writeSessionsForTest(index)
      const message = (id: string, timestamp: number) => ({ id, timestamp, role: 'user', content: [{ type: 'text', text: id }] })
      writeSessionJsonl(home, 'early', [message('first', 1)])
      writeSessionJsonl(home, 'latest', [message('later', 3)])
      writeSessionJsonl(home, 'other', [message('private-other-project', 2)])
      writeSessionJsonl(home, 'alternative', [message('alternative-only', 4)])
      writeSessionJsonl(home, 'child', [{ role: 'user', timestamp: 2, content: [{ type: 'text', text: '协作子任务（role=implement）：\n实现资料导入' }] }, { delegation_settle: 'cancelled' }])
      const result = loadMessages({ request_id: 'restore', session_id: 'latest', include_project_history: true, limit: 1000 })
      expect(result.messages.map(m => m.id)).toEqual(['first', 'later'])
      expect(result.messages[0].source_session_id).toBe('early')
      expect(result.delegations).toEqual([{ delegation_id: 'd', child_session_id: 'child', role: 'implement', goal: '实现资料导入', status: 'cancelled' }])
      const fork = loadMessages({ request_id: 'fork-restore', session_id: 'alternative', include_project_history: true })
      expect(fork.messages.map(m => m.id)).toEqual(['alternative-only'])
    } finally { restorePromaHome(oldHome) }
  })
})

describe('SessionService 会话索引', () => {
  it('recordSessionActivity 首次调用创建索引记录并回填 Project.last_session_id', () => {
    const originalHome = process.env.PROMA_HOME
    const home = useTemporaryHome('session-index-')
    try {
      const project = createProject({ request_id: 'req-1', mode: 'quick' })
      recordSessionActivity('session-new', project.project_id)

      const sessions = listSessions({ request_id: 'req-2' }).sessions
      expect(sessions).toHaveLength(1)
      expect(sessions[0]).toMatchObject({
        session_id: 'session-new',
        project_id: project.project_id,
        status: 'active',
      })
      expect(sessions[0].jsonl_path.startsWith(home)).toBe(true)

      expect(findProject(project.project_id).last_session_id).toBe('session-new')
    } finally {
      restorePromaHome(originalHome)
    }
  })

  it('委派子会话活动只入索引、不改写 last_session_id（首跑深修 2026-09-26）', () => {
    const originalHome = process.env.PROMA_HOME
    useTemporaryHome('session-child-meta-')
    try {
      const project = createProject({ request_id: 'req-1', mode: 'quick' })
      recordSessionActivity('session-main', project.project_id)
      expect(findProject(project.project_id).last_session_id).toBe('session-main')

      recordSessionActivity('session-child', project.project_id, { parentSessionId: 'session-main', sourceDelegationId: 'd-1' })
      // 子会话照常入索引（含归属字段；listSessions 会过滤子会话，用原始索引核对）
      const child = readSessionsForTest().sessions.find((item) => item.session_id === 'session-child')
      expect((child as { parent_session_id?: string } | undefined)?.parent_session_id).toBe('session-main')
      expect(findProject(project.project_id).last_session_id).toBe('session-main')
    } finally {
      restorePromaHome(originalHome)
    }
  })

  it('再次调用只刷新 updated_at，保留 created_at', async () => {
    const originalHome = process.env.PROMA_HOME
    const home = useTemporaryHome('session-update-')
    try {
      recordSessionActivity('session-again', 'project-a')
      const first = listSessions({ request_id: 'req-1' }).sessions[0]
      await sleep(10)
      recordSessionActivity('session-again', 'project-b')

      const [record] = listSessions({ request_id: 'req-2' }).sessions
      expect(record.created_at).toBe(first.created_at)
      expect(record.updated_at >= record.created_at).toBe(true)
      expect(record.project_id).toBe('project-b')
    } finally {
      restorePromaHome(originalHome)
    }
  })

  it('项目不存在时静默跳过 last_session_id 回填（兼容测试/演示环境）', () => {
    const originalHome = process.env.PROMA_HOME
    useTemporaryHome('session-no-project-')
    try {
      expect(() => recordSessionActivity('session-orphan', 'project-missing')).not.toThrow()
      const sessions = listSessions({ request_id: 'req-1' }).sessions
      expect(sessions).toHaveLength(1)
    } finally {
      restorePromaHome(originalHome)
    }
  })

  it('listSessions 按 project_id 过滤并按 updated_at 倒序', async () => {
    const originalHome = process.env.PROMA_HOME
    const home = useTemporaryHome('session-filter-')
    try {
      recordSessionActivity('session-old', 'project-x')
      await sleep(10)
      recordSessionActivity('session-new', 'project-y')
      await sleep(10)
      // 再更新 project-x 的会话，使其更新为最新
      recordSessionActivity('session-old', 'project-x')

      const filtered = listSessions({ request_id: 'req-1', project_id: 'project-x' }).sessions
      expect(filtered.map((s) => s.session_id)).toEqual(['session-old'])

      const all = listSessions({ request_id: 'req-2' }).sessions
      expect(all.map((s) => s.session_id)).toEqual(['session-old', 'session-new'])
    } finally {
      restorePromaHome(originalHome)
    }
  })

  it('listSessions 过滤委派子会话（source_delegation_id 非空不出列表——未命名对话刷屏根治；fork 分支可见）', () => {
    const originalHome = process.env.PROMA_HOME
    const home = useTemporaryHome('session-child-filter-')
    try {
      recordSessionActivity('session-main', 'project-z')
      // 直接写入索引：模拟委派子会话（review-delegation 建的审查件）与 fork 分支会话
      const index = readSessionsForTest()
      index.sessions.push({
        session_id: 'child-a',
        project_id: 'project-z',
        status: 'active',
        jsonl_path: join(home, 'agent-sessions', 'child-a.jsonl'),
        created_at: '2026-09-19T00:00:00.000Z',
        updated_at: '2026-09-19T00:00:01.000Z',
        parent_session_id: 'review-xyz',
        source_delegation_id: 'dlg-1',
      } as never)
      index.sessions.push({
        session_id: 'fork-a',
        project_id: 'project-z',
        status: 'active',
        jsonl_path: join(home, 'agent-sessions', 'fork-a.jsonl'),
        created_at: '2999-01-01T00:00:02.000Z',
        updated_at: '2999-01-01T00:00:03.000Z',
        parent_session_id: 'session-main',
        fork_entry_id: 'entry-9',
      } as never)
      writeSessionsForTest(index)
      const listed = listSessions({ request_id: 'req-3' }).sessions
      expect(listed.map((s) => s.session_id)).toEqual(['fork-a', 'session-main'])
    } finally {
      restorePromaHome(originalHome)
    }
  })
})

describe('SessionService 清理孤儿会话（U11）', () => {
  it('移除指向已删除/不存在项目的会话，保留归档项目的会话', () => {
    const originalHome = process.env.PROMA_HOME
    const home = useTemporaryHome('session-clean-')
    try {
      const project = createProject({ request_id: 'req-1', mode: 'quick' })
      archiveProject({ request_id: 'req-2', project_id: project.project_id })
      recordSessionActivity('session-keep', project.project_id)

      recordSessionActivity('session-orphan', 'project-missing')
      writeSessionJsonl(home, 'session-orphan', [
        { role: 'user', content: [{ type: 'text', text: 'x' }], timestamp: 1 },
      ])

      const result = cleanOrphanSessions(new Set(listProjects('all').map((p) => p.project_id)))

      expect(result.removed).toBe(1)
      const ids = listSessions({ request_id: 'req-3' }).sessions.map((s) => s.session_id)
      expect(ids).toContain('session-keep')
      expect(ids).not.toContain('session-orphan')
      expect(existsSync(getAgentSessionPath('session-orphan'))).toBe(false)
    } finally {
      restorePromaHome(originalHome)
    }
  })
})

describe('SessionService 历史消息读取', () => {
  it('loadMessages 读取 JSONL，默认排除 [terminal] 内部终态行', () => {
    const originalHome = process.env.PROMA_HOME
    const home = useTemporaryHome('session-load-')
    try {
      recordSessionActivity('session-load', 'project-z')
      writeSessionJsonl(home, 'session-load', [
        { role: 'user', content: [{ type: 'text', text: '你好' }], timestamp: 1 },
        { role: 'assistant', content: [{ type: 'text', text: '在的' }], timestamp: 2 },
        { role: 'system', content: [{ type: 'text', text: '[terminal] status=completed' }], timestamp: 3 },
      ])

      const result = loadMessages({ request_id: 'req-1', session_id: 'session-load' })
      expect(result.total).toBe(2)
      expect(result.truncated).toBe(false)
      expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
      expect(result.messages.every((m) => !m.content.some((b) => b.text?.startsWith('[terminal]')))).toBe(true)
      expect(result.session.session_id).toBe('session-load')
    } finally {
      restorePromaHome(originalHome)
    }
  })

  it('loadMessages 支持 limit 尾部截取并置 truncated', () => {
    const originalHome = process.env.PROMA_HOME
    const home = useTemporaryHome('session-limit-')
    try {
      recordSessionActivity('session-limit', 'project-z')
      const lines = Array.from({ length: 10 }, (_, i) => ({
        role: 'user' as const,
        content: [{ type: 'text', text: `消息${i}` }],
        timestamp: i,
      }))
      writeSessionJsonl(home, 'session-limit', lines)

      const result = loadMessages({ request_id: 'req-1', session_id: 'session-limit', limit: 3 })
      expect(result.total).toBe(10)
      expect(result.truncated).toBe(true)
      expect(result.messages).toHaveLength(3)
      expect(result.messages.at(-1)?.content[0].text).toBe('消息9')
    } finally {
      restorePromaHome(originalHome)
    }
  })

  it('JSONL 不存在时抛 SESSION_NOT_FOUND', () => {
    const originalHome = process.env.PROMA_HOME
    useTemporaryHome('session-missing-')
    try {
      expect(() => loadMessages({ request_id: 'req-1', session_id: 'ghost' })).toThrow('SESSION_NOT_FOUND')
    } finally {
      restorePromaHome(originalHome)
    }
  })

  it('JSONL 存在但索引缺失时按文件 mtime 合成会话记录', () => {
    const originalHome = process.env.PROMA_HOME
    const home = useTemporaryHome('session-orphan-file-')
    try {
      writeSessionJsonl(home, 'legacy-session', [
        { role: 'user', content: [{ type: 'text', text: '遗留数据' }], timestamp: 1 },
      ])

      const result = loadMessages({ request_id: 'req-1', session_id: 'legacy-session' })
      expect(result.messages).toHaveLength(1)
      expect(result.session.session_id).toBe('legacy-session')
      expect(result.session.project_id).toBe('')
    } finally {
      restorePromaHome(originalHome)
    }
  })
})

describe('SessionService readPrimaryIntent 主题锚点（D4 无实质内容豁免）', () => {
  /** 2026-08-22 线上案例：会话以「你好」开场，第二轮用户点「你帮我决定」卡——
   * 问候语若被当主题锚点前置 F-001，真正的需求全被挤到 F-002。 */
  function readIntent(lines: unknown[]): string | undefined {
    const originalHome = process.env.PROMA_HOME
    const home = useTemporaryHome('session-intent-')
    try {
      writeSessionJsonl(home, 'session-intent', lines)
      return readPrimaryIntent('session-intent')
    } finally {
      restorePromaHome(originalHome)
    }
  }

  const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 })

  it('首条是纯问候 → 跳过，取首条有实质内容的 user 消息', () => {
    for (const greeting of ['你好', '你好呀！', 'hi', 'HELLO', '在吗', '早上好']) {
      expect(readIntent([user(greeting), user('我想做个记账工具')]), greeting).toBe('我想做个记账工具')
    }
  })

  it('让渡话术（含点选 auto 卡的落盘原文「你帮我决定」）不配当锚点', () => {
    expect(readIntent([user('你好'), user('你帮我决定')])).toBeUndefined()
    expect(readIntent([user('我还没想法'), user('记账的')])).toBe('记账的')
  })

  it('trim 后不足 2 字的输入跳过', () => {
    expect(readIntent([user('好'), user('做菜谱')])).toBe('做菜谱')
  })

  it('带实质内容的消息不受影响（含问候词但非整句问候）', () => {
    expect(readIntent([user('你好，我想做个记账本')])).toBe('你好，我想做个记账本')
    expect(readIntent([user('帮我做一个音乐合成器')])).toBe('帮我做一个音乐合成器')
  })

  it('全部无实质内容 → undefined；无会话文件 → undefined', () => {
    expect(readIntent([user('你好'), user('嗯')])).toBeUndefined()
    const originalHome = process.env.PROMA_HOME
    useTemporaryHome('session-intent-empty-')
    try {
      expect(readPrimaryIntent('no-such-session')).toBeUndefined()
    } finally {
      restorePromaHome(originalHome)
    }
  })
})

describe('loadConversationHistory 缺省不含工具轨迹（P1-05 旧行为回归）', () => {
  // 自 completion-claims.test.ts 迁入（2026-10-03 删留执行）：该文件另两例锁的
  // hasWriteEditToolCall 与 includeToolTrace=true 均为生产不可达路径（反证见删留清单），
  // 仅本例（缺省 false 的旧行为零变化）是活路径。
  it('缺省 includeToolTrace=false：纯 tool_result 轮跳过，assistant 无工具行（零变化回归）', () => {
    const originalHome = process.env.PROMA_HOME
    const home = useTemporaryHome('session-trace-')
    try {
      const path = getAgentSessionPath('s-trace-2')
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, [
        JSON.stringify({ role: 'user', content: '帮我把清空功能修好' }),
        JSON.stringify({
          role: 'assistant',
          content: [
            { type: 'text', text: '我先修改清空逻辑。' },
            { type: 'tool_use', id: 't1', name: 'edit_file', input: { path: 'src/app.js' } },
            { type: 'tool_use', id: 't2', name: 'run_gwt_tests', input: {} },
          ],
        }),
        JSON.stringify({
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: '已写入' },
            { type: 'tool_result', tool_use_id: 't2', content: '失败 1 项', is_error: true },
          ],
        }),
        JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: '还差一点。' }] }),
      ].join('\n') + '\n', 'utf8')

      const turns = loadConversationHistory('s-trace-2', 10)
      expect(turns.some((t) => t.content.includes('[本轮工具]'))).toBe(false)
      expect(turns.some((t) => t.content.includes('[工具结果回执]'))).toBe(false)
      // 纯 tool_result 的 user 轮（text 空）照旧被跳过
      expect(turns.filter((t) => t.role === 'user')).toEqual([{ role: 'user', content: '帮我把清空功能修好' }])
    } finally {
      restorePromaHome(originalHome)
    }
  })
})
