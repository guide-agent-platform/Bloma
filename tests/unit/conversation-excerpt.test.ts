import {describe,it,expect} from 'vitest'
import {buildConversationExcerpt,buildReadConversationHistoryTool} from '../../main/agent/loop/conversation-excerpt'
describe('conversation-excerpt（F 维对照源）', () => {
  it('buildReadConversationHistoryTool：读本会话 JSONL，user/assistant 对话行、截断与空态', async () => {
    const tool = buildReadConversationHistoryTool('session-excerpt-1')
    const outcome = await tool.execute({}, { projectId: 'p', sessionId: 'child', requestId: 'r', signal: new AbortController().signal, state: { delegation_depth: 0, edits_after_test_failure: 0 } as never })
    // 会话文件不存在 → 空态（不抛错）
    expect(outcome.output).toContain('暂无可读的对话历史')
  })

  it('buildConversationExcerpt：会话缺失 → 空串（不阻断内审）', () => {
    expect(buildConversationExcerpt('session-nonexistent')).toBe('')
  })
})
