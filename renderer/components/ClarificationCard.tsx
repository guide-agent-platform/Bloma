/**
 * ClarificationCard — 加厚追问卡（enrichment_clarification 流，② 2026-09-03）
 *
 * 触发链：PRD 收敛链（runPrdPipeline）→ 加厚腿声明信息缺口 → 轮次守卫过 →
 * main 发 user_decision_required(kind='enrichment_clarification') →
 * agent-atoms 归约进 enrichmentClarificationFamily → 本组件弹卡渲染。
 *
 * 与 PrdConfirmDialog 的分工：确认卡确认「系统加工的理解细节」（PRD 已生成），
 * 本卡在 PRD 定稿**前**收集缺口信息——回答后整轮重跑，答案落会话成为
 * 下一轮接地守卫的新证据（状态机图「答案落会话」态）。
 *
 * 出口（复用 card_option 元数据，零新 IPC 通道）：
 * - 提交回答（开放文本，可多问合并作答）→ enrichment_clarification_answer
 *   （主进程 consume 挂起上下文 → answered 决策行 → runPrdPipeline 整轮重跑）
 * - 跳过 → 同选项发送「跳过」标记（主进程按超时语义收敛：不阻塞主线）
 */

import React, { useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  activeAgentSessionIdAtom,
  enrichmentClarificationFamily,
  globalUserErrorAtom,
  nullEnrichmentClarificationFallback,
  projectModeAtom,
  workflowStageAtom,
} from '../agent-atoms'

/** 追问回答选项 id（与 main/guide/clarification.ts 常量同值；字面量以避免 renderer→main 依赖）。 */
const ENRICHMENT_CLARIFICATION_OPTION_ANSWER = 'enrichment_clarification_answer'

const primaryButtonStyle: React.CSSProperties = {
  padding: '10px 18px',
  borderRadius: 'var(--radius-sm)',
  border: 'none',
  background: 'var(--color-primary, #4f6ef7)',
  color: 'var(--white, #fff)',
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
}

const secondaryButtonStyle: React.CSSProperties = {
  padding: '10px 18px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--color-border, #d9dce5)',
  background: 'transparent',
  color: 'var(--color-text-primary, #2c2f3a)',
  fontSize: 14,
  cursor: 'pointer',
}

const textareaStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 84,
  padding: '10px 12px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--color-border, #d9dce5)',
  background: 'var(--color-bg-secondary, #fafbfc)',
  color: 'var(--color-text-primary, #2c2f3a)',
  fontSize: 14,
  lineHeight: 1.6,
  resize: 'vertical',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
}

export const ClarificationCard: React.FC = () => {
  const sessionId = useAtomValue(activeAgentSessionIdAtom)
  const state = useAtomValue(sessionId ? enrichmentClarificationFamily(sessionId) : nullEnrichmentClarificationFallback)
  const clearClarification = useSetAtom(sessionId ? enrichmentClarificationFamily(sessionId) : nullEnrichmentClarificationFallback)
  const setGlobalUserError = useSetAtom(globalUserErrorAtom)
  const mode = useAtomValue(projectModeAtom)
  const stage = useAtomValue(workflowStageAtom)

  const [answerText, setAnswerText] = useState('')
  const [submitting, setSubmitting] = useState(false)

  if (!state) return null

  const close = (): void => {
    setAnswerText('')
    setSubmitting(false)
    clearClarification(null)
  }

  const sendMessage = async (content: string, selectedOptionId: string): Promise<void> => {
    const api = window.electronAPI
    if (!api?.agent?.sendMessage || submitting) return
    setSubmitting(true)
    // 乐观关闭（陷阱 41：不 await IPC 驱动关闭；主进程 pending 校验失败时卡本就该关）
    close()
    try {
      await api.agent.sendMessage({
        request_id: crypto.randomUUID(),
        session_id: state.sessionId,
        project_id: state.projectId,
        content,
        mode: mode ?? 'quick',
        current_stage: stage,
        metadata: {
          source: 'card_option',
          selected_option_id: selectedOptionId,
        },
      })
    } catch (error) {
      console.error('[clarification] 发送异常:', error)
      setGlobalUserError('回答没有送达（连接中断）：请直接在对话里回答，或等追问超时后按原信息整理。')
    }
  }

  const submitAnswer = (): void => {
    const text = answerText.trim()
    if (!text) return
    void sendMessage(text, ENRICHMENT_CLARIFICATION_OPTION_ANSWER)
  }

  const submitSkip = (): void => {
    void sendMessage('先按你已有的信息整理吧。', ENRICHMENT_CLARIFICATION_OPTION_ANSWER)
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 18, 25, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      data-ai-id="clarification-card-overlay"
    >
      <div
        style={{
          width: 'min(560px, calc(100vw - 48px))',
          maxHeight: 'calc(100vh - 96px)',
          overflowY: 'auto',
          background: 'var(--color-bg-primary, #fff)',
          borderRadius: 'var(--radius-md, 12px)',
          padding: '24px 28px',
          boxShadow: '0 18px 48px rgba(15, 18, 25, 0.24)',
        }}
        data-ai-id="clarification-card"
      >
        <h3 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700 }} data-ai-id="clarification-card-title">
          {state.title}
        </h3>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--color-text-secondary, #6b7280)' }}>
          回答后我会据此重新整理 PRD 再请你确认；也可以跳过，我按已有信息整理（薄一点但不耽误开工）。
        </p>

        <ul style={{ listStyle: 'none', margin: '0 0 16px', padding: 0, display: 'grid', gap: 10 }}>
          {state.requests.map((request, index) => (
            <li
              key={`${request.for}-${index}`}
              style={{
                padding: '10px 14px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--color-bg-secondary, #fafbfc)',
                border: '1px solid var(--color-border, #eceef3)',
                fontSize: 14,
                lineHeight: 1.6,
              }}
              data-ai-id={`clarification-question-${index}`}
            >
              <span
                style={{
                  display: 'inline-block',
                  marginRight: 8,
                  padding: '1px 8px',
                  borderRadius: 10,
                  background: 'var(--color-primary-soft, #eef1fe)',
                  color: 'var(--color-primary, #4f6ef7)',
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {request.for}
              </span>
              {request.question}
            </li>
          ))}
        </ul>

        <textarea
          value={answerText}
          placeholder="写下你的回答（多个问题可以一起答）…"
          onChange={(event) => setAnswerText(event.target.value)}
          style={textareaStyle}
          data-ai-id="clarification-answer-input"
        />

        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" onClick={submitSkip} style={secondaryButtonStyle} data-ai-id="clarification-skip-button">
            跳过，按已有信息整理
          </button>
          <button
            type="button"
            onClick={submitAnswer}
            style={{ ...primaryButtonStyle, opacity: answerText.trim() ? 1 : 0.5 }}
            disabled={!answerText.trim()}
            data-ai-id="clarification-submit-button"
          >
            提交回答
          </button>
        </div>
      </div>
    </div>
  )
}
