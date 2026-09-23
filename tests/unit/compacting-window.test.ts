import { describe, expect, it } from 'vitest'
import { DIGEST_HEADER_PREFIX, DIGEST_MAX_CHARS, windowMessagesWithDigest, extractKeyLines } from '../../main/agent/loop/compacting-window'
import { TEXT_WINDOW_TURNS, TOOL_WINDOW_ROUNDS, windowMessages } from '../../main/agent/loop/agent-loop'
import type { ConversationTurn } from '../../main/orchestration/orchestrator'

/**
 * CompactingWindow 移植（compacting-window-port.md，2026-08-28 TDD）：Bloma 的
 * windowMessages 原为纯硬截断（F4），滑出即丢——子 Agent 长任务忘记目标/约束/已失败
 * 方案（context rot）。升级为「滑出 → 确定性提取式 digest 消息保留在窗口头」：
 * 模型可见 = [system] + [task(head)] + [digest?] + [活跃窗口]。原型 12 断言语义搬运
 * （enhancements/prototype/compacting-window-prototype.ts），缓存友好三原则：
 * 追加式 digest / 低频驱逐 / 确定性提取非 LLM 重写。
 */

const userText = (t: string): ConversationTurn => ({ role: 'user', content: t })
const asstText = (t: string): ConversationTurn => ({ role: 'assistant', content: t })

/** 工具轮对：assistant tool_use + user tool_result（绝不拆对） */
function toolPair(id: string, resultText: string): ConversationTurn[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'run_gwt_tests', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, text: resultText, is_error: resultText.includes('失败') }] },
  ]
}

/** 20 轮长任务脚本：关键信息散布早期轮（r1/r3/r7/r12），中后期过程噪音 */
function longTaskTurns(): ConversationTurn[] {
  const turns: ConversationTurn[] = [userText('目标: 修复登录超时 bug\n约束: 不改 auth 模块')]
  for (let i = 1; i <= 20; i += 1) {
    if (i === 1) turns.push(...toolPair('t1', '失败: 超时仍然存在，且引入了新的等待'))
    else if (i === 3) turns.push(...toolPair('t3', '失败: 方案 A（加长 timeout）无效，超时依旧'))
    else if (i === 7) turns.push(...toolPair('t7', '已核验: 超时根因是 dns 查询阻塞，不是 auth'))
    else if (i === 12) turns.push(asstText('结论: 方案 B（dns 预热缓存）方向正确，正在实现'))
    else turns.push(...toolPair(`t${i}`, `过程记录 ${i}: 查看了文件 foo${i}.ts，第 ${i * 3} 行附近没什么问题，继续排查。`))
  }
  return turns
}

/** 从 head（visible[0]）的 content 中提取 digest 段（digest 并入 head，审查 fail 点修复） */
function headDigest(turns: ConversationTurn[]): string | null {
  const head = turns[0]
  if (!head || typeof head.content !== 'string') return null
  const idx = head.content.indexOf(DIGEST_HEADER_PREFIX)
  return idx === -1 ? null : head.content.slice(idx)
}

describe('windowMessagesWithDigest（compacting-window 移植）', () => {
  it('信息保留：滑出窗口的关键标记句（目标/约束/失败/已核验/结论）进入 digest', () => {
    const all = longTaskTurns()
    const visible = windowMessagesWithDigest(all, TEXT_WINDOW_TURNS, TOOL_WINDOW_ROUNDS)
    const digest = headDigest(visible)
    expect(digest).not.toBeNull()
    // digest 覆盖被驱逐轮的关键句（失败方案防重复尝试、已核验根因）
    expect(digest).toContain('失败: 超时仍然存在')
    expect(digest).toContain('失败: 方案 A（加长 timeout）无效')
    expect(digest).toContain('已核验: 超时根因是 dns 查询阻塞')
    // 目标/约束在 head（首轮 task 恒保留）——Bloma 架构下不依赖 digest，语义不丢
    expect(visible[0].content).toContain('目标: 修复登录超时 bug')
    expect(visible[0].content).toContain('约束: 不改 auth 模块')
  })

  it('噪音挤出：过程文本（foo*.ts）不进 digest', () => {
    const visible = windowMessagesWithDigest(longTaskTurns(), TEXT_WINDOW_TURNS, TOOL_WINDOW_ROUNDS)
    const digest = headDigest(visible) ?? ''
    expect(digest).not.toContain('foo1.')
    expect(digest).not.toContain('过程记录 20')
  })

  it('结构：head（首轮 task）恒保留且是第一条；digest 紧随其后；最近窗口完整', () => {
    const all = longTaskTurns()
    const visible = windowMessagesWithDigest(all, TEXT_WINDOW_TURNS, TOOL_WINDOW_ROUNDS)
    // head 恒保留且 digest 并入其 content 末尾（多厂商审查 fail 点修复：独立 user 消息
    // 会造成连续两条 user，透传 Anthropic API 有角色交替风险——合并后消息数零变化）
    expect(visible[0].role).toBe(all[0].role)
    expect(visible[0].content).toContain('目标: 修复登录超时 bug')
    expect((visible[0].content as string).includes(DIGEST_HEADER_PREFIX)).toBe(true)
    // 无独立 digest 消息：第二条起的 string content 消息不含 digest 前缀
    for (const turn of visible.slice(1)) {
      if (typeof turn.content === 'string') {
        expect(turn.content.startsWith(DIGEST_HEADER_PREFIX)).toBe(false)
      }
    }
    // 窗口预算不受 digest 影响：tool 对数仍 = TOOL_WINDOW_ROUNDS
    const toolUseIds = visible
      .filter((t) => Array.isArray(t.content) && t.content.some((b) => b.type === 'tool_use'))
      .map((t) => (t.content as Array<{ type?: string; id?: string }>).find((b) => b.type === 'tool_use')?.id)
    expect(toolUseIds).toHaveLength(TOOL_WINDOW_ROUNDS)
  })

  it('纯过程噪音长任务：无关键标记句 → 不插 digest 消息（零 token 浪费）', () => {
    const turns: ConversationTurn[] = [userText('随便看看')]
    for (let i = 1; i <= 20; i += 1) turns.push(...toolPair(`n${i}`, `纯过程 ${i}: 无标记句内容，浏览了若干文件。`))
    const visible = windowMessagesWithDigest(turns, TEXT_WINDOW_TURNS, TOOL_WINDOW_ROUNDS)
    expect(headDigest(visible)).toBeNull()
  })

  it('角色合法：可见序列无连续 user 消息（digest 并入 head，不新增消息）', () => {
    const visible = windowMessagesWithDigest(longTaskTurns(), TEXT_WINDOW_TURNS, TOOL_WINDOW_ROUNDS)
    for (let i = 1; i < visible.length; i += 1) {
      const prev = visible[i - 1]
      const cur = visible[i]
      if (typeof cur.content === 'string' && (cur.content as string).startsWith(DIGEST_HEADER_PREFIX)) {
        throw new Error('digest 不应再作为独立消息出现')
      }
      expect(`${prev.role}|${cur.role}`).not.toBe('user|user')
    }
  })

  it('digest 预算 ≤1.2KB：超限丢最老行（第二层压缩），仍非空', () => {
    const turns: ConversationTurn[] = [userText('长摘要压力测试')]
    for (let i = 1; i <= 30; i += 1) {
      turns.push(...toolPair(`b${i}`, `结论: 第 ${i} 轮的关键信息行，这里是一段比较长的结论文本用来撑大 digest 体积——${'细节'.repeat(30)}`))
    }
    const visible = windowMessagesWithDigest(turns, TEXT_WINDOW_TURNS, TOOL_WINDOW_ROUNDS)
    const digest = headDigest(visible) ?? ''
    expect(digest.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS + 200) // 头部前缀留余量
    expect(digest).toContain('结论:') // 非空：最坏情况也保留最新行
  })

  it('滚动单调：中途快照已含 r3 失败方案——新驱逐不覆盖旧关键行', () => {
    const all = longTaskTurns()
    const mid = all.slice(0, 12) // head + 前 5 轮对+1，小窗口(2+2)强制 r3 失败句滑出
    const visible = windowMessagesWithDigest(mid, 2, 2)
    const digest = headDigest(visible) ?? ''
    expect(digest).toContain('失败: 方案 A（加长 timeout）无效')
  })

  it('压缩率：digest ≤ 被驱逐原文的 50%（过程文本占大头时）', () => {
    const all = longTaskTurns()
    const visible = windowMessagesWithDigest(all, TEXT_WINDOW_TURNS, TOOL_WINDOW_ROUNDS)
    const digest = headDigest(visible) ?? ''
    // 驱逐原文 = 全部长度 - 可见窗口长度（近似口径：含 head）
    const visibleLen = visible.reduce((n, t) => n + JSON.stringify(t.content).length, 0)
    const allLen = all.reduce((n, t) => n + JSON.stringify(t.content).length, 0)
    const evictedLen = allLen - visibleLen
    if (evictedLen > 0) expect(digest.length / evictedLen).toBeLessThanOrEqual(0.5)
  })

  it('基线对照：旧 windowMessages（硬截断）在 8+8 窗口下丢失早期关键信息——digest 版补上', () => {
    const all = longTaskTurns()
    const oldVisible = windowMessages(all, TEXT_WINDOW_TURNS, TOOL_WINDOW_ROUNDS)
    const oldText = JSON.stringify(oldVisible)
    expect(oldText).not.toContain('失败: 方案 A（加长 timeout）无效') // 基线：已滑出丢失
    const newText = JSON.stringify(windowMessagesWithDigest(all, TEXT_WINDOW_TURNS, TOOL_WINDOW_ROUNDS))
    expect(newText).toContain('失败: 方案 A（加长 timeout）无效') // digest 版：保留
  })

  it('短任务（无驱逐）：行为与旧 windowMessages 完全一致（零额外消息）', () => {
    const turns = [userText('目标: 小任务'), ...toolPair('s1', '结论: 一次通过')]
    const oldVisible = windowMessages(turns, TEXT_WINDOW_TURNS, TOOL_WINDOW_ROUNDS)
    const newVisible = windowMessagesWithDigest(turns, TEXT_WINDOW_TURNS, TOOL_WINDOW_ROUNDS)
    expect(newVisible).toEqual(oldVisible)
  })
})

describe('extractKeyLines（确定性提取式标记句）', () => {
  it('识别六类标记句，忽略过程行，上限 maxLines', () => {
    const text = [
      '先看了一下文件。',
      '目标: 实现导出功能',
      '随便一段过程描述没有标记。',
      '约束: 不能引入新依赖',
      '失败: 首次尝试超时',
      '结论: 改用缓存方案',
      '已核验: 单元测试全绿',
      '方案 B: dns 预热',
      '目标: 第二条目标行（应被 maxLines=3 截掉）',
    ].join('\n')
    const lines = extractKeyLines(text, 3)
    expect(lines).toEqual(['目标: 实现导出功能', '约束: 不能引入新依赖', '失败: 首次尝试超时'])
  })
})
