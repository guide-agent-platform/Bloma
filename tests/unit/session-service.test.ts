import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProject, findProject } from '../../main/project-service'
import {
  listSessions,
  loadMessages,
  recordSessionActivity,
} from '../../main/session-service'

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
      process.env.PROMA_HOME = originalHome
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
      process.env.PROMA_HOME = originalHome
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
      process.env.PROMA_HOME = originalHome
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
      process.env.PROMA_HOME = originalHome
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
      process.env.PROMA_HOME = originalHome
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
      process.env.PROMA_HOME = originalHome
    }
  })

  it('JSONL 不存在时抛 SESSION_NOT_FOUND', () => {
    const originalHome = process.env.PROMA_HOME
    useTemporaryHome('session-missing-')
    try {
      expect(() => loadMessages({ request_id: 'req-1', session_id: 'ghost' })).toThrow('SESSION_NOT_FOUND')
    } finally {
      process.env.PROMA_HOME = originalHome
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
      process.env.PROMA_HOME = originalHome
    }
  })
})
