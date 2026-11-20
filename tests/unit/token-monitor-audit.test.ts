import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { collectUsage } from '../../token monitor/usage'
import { addFindings, LocalAudit } from '../../token monitor/audit'

describe('token request audit', () => {
  it('retries incomplete rows once, persists unknown errors, and continues to other sessions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'bloma-audit-batch-error-'))
    try {
      await mkdir(join(home, 'usage-ledger'))
      await mkdir(join(home, 'agent-sessions'))
      const jsonl = (records: unknown[]) => records.map(record => JSON.stringify(record) + '\n').join('')
      const ledger = []
      const sessions = { main: ['saved', 'broken', 'recovered'], another: ['later', 'fresh'] }
      const started = Date.parse('2026-11-14T08:01:00Z')
      for (const [session, subjects] of Object.entries(sessions)) {
        const messages: unknown[] = [{ id: 'turn', role: 'user', timestamp: started, content: '修改代码' }]
        for (const subject of subjects) {
          const id = subject + '-tool'
          const base = { version: 1, project_id: 'p1', session_id: session, query_id: subject, turn_id: 'turn', phase: 'production' }
          ledger.push({ ...base, event: 'query_started', at: started + ledger.length + 1 },
            { ...base, event: 'query_finished', at: started + 10, status: 'completed', audit_tool_ids: [id] })
          const tool = { type: 'tool_use', id, name: 'edit_file', input: { path: subject + '.ts' } }
          messages.push({ id, role: 'assistant', timestamp: started + 15, content: [tool] })
        }
        await writeFile(join(home, 'agent-sessions', session + '.jsonl'), jsonl(messages))
      }
      await writeFile(join(home, 'usage-ledger', 'p1.jsonl'), jsonl(ledger))
      const batches: string[][] = []
      let manualRetry = false
      const request = vi.fn(async (url: string, options?: RequestInit) => {
        if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'qwen3.5:9b' }] })
        const payload = JSON.parse(JSON.parse(String(options?.body)).messages[1].content)
        const targets = payload.requests.map((row: { observed: { tools: { target: string }[] } }) => row.observed.tools[0].target)
        batches.push(targets)
        if (targets.length === 1 && targets[0] === 'broken.ts' && !manualRetry) {
          return Response.json({ message: { content: '{' } })
        }
        return Response.json({ message: { content: JSON.stringify({ items: [
          { id: 1, category: 'backend', outcome: 'unknown', purpose: '修改代码', result: '缺少回执' },
        ] }) } })
      })
      const audit = new LocalAudit(home, request)
      audit.start({ project: 'p1', end: started + 9 })
      await vi.waitFor(() => expect(audit.status()).toMatchObject({
        state: 'completed', processed: 3, remaining: 0, unknownErrors: 1, lastAuditError: 'Ollama 返回的 JSON 无法解析',
      }))
      expect(batches).toEqual([['saved.ts', 'broken.ts', 'recovered.ts'], ['broken.ts'], ['recovered.ts'], ['later.ts']])
      expect(audit.status()?.batchHistory).toMatchObject([
        { session: 'main', index: 1, total: 1, requests: 3, unresolved: 2, inputBytes: expect.any(Number), elapsedMs: expect.any(Number) },
        { session: 'main', index: 2, retry: true, unresolved: 1, error: 'Ollama 返回的 JSON 无法解析' },
        { session: 'main', index: 3, retry: true, unresolved: 0 },
        { session: 'another', index: 1, unresolved: 0 },
      ])
      const data = await collectUsage(home)
      addFindings(home, data.rows)
      expect(data.rows.find(row => row.id === 'broken')).toMatchObject({ auditError: 'Ollama 返回的 JSON 无法解析' })
      expect(data.rows.find(row => row.id === 'later')?.finding).toBeDefined()

      const restarted = new LocalAudit(home, request)
      request.mockClear()
      restarted.start({ project: 'p1', end: started + 9 })
      await vi.waitFor(() => expect(restarted.status()).toMatchObject({ state: 'completed', processed: 0, skippedUnknownErrors: 1 }))
      expect(request).not.toHaveBeenCalled()
      manualRetry = true
      restarted.start({ project: 'p1', mode: 'retry' })
      await vi.waitFor(() => expect(restarted.status()).toMatchObject({ state: 'completed', processed: 1 }))
      expect(batches.at(-1)).toEqual(['broken.ts'])
      addFindings(home, data.rows)
      const resolved = data.rows.find(row => row.id === 'broken')
      expect(resolved?.auditError).toBeUndefined()
      expect(resolved?.finding).toBeDefined()
      expect(data.rows.find(row => row.id === 'fresh')?.finding).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('audits a selected session and its child calls without auditing other sessions in the same project', async () => {
    const home = await mkdtemp(join(tmpdir(), 'bloma-token-preprocessing-'))
    try {
      const ledger = join(home, 'usage-ledger')
      const sessions = join(home, 'agent-sessions')
      await mkdir(ledger)
      await mkdir(sessions)
      const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row) + '\n').join('')
      const at = Date.parse('2026-11-14T08:01:00Z')
      const subject = '实现资产归档流程'
      const followUp = '补充归档状态'
      const other = '更新另一项任务'
      const toolMessages = (id: string, path: string, offset = 15) => [
        { role: 'assistant', timestamp: at + offset, content: [{ type: 'tool_use', id, name: 'edit_file', input: { path } }] },
        { role: 'user', origin: 'system', timestamp: at + offset + 1, content: [{ type: 'tool_result', tool_use_id: id, content: '修改已写入' }] },
      ]
      await writeFile(join(sessions, 'parent.jsonl'), jsonl([
        { id: 'intro', role: 'user', timestamp: at - 30, content: '检查现有归档' },
        { role: 'assistant', timestamp: at - 20, content: '已找到归档入口' },
        { id: 'turn', role: 'user', timestamp: at, content: subject },
        ...toolMessages('parent-tool', 'archive.ts'), ...toolMessages('recovered-tool', 'public/archive.html'),
        { id: 'follow-up', role: 'user', timestamp: at + 20, content: followUp },
        ...toolMessages('follow-up-tool', 'status.ts', 35),
      ]))
      await writeFile(join(sessions, 'child.jsonl'), jsonl(toolMessages('child-tool', 'timeline.ts')))
      await writeFile(join(sessions, 'other.jsonl'), jsonl([
        { id: 'turn', role: 'user', timestamp: at, content: other },
        ...toolMessages('other-tool', 'other.ts'),
      ]))
      const rows = [
        { query_id: 'parent-query', session_id: 'parent', tool: 'parent-tool' },
        { query_id: 'other-query', session_id: 'other', tool: 'other-tool' },
        { query_id: 'missing-query', session_id: 'parent', tool: 'missing-tool' },
        { query_id: 'child-query', session_id: 'child', parent_session_id: 'parent', tool: 'child-tool' },
        { query_id: 'recovered-query', session_id: 'parent', tool: 'recovered-tool' },
        { query_id: 'follow-up-query', session_id: 'parent', tool: 'follow-up-tool', turn_id: 'follow-up' },
      ]
      await writeFile(join(ledger, 'p1.jsonl'), jsonl(rows.flatMap(({ tool, ...row }, index) => {
        const base = { version: 1, project_id: 'p1', turn_id: 'turn', phase: 'production', at: at + index + 1, ...row }
        return [
          { ...base, event: 'query_started' },
          ...(tool === 'recovered-tool' ? [{ ...base, event: 'transport_finished', transport_index: 1, status: 'failed' }] : []),
          { ...base, event: 'query_finished', at: at + 10, status: 'completed', audit_tool_ids: [tool], usage: { input_tokens: 9, output_tokens: 1 } },
        ]
      })))
      const payloads = [] as Array<{ turns: unknown; session: unknown; requests: unknown }>
      const request = vi.fn(async (url: string, options?: RequestInit) => {
        if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'qwen3.5:9b' }] })
        const body = JSON.parse(String(options?.body))
        const payload = JSON.parse(body.messages[1].content)
        payloads.push(payload)
        return Response.json({ message: { content: JSON.stringify({ items: payload.requests.map(({ id }: { id: number }) => ({
          id, category: id === 2 ? 'frontend' : 'backend', outcome: 'success', purpose: '修改', result: '写入',
        })) }) } })
      })
      const audit = new LocalAudit(home, request)
      audit.start({ project: 'p1', session: 'parent' })
      await vi.waitFor(() => expect(audit.status()).toMatchObject({ state: 'completed', processed: 3, remaining: 0, skippedNoEvidence: 1 }))
      expect(payloads).toHaveLength(1)
      const scoped = await collectUsage(home)
      addFindings(home, scoped.rows)
      expect(scoped.rows.find(row => row.id === 'other-query')?.finding).toBeUndefined()
      const expectedRequest = (id: number, turnId: number, target: string) => ({
        id, turnId, explainFailure: false, phase: 'production',
        observed: { tools: [{ name: 'edit_file', target, result: '修改已写入', state: 'ok' }] },
      })
      expect(payloads[0]).toMatchObject({
        turns: [{ id: 1, subject, order: 2 }, { id: 2, subject: followUp, order: 3 }],
        session: { totalTurns: 3, omittedTurns: 0, context: [{ order: 1, subject: '检查现有归档', reply: '已找到归档入口' }] },
        requests: [expectedRequest(1, 1, 'archive.ts'), expectedRequest(2, 1, 'timeline.ts'), expectedRequest(3, 2, 'status.ts')],
      })
      audit.start({ project: 'p1', session: 'other' })
      await vi.waitFor(() => expect(audit.status()).toMatchObject({ state: 'completed', processed: 1, remaining: 0 }))
      expect(payloads).toHaveLength(2)
      expect(payloads[1]).toMatchObject({
        turns: [{ id: 1, subject: other }], session: { totalTurns: 1, omittedTurns: 0, context: [] },
        requests: [expectedRequest(1, 1, 'other.ts')],
      })
      const data = await collectUsage(home)
      addFindings(home, data.rows)
      expect(data.rows.map(row => [row.id, row.counts.uncached, row.finding?.category])).toEqual([
        ['parent-query', 9, 'backend'], ['other-query', 9, 'backend'], ['missing-query', 9, undefined],
        ['child-query', 9, 'frontend'], ['recovered-query', 9, undefined], ['follow-up-query', 9, 'backend'],
      ])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('links tool evidence by ID, keeps transport retry separate, and reuses valid local classifications', async () => {
    const home = await mkdtemp(join(tmpdir(), 'bloma-token-audit-'))
    try {
      const ledger = join(home, 'usage-ledger')
      const sessions = join(home, 'agent-sessions')
      await mkdir(ledger)
      await mkdir(sessions)
      const base = { version: 1, query_id: 'q1', project_id: 'p1', session_id: 's1', run_id: 'm1', phase: 'production' }
      const started = '2026-11-14T08:01:01.000Z'
      const finished = '2026-11-14T08:01:04.000Z'
      const jsonl = (value: unknown[]) => value.map(item => JSON.stringify(item)).join('\n') + '\n'
      await writeFile(join(ledger, 'p1.jsonl'), jsonl([
        { ...base, event: 'query_started', at: started },
        { ...base, event: 'transport_response', at: started, transport_index: 1, response: { status: 503 } },
        { ...base, event: 'transport_finished', at: started, transport_index: 1, status: 'failed' },
        { ...base, event: 'query_finished', at: finished, status: 'completed', audit_tool_ids: ['tool-a'], usage: { input_tokens: 90, output_tokens: 10 } },
      ]))
      const user = { id: 'm1', role: 'user', timestamp: Date.parse(started) - 50, content: '修复页面' }
      const reply = { role: 'assistant', timestamp: Date.parse(finished) + 1000,
        content: [{ type: 'tool_use', id: 'tool-a', name: 'edit_file', input: { path: 'public/app.js' } }] }
      const result = { role: 'user', origin: 'system', timestamp: Date.parse(finished) + 1100,
        content: [{ type: 'tool_result', tool_use_id: 'tool-a', content: '目标片段不存在', is_error: true }] }
      await writeFile(join(sessions, 's1.jsonl'), jsonl([user, reply, result]))
      const data = await collectUsage(home)
      expect(data.rows).toHaveLength(1)
      expect(data.rows[0]).toMatchObject({
        turn: ['p1', 's1', 'm1'], counts: { uncached: 90, output: 10 },
        retries: [{ index: 1, status: 'failed', http: 503 }],
        evidence: { source: 'id', failure: '', tools: [{ name: 'edit_file', target: 'public/app.js', result: '目标片段不存在', state: 'failed' }] },
      })
      const request = vi.fn(async (url: string, options?: RequestInit) => {
        expect(new URL(url).origin).toBe('http://127.0.0.1:11434')
        if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'qwen3.5:9b' }, { name: 'qwen3:4b' }, { name: 'qwen3.5:cloud' }] })
        expect(options?.redirect).toBe('error')
        return Response.json({ message: { content: JSON.stringify({ items: [
          { id: 1, category: 'frontend', outcome: 'failed', purpose: '修复页面', result: '修改失败', failureSummary: '目标片段不存在' },
        ] }) } })
      })
      const audit = new LocalAudit(home, request)
      audit.start({ project: 'p1', start: Date.parse(finished) + 1000 })
      await vi.waitFor(() => expect(audit.status()).toMatchObject({ state: 'completed', processed: 0 }))
      expect(request).not.toHaveBeenCalled()
      audit.start({ project: 'p1' })
      await vi.waitFor(() => expect(audit.status()).toMatchObject({ state: 'completed', model: 'qwen3.5:9b', processed: 1, remaining: 0 }))
      addFindings(home, data.rows)
      expect(data.rows[0].finding).toMatchObject({ category: 'frontend', outcome: 'failed', failureSummary: '目标片段不存在' })
      audit.start({ project: 'p1', model: 'qwen3:4b', mode: 'all' })
      await vi.waitFor(() => expect(audit.status()).toMatchObject({ state: 'completed', processed: 0 }))
      expect(request.mock.calls.filter(([url]) => url.endsWith('/api/chat'))).toHaveLength(1)
      const cached = join(home, 'token-monitor', 'audit-v1', 'p1', 'q1.json')
      const { failureSummary: _summary, summaryModel: _summaryModel, ...oldFinding } = JSON.parse(await readFile(cached, 'utf8'))
      await writeFile(cached, JSON.stringify(oldFinding))
      audit.start({ project: 'p1', model: 'qwen3:4b' })
      await vi.waitFor(() => expect(audit.status()).toMatchObject({ state: 'completed', processed: 1 }))
      expect(JSON.parse(await readFile(cached, 'utf8'))).toEqual({ ...oldFinding, failureSummary: '目标片段不存在', summaryModel: 'qwen3:4b' })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
