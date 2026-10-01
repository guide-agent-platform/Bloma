import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { restorePromaHome } from '../support/proma-home-guard'
import { loadConversationHistory } from '../../main/platform/sessions/session-service'
import { hasWriteEditToolCall } from '../../main/coding/repair-loop'
import { getAgentSessionPath } from '../../storage/config-paths'

/**
 * 完成宣称如实化（2026-09-26 运行审计 P1-05）：有效写入判定（失败/拒绝写入不算）、
 * 修复续接工具轨迹（不再只有文本）、零编辑守卫默认启用（提示词承诺对齐）。
 */

describe('hasWriteEditToolCall（P1-05：有效写入判定）', () => {
  it('status=error 的写调用不算有效写入；无 status（存量形态）与 ok 照常计入', () => {
    expect(hasWriteEditToolCall([{ name: 'write_file', path: 'a.js', status: 'error' }])).toBe(false)
    expect(hasWriteEditToolCall([{ name: 'edit_file', status: 'error' }])).toBe(false)
    expect(hasWriteEditToolCall([{ name: 'write_file', status: 'ok' }])).toBe(true)
    expect(hasWriteEditToolCall([{ name: 'edit_file' }])).toBe(true) // 存量记录无 status：不回溯降级
    expect(hasWriteEditToolCall([{ name: 'read_file', status: 'ok' }])).toBe(false)
  })
})

describe('loadConversationHistory 工具轨迹（P1-05：修复续接带工作记忆）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  function seedSession(sessionId: string): void {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-hist-'))
    const path = getAgentSessionPath(sessionId)
    mkdirSync(join(path, '..'), { recursive: true })
    const lines = [
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
    ]
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
  }

  it('includeToolTrace=true：assistant 轮附工具清单，tool_result 轮转回执摘要（✓/✗ 计数）', () => {
    seedSession('s-trace-1')
    const turns = loadConversationHistory('s-trace-1', 10, { includeToolTrace: true })
    const assistantToolTurn = turns.find((t) => t.role === 'assistant' && t.content.includes('[本轮工具]'))
    expect(assistantToolTurn?.content).toContain('edit_file:src/app.js')
    expect(assistantToolTurn?.content).toContain('run_gwt_tests')
    const receipt = turns.find((t) => t.role === 'user' && t.content.includes('[工具结果回执]'))
    expect(receipt?.content).toBe('[工具结果回执] 2 次调用：1 成功、1 失败')
  })

  it('缺省 false：旧行为零变化（纯 tool_result 轮跳过，assistant 无工具行）', () => {
    seedSession('s-trace-2')
    const turns = loadConversationHistory('s-trace-2', 10)
    expect(turns.some((t) => t.content.includes('[本轮工具]'))).toBe(false)
    expect(turns.some((t) => t.content.includes('[工具结果回执]'))).toBe(false)
    // 纯 tool_result 的 user 轮（text 空）照旧被跳过
    expect(turns.filter((t) => t.role === 'user')).toEqual([{ role: 'user', content: '帮我把清空功能修好' }])
  })
})
