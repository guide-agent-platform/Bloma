/**
 * ReviewChoicesDialog — 裁判审查逐题选择题弹窗（prd_review 流，2026-08-30 选择题化）
 *
 * 触发链：六维审查发现 blocking/major → main 发 user_decision_required(kind='prd_review')
 * → agent-atoms 归约进 reviewChoicesFamily → 本组件弹窗渲染。
 *
 * 交互（2026-09-05 一次一道 + 开放填写）：一次只展示一道题，用户点选具体选项
 * 或「其他，自己填写」后自动进入下一道；全部答完统一回传 review_answers，
 * 提交前本地追加 user 气泡（内容=逐题答案摘要）。全局「全部交给向导决定」出口保留。
 *
 * 回传协议（复用 card_option 元数据，零新 IPC）：
 *  - 逐题作答 → metadata.review_answers = [{issue_id, option_id, label}]
 *    （「其他，自己填写」option_id='custom'、label=用户填写文本）
 *  - 全部交给向导决定 → metadata.selected_option_id = 'prd_review_delegate_all'
 */

import React, { useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  activeAgentSessionIdAtom,
  appendMessageToSession,
  nullReviewChoicesFallback,
  projectModeAtom,
  reviewChoicesFamily,
  workflowStageAtom,
} from '../agent-atoms'
import type { ReviewChoiceOption, ReviewChoicesState } from '../agent-atoms'

/** 「其他，自己填写」选项回传 id（主进程 ignored 判定只看 :ignore 后缀，custom 天然非 ignore）。 */
const CUSTOM_OPTION_ID = 'custom'

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

const textareaStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 84,
  padding: '10px 12px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--color-border, #d9dee7)',
  background: 'var(--color-bg-secondary, #fafbfc)',
  color: 'var(--color-text-primary, #2c2f3a)',
  fontSize: 14,
  lineHeight: 1.6,
  resize: 'vertical',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
  marginTop: 8,
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

  // 一次一道：当前题索引；每题选中 option id（issue_id → option_id）；自定义填写文本（issue_id → text）
  const [currentIndex, setCurrentIndex] = useState(0)
  const [selections, setSelections] = useState<Record<string, string>>({})
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({})
  const [customMode, setCustomMode] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  if (!state) return null

  const questions = state.questions
  const question = questions[currentIndex]
  if (!question) return null
  const isLast = currentIndex === questions.length - 1

  const close = (): void => {
    setSelections({})
    setCustomTexts({})
    setCustomMode(false)
    setSubmitting(false)
    clearChoices(null)
  }

  const sendMessage = async (content: string, metadata: Record<string, unknown>): Promise<void> => {
    const api = window.electronAPI
    if (!api?.agent?.sendMessage || submitting) return
    setSubmitting(true)
    // 用户选择气泡：先本地追加再回传，agent 的修订答复才有「用户选了哪些」的上下文
    appendMessageToSession(state.sessionId, {
      role: 'user',
      content: [{ type: 'text', text: content }],
      timestamp: Date.now(),
    })
    // 乐观关闭（对齐 PrdConfirmDialog）：send-message 的 IPC 回传绑定主进程全链，await 会让弹窗挂死
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

  const answerLabel = (q: { id: string }, sel: Record<string, string>): string => {
    const optionId = sel[q.id]
    if (optionId === CUSTOM_OPTION_ID) return customTexts[q.id] ?? ''
    const option = questions.find((entry) => entry.id === q.id)?.options.find((entry) => entry.id === optionId)
    return option?.label ?? ''
  }

  const buildAnswers = (sel: Record<string, string>): Array<{ issue_id: string; option_id: string; label: string }> =>
    questions.map((q) => {
      const optionId = sel[q.id]
      if (optionId === CUSTOM_OPTION_ID) {
        return { issue_id: q.id, option_id: CUSTOM_OPTION_ID, label: customTexts[q.id] ?? '' }
      }
      const option = q.options.find((entry) => entry.id === optionId)
      return { issue_id: q.id, option_id: option!.id, label: option!.label }
    })

  const buildContent = (sel: Record<string, string>): string => {
    const lines = questions.map((q) => `· ${q.question}：${answerLabel(q, sel)}`).join('\n')
    return `我选好了，按下面的选择修订：\n${lines}`
  }

  const submitAll = (sel: Record<string, string>): void => {
    void sendMessage(buildContent(sel), { review_answers: buildAnswers(sel) })
  }

  // 进入下一道；最后一道则统一提交
  const advance = (nextSelections: Record<string, string>): void => {
    setSelections(nextSelections)
    if (isLast) {
      submitAll(nextSelections)
    } else {
      setCurrentIndex((index) => index + 1)
      setCustomMode(false)
    }
  }

  const selectOption = (optionId: string): void => {
    advance({ ...selections, [question.id]: optionId })
  }

  const submitCustom = (): void => {
    const text = (customTexts[question.id] ?? '').trim()
    if (!text) return
    advance({ ...selections, [question.id]: CUSTOM_OPTION_ID })
  }

  const goPrevious = (): void => {
    if (currentIndex > 0) {
      setCurrentIndex((index) => index - 1)
      setCustomMode(false)
    }
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
          第 {currentIndex + 1}/{questions.length} 题 · 直接点选就行，不用打字。
        </p>

        <div key={question.id} data-ai-id={`review-choices-question-${question.id}`}>
          <p style={questionTitleStyle}>{question.question}</p>
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
                  onClick={() => selectOption(option.id)}
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

            {customMode ? (
              <>
                <textarea
                  value={customTexts[question.id] ?? ''}
                  placeholder="写下你的修改想法…"
                  onChange={(event) =>
                    setCustomTexts((prev) => ({ ...prev, [question.id]: event.target.value }))
                  }
                  style={{ ...textareaStyle, flexBasis: '100%' }}
                  autoFocus
                  data-ai-id="review-choice-custom-input"
                />
                <div style={{ display: 'flex', gap: 8, width: '100%' }}>
                  <button type="button" onClick={() => setCustomMode(false)} style={secondaryButtonStyle}>
                    返回选择
                  </button>
                  <button
                    type="button"
                    onClick={submitCustom}
                    style={{ ...primaryButtonStyle, opacity: (customTexts[question.id] ?? '').trim() ? 1 : 0.5 }}
                    disabled={!(customTexts[question.id] ?? '').trim()}
                    data-ai-id="review-choice-custom-submit"
                  >
                    {isLast ? '提交' : '下一题'}
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                data-ai-id="review-choice-custom"
                style={optionButtonStyle(false)}
                onClick={() => setCustomMode(true)}
              >
                <span style={{ fontWeight: 500 }}>其他，自己填写</span>
              </button>
            )}
          </div>
        </div>

        <div
          data-ai-id="review-choices-actions"
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" data-ai-id="review-choices-dismiss" style={dismissButtonStyle} disabled={submitting} onClick={close}>
              稍后再说
            </button>
            {currentIndex > 0 && (
              <button type="button" data-ai-id="review-choice-prev" style={secondaryButtonStyle} disabled={submitting} onClick={goPrevious}>
                上一题
              </button>
            )}
          </div>
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
        </div>
      </section>
    </div>
  )
}
