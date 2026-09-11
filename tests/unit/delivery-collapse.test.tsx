// @vitest-environment jsdom
/**
 * 交付消息 × 过程文本次序/收起（2026-09-11 交付话术改造 + 审计 P1-1/P2-1 回归锁）。
 *
 * 锁定两条不变式：
 * 1) 交付文本到达时，本 run 累积的过程文本（旁白/思考）应先落为一条**已收起**的消息，
 *    排在交付消息之前——对齐 Proma「尾部答案在过程组之后」；
 * 2) 无交付的运行（保持现状等会话话术）落普通消息，不带收起标记（不得被后续交付误折叠）。
 */
import { createStore } from 'jotai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentMessagesFamily, agentStreamStateFamily, setupGlobalAgentListeners } from '../../renderer/agent-atoms'
import type { AgentEvent, ElectronAPI } from '../../shared/types'

let seq = 0
const ev = (session: string, type: AgentEvent['type'], payload: Record<string, unknown>): AgentEvent => ({
  event_id: `e${++seq}`,
  session_id: session,
  project_id: 'p1',
  type,
  payload,
  created_at: new Date().toISOString(),
})

function mount(): { store: ReturnType<typeof createStore>; listener: (e: AgentEvent) => void } {
  const store = createStore()
  let listener: ((event: AgentEvent) => void) | undefined
  window.__jotai_store__ = store
  window.electronAPI = {
    agent: {
      onStreamEvent(next: (event: AgentEvent) => void) {
        listener = next
        return vi.fn()
      },
    },
  } as unknown as ElectronAPI
  setupGlobalAgentListeners()
  return { store, listener: (e) => listener?.(e) }
}

describe('交付消息 × 过程文本次序/收起', () => {
  afterEach(() => {
    delete window.electronAPI
    delete window.__jotai_store__
    vi.restoreAllMocks()
  })

  it('MVP 主链路：过程消息在交付文本之前，且已收起；completed 不重复落盘', () => {
    const { store, listener } = mount()
    const session = 's1'
    listener(ev(session, 'stage_changed', { stage: 'generating_mvp' }))
    listener(ev(session, 'thinking_delta', { text: '我先分析需求' }))
    listener(ev(session, 'message_delta', { text: '正在实现第一个功能项…' }))
    listener(ev(session, 'stage_changed', { stage: 'testing' }))
    listener(ev(session, 'message_delta', { text: '测试有失败，正在修复…' }))
    listener(ev(session, 'delivery_message', { text: '你的应用已经做好了，可以点右侧预览试用。', fallback: false }))
    listener(ev(session, 'completed', { subtype: 'success' }))

    const messages = store.get(agentMessagesFamily(session))
    expect(messages).toHaveLength(2)
    // 次序：过程在前、交付在后
    expect(messages[0]?.content.map((b) => b.type)).toEqual(['thinking', 'text'])
    expect(messages[0]?.process_record).toBe(true)
    expect(messages[1]?.content[0]?.text).toContain('你的应用已经做好了')
    expect(messages[1]?.process_record ?? false).toBe(false)
    // 过程文本完整保留（AC1：过程可存在、可展开查看）
    expect(messages[0]?.content.find((b) => b.type === 'thinking')?.thinking).toContain('我先分析需求')
    expect(messages[0]?.content.find((b) => b.type === 'text')?.text).toContain('正在实现第一个功能项')
    // 流式累积已清空（completed 不再 flush 出第三条）
    expect(store.get(agentStreamStateFamily(session)).content).toBe('')
    expect(store.get(agentStreamStateFamily(session)).thinking).toBe('')
  })

  it('会话话术（保持现状）落普通消息，不带收起标记', () => {
    const { store, listener } = mount()
    const session = 's2'
    listener(ev(session, 'message_delta', { text: '好的，已保留当前版本。' }))
    listener(ev(session, 'completed', { subtype: 'success' }))

    const messages = store.get(agentMessagesFamily(session))
    expect(messages).toHaveLength(1)
    expect(messages[0]?.process_record ?? false).toBe(false)
    expect(messages[0]?.content[0]?.text).toContain('已保留当前版本')
  })

  it('管线 run 里的状态旁白（如「正在内审这份 PRD」）归为过程记录', () => {
    const { store, listener } = mount()
    const session = 's4'
    // 同一次 run：PRD 内审旁白（此时阶段还是 clarifying）→ 随后进入草图阶段 → 终态
    listener(ev(session, 'stage_changed', { stage: 'clarifying' }))
    listener(
      ev(session, 'message_delta', {
        text: '需求已确认，正在内审这份 PRD（先攻击检查、有问题会自动修订并复核，约需一到两分钟），完成后请你定夺。',
      }),
    )
    listener(ev(session, 'stage_changed', { stage: 'generating_sketch' }))
    listener(ev(session, 'message_delta', { text: '草图已生成，请确认。' }))
    listener(ev(session, 'completed', { subtype: 'success' }))

    const messages = store.get(agentMessagesFamily(session))
    expect(messages).toHaveLength(1)
    expect(messages[0]?.process_record).toBe(true)
    // 原文完整保留（展开可读）
    expect(messages[0]?.content[0]?.text).toContain('正在内审这份 PRD')
  })

  it('纯对话 run（无工具/思考/管线阶段）不归为过程记录', () => {
    const { store, listener } = mount()
    const session = 's5'
    listener(ev(session, 'stage_changed', { stage: 'clarifying' }))
    listener(ev(session, 'message_delta', { text: '你说的是想做记账对吧？' }))
    listener(ev(session, 'completed', { subtype: 'success' }))

    const messages = store.get(agentMessagesFamily(session))
    expect(messages[0]?.process_record ?? false).toBe(false)
  })

  it('无累积过程文本时仅落交付消息', () => {
    const { store, listener } = mount()
    const session = 's3'
    listener(ev(session, 'delivery_message', { text: '交付文本。', fallback: true }))
    const messages = store.get(agentMessagesFamily(session))
    expect(messages).toHaveLength(1)
    expect(messages[0]?.content[0]?.text).toBe('交付文本。')
  })
})
