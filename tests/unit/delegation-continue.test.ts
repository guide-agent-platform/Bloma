import { restorePromaHome } from '../support/proma-home-guard'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadChildSessionSnapshot,
  replayTurnsFrom,
} from '../../main/agent/delegation/delegation-persistence'
import { appendJsonLine } from '../../storage/json-store'
import { getAgentSessionPath } from '../../storage/config-paths'
import type { MessageContentBlock } from '../../shared/types'

/**
 * Delegation continue 续跑输入构造（delegation-persistence-port.md 阶段 3，2026-08-28 TDD）：
 * 终态子会话 JSONL 读回 → 消息与 settle 分离 → 重放为模型可见轮次 → follow-up 追加为
 * 末条 user 轮。语义：仅终态可 continue；重放保序保数、tool blocks 原样保留；
 * 上下文资产复用（续跑带全部历史 vs 重开仅新指令）。
 * 原型 10 断言搬运（prototype/delegation-continue-prototype.ts）+ 真实模块。
 */

function useTemporaryHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix))
  process.env.PROMA_HOME = home
  return home
}

const originalHome = process.env.PROMA_HOME
afterEach(() => {
  restorePromaHome(originalHome)
})

/** 构造完整子会话：4 消息轮 + settle 行 */
function writeCompletedChildSession(childId: string): void {
  const lines: Array<Record<string, unknown>> = [
    { role: 'user', content: [{ type: 'text', text: '目标: 修复登录超时\n约束: 不改 auth' }], timestamp: 1 },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '开始排查' },
        { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
      ],
      timestamp: 2,
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '文件内容' }], timestamp: 3 },
    { role: 'assistant', content: [{ type: 'text', text: '根因是 dns 阻塞，方案 B 有效' }], timestamp: 4 },
    { delegation_settle: 'completed', result_summary: '已修复并验证', timestamp: 5 },
  ]
  for (const line of lines) appendJsonLine(getAgentSessionPath(childId), line)
}

describe('loadChildSessionSnapshot（读回：消息与 settle 分离）', () => {
  it('completed 会话：读回 4 消息轮，settle 行分离且带终态信息', () => {
    useTemporaryHome('deleg-cont-')
    writeCompletedChildSession('cont-1')

    const snap = loadChildSessionSnapshot('cont-1')
    expect(snap.messages).toHaveLength(4)
    expect(snap.messages[0]!.role).toBe('user')
    expect(snap.lastSettle).not.toBeNull()
    expect(snap.lastSettle!.status).toBe('completed')
    expect(snap.lastSettle!.resultSummary).toBe('已修复并验证')
    // settle 行不进对话流
    expect(snap.messages.some((m) => 'delegation_settle' in (m as unknown as Record<string, unknown>))).toBe(false)
  })

  it('running 态（无 settle 行）报告 lastSettle=null——上层据此拒绝 continue', () => {
    useTemporaryHome('deleg-cont-run-')
    appendJsonLine(getAgentSessionPath('cont-running'), { role: 'user', content: [{ type: 'text', text: 'task' }], timestamp: 1 })
    appendJsonLine(getAgentSessionPath('cont-running'), { role: 'assistant', content: [{ type: 'text', text: '进行中…' }], timestamp: 2 })

    const snap = loadChildSessionSnapshot('cont-running')
    expect(snap.messages).toHaveLength(2)
    expect(snap.lastSettle).toBeNull()
  })
})

describe('replayTurnsFrom（纯重放：新指令由 runAgentLoop 的 task 承担，不重复）', () => {
  it('重放保序保数，tool_use/tool_result blocks 原样保留；不追加 follow-up（审查 fail 点修复：避免连续双 user + 指令重复）', () => {
    useTemporaryHome('deleg-cont-replay-')
    writeCompletedChildSession('cont-2')
    const snap = loadChildSessionSnapshot('cont-2')

    const turns = replayTurnsFrom(snap.messages)
    expect(turns).toHaveLength(4)
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect((turns[1]!.content as MessageContentBlock[]).some((b) => b.type === 'tool_use')).toBe(true)
    expect((turns[2]!.content as MessageContentBlock[]).some((b) => b.type === 'tool_result')).toBe(true)
  })

  it('首条非 user 的异常历史被丢弃（防 Anthropic 首条非 user 400）；末尾悬空 tool_use 轮被丢弃（防配对校验失败）', () => {
    useTemporaryHome('deleg-cont-guard-')
    // 异常格式：assistant 开头 + 末尾 assistant 含未配对 tool_use
    appendJsonLine(getAgentSessionPath('cont-guard'), { role: 'assistant', content: [{ type: 'text', text: '孤儿开头' }], timestamp: 1 })
    appendJsonLine(getAgentSessionPath('cont-guard'), { role: 'user', content: [{ type: 'text', text: '目标: 正常任务' }], timestamp: 2 })
    appendJsonLine(getAgentSessionPath('cont-guard'), { role: 'assistant', content: [{ type: 'tool_use', id: 'x1', name: 'edit_file', input: {} }], timestamp: 3 })
    const snap = loadChildSessionSnapshot('cont-guard')

    const turns = replayTurnsFrom(snap.messages)
    expect(turns.length).toBeGreaterThan(0)
    expect(turns[0]!.role).toBe('user')
    expect((turns[0]!.content as MessageContentBlock[])[0]).toMatchObject({ type: 'text' })
    // 悬空 tool_use 轮已被丢弃
    expect(turns.some((t) => Array.isArray(t.content) && (t.content as MessageContentBlock[]).some((b) => b.type === 'tool_use'))).toBe(false)
  })

  it('原上下文完整保留（首条含目标+约束）', () => {
    useTemporaryHome('deleg-cont-fu-')
    writeCompletedChildSession('cont-3')
    const snap = loadChildSessionSnapshot('cont-3')

    const turns = replayTurnsFrom(snap.messages)
    expect((turns[0]!.content as MessageContentBlock[])[0]!.text).toContain('目标: 修复登录超时')
  })

  it('上下文资产复用：续跑输入带全部历史，远大于重开（仅新指令）', () => {
    useTemporaryHome('deleg-cont-asset-')
    writeCompletedChildSession('cont-4')
    const snap = loadChildSessionSnapshot('cont-4')

    const continueInput = JSON.stringify(replayTurnsFrom(snap.messages))
    const freshInput = JSON.stringify([{ role: 'user', content: [{ type: 'text', text: '继续下一问' }] }])
    expect(continueInput.length).toBeGreaterThan(freshInput.length)
  })
})
