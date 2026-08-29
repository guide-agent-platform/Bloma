/**
 * ReviewChoicesDialog — 裁判审查逐题选择题弹窗（prd_review 流，2026-08-30 选择题化）
 *
 * 触发链：六维审查发现 blocking/major → main 发 user_decision_required(kind='prd_review')
 * → agent-atoms 归约进 reviewChoicesFamily → 本组件弹窗渲染。
 *
 * 取代旧「忽略继续 / 我来补充说明」两按钮 + 打字补充：每个问题列成一道选择题
 * （零基础大白话 + 2~4 个可点选项），用户逐题点选后一次性回传 review_answers；
 * 每题固定带「这条没问题」兜底；另有全局「全部交给向导决定」出口。
 *
 * 回传协议（复用 card_option 元数据，零新 IPC）：
 *  - 逐题作答 → metadata.review_answers = [{issue_id, option_id, label}]
 *  - 全部交给向导决定 → metadata.selected_option_id = 'prd_review_delegate_all'
 */

import React, { useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  activeAgentSessionIdAtom,
  nullReviewChoicesFallback,
  projectModeAtom,
  reviewChoicesFamily,
  workflowStageAtom,
} from '../agent-atoms'
import type { ReviewChoiceOption, ReviewChoicesState } from '../agent-atoms'

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
  padding: '10px 16px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--color-border, #d9dee7)',
  background: 'transparent',
  color: 'inherit',
  fontSize: 13,
  cursor: 'pointer',
}

const dismissButtonStyle: React.CSSProperties = {
  ...secondaryButtonStyle,
  border: 'none',
  color: 'var(--color-text-muted, #8a94a6)',
  textDecoration: 'underline',
}

const questionTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 14,
  fontWeight: 600,
  lineHeight: 1.5,
}

/** 选项按钮：选中高亮（主色描边 + 淡底），未选中普通描边。 */
function optionButtonStyle(selected: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 2,
    padding: '8px 12px',
    borderRadius: 'var(--radius-md)',
    border: selected
      ? '1px solid var(--color-primary, #4f6ef7)'
      : '1px solid var(--color-border, #d9dee7)',
    background: selected ? 'var(--color-bg-subtle, #f6f8fb)' : 'var(--white, #fff)',
    fontSize: 13,
    color: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'border-color var(--transition-fast)',
  }
}

export const ReviewChoicesDialog: React.FC = () => {
  const sessionId = useAtomValue(activeAgentSessionIdAtom)
  const state = useAtomValue(sessionId ? reviewChoicesFamily(sessionId) : nullReviewChoicesFallback)
  const clearChoices = useSetAtom(sessionId ? reviewChoicesFamily(sessionId) : nullReviewChoicesFallback)
  const mode = useAtomValue(projectModeAtom)
  const stage = useAtomValue(workflowStageAtom)

  // 每题选中的 option id（issue_id → option_id），逐题点选后统一提交
  const [selections, setSelections] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  if (!state) return null

  const close = (): void => {
    setSelections({})
    setSubmitting(false)
    clearChoices(null)
  }

  const allAnswered = state.questions.every((question) => selections[question.id])

  const selectOption = (questionId: string, optionId: string): void => {
    setSelections((previous) => ({ ...previous, [questionId]: optionId }))
  }

  const sendMessage = async (
    content: string,
    metadata: Record<string, unknown>,
  ): Promise<void> => {
    const api = window.electronAPI
    if (!api?.agent?.sendMessage || submitting) return
    setSubmitting(true)
    // 乐观关闭（对齐 PrdConfirmDialog）：send-message 的 IPC 回传绑定主进程全链
    // （修订 → 重审 → 新卡），await 会让弹窗挂死；先关弹窗再等 IPC。
    close()
    try {
      await api.agent.sendMessage({
        request_id: crypto.randomUUID(),
        session_id: state.sessionId,
        project_id: state.projectId,
        content,
        mode: mode ?? 'quick',
        current_stage: stage,
        metadata: { source: 'card_option', ...metadata },
      })
    } catch (error) {
      console.error('[review-choices] 发送异常:', error)
    }
  }

  const submitAnswers = (): void => {
    if (!allAnswered) return
    const answers = state.questions.map((question) => {
      const option = question.options.find((entry) => entry.id === selections[question.id])
      return { issue_id: question.id, option_id: option!.id, label: option!.label }
    })
    void sendMessage('我选好了，按我的选择修订需求。', { review_answers: answers })
  }

  const submitDelegateAll = (option: ReviewChoiceOption): void => {
    void sendMessage(option.label, { selected_option_id: option.id })
  }

  return (
    <div
      data-ai-id="review-choices-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1150,
        background: 'rgba(15, 23, 42, 0.45)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <section
        data-ai-id="review-choices-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={state.title}
        style={{
          width: 'min(640px, 94vw)',
          maxHeight: '86vh',
          overflowY: 'auto',
          background: 'var(--white, #fff)',
          borderRadius: 'var(--radius-lg)',
          padding: 'var(--space-6, 24px)',
          boxShadow: 'var(--shadow-lg)',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <h2 data-ai-id="review-choices-title" style={{ margin: 0, fontSize: 18 }}>
          {state.title}
        </h2>

        <p
          data-ai-id="review-choices-intro"
          style={{ margin: 0, fontSize: 13, color: 'var(--color-text-secondary, #5b6472)', lineHeight: 1.6 }}
        >
          我整理需求时发现几个地方还需要你拍板，直接点选就行，不用打字。
        </p>

        {state.summary ? (
          <p
            data-ai-id="review-choices-summary"
            style={{ margin: 0, fontSize: 13, color: 'var(--color-text-secondary, #5b6472)', lineHeight: 1.6 }}
          >
            {state.summary}
          </p>
        ) : null}

        {state.questions.map((question, index) => (
          <div key={question.id} data-ai-id={`review-choices-question-${question.id}`}>
            <p style={questionTitleStyle}>
              {index + 1}. {question.question}
            </p>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                marginTop: 8,
              }}
            >
              {question.options.map((option) => {
                const selected = selections[question.id] === option.id
                return (
                  <button
                    key={option.id}
                    type="button"
                    data-ai-id={`review-choice-${option.id}`}
                    style={optionButtonStyle(selected)}
                    onClick={() => selectOption(question.id, option.id)}
                  >
                    <span style={{ fontWeight: 500 }}>{option.label}</span>
                    {option.description ? (
                      <span style={{ fontSize: 12, color: 'var(--color-text-muted, #8a94a6)' }}>
                        {option.description}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </div>
        ))}

        <div
          data-ai-id="review-choices-actions"
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' }}
        >
          {/* 关闭出口：先不处理，回对话继续 */}
          <button type="button" data-ai-id="review-choices-dismiss" style={dismissButtonStyle} disabled={submitting} onClick={close}>
            稍后再说
          </button>
          {/* 全局让渡出口 */}
          {state.globalOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              data-ai-id={`review-choice-global-${option.id}`}
              style={secondaryButtonStyle}
              disabled={submitting}
              onClick={() => submitDelegateAll(option)}
            >
              {option.label}
            </button>
          ))}
          <button
            type="button"
            data-ai-id="review-choices-submit"
            style={{ ...primaryButtonStyle, opacity: allAnswered ? 1 : 0.5, cursor: allAnswered ? 'pointer' : 'not-allowed' }}
            disabled={!allAnswered || submitting}
            onClick={submitAnswers}
          >
            提交（{Object.keys(selections).length}/{state.questions.length}）
          </button>
        </div>
      </section>
    </div>
  )
}
