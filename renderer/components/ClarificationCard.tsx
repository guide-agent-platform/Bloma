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
 * 交互（2026-09-05 选择题化）：一次只问一道，每道是选择题——
 * 具体选项（模型生成）+「你帮我决定」+「其他，自己填写」三个出口；
 * 模型未给出具体选项时降级为开放文本输入框（保证追问能力不丢）。
 * 用户点选/填写后本地追加 user 气泡再回传（答案落会话 → 整轮重跑 → 下一道）。
 */

import React, { useState } from 'react'
import { CharacterDecisionStage } from './CharacterDecisionStage'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  activeAgentSessionIdAtom,
  appendMessageToSession,
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

const optionButtonStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '10px 14px',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--color-border, #d9dce5)',
  background: 'var(--white, #fff)',
  color: 'var(--color-text-primary, #2c2f3a)',
  fontSize: 14,
  cursor: 'pointer',
  transition: 'border-color var(--transition-fast), background var(--transition-fast)',
}

export const ClarificationCard: React.FC = () => {
  const sessionId = useAtomValue(activeAgentSessionIdAtom)
  const state = useAtomValue(sessionId ? enrichmentClarificationFamily(sessionId) : nullEnrichmentClarificationFallback)
  const clearClarification = useSetAtom(sessionId ? enrichmentClarificationFamily(sessionId) : nullEnrichmentClarificationFallback)
  const setGlobalUserError = useSetAtom(globalUserErrorAtom)
  const mode = useAtomValue(projectModeAtom)
  const stage = useAtomValue(workflowStageAtom)

  const [customText, setCustomText] = useState('')
  const [customMode, setCustomMode] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  if (!state) return null

  // 一次一道：取第一道追问
  const request = state.requests[0]
  if (!request) return null
  const options = request.options ?? []
  const hasOptions = options.length > 0

  const close = (): void => {
    setCustomText('')
    setCustomMode(false)
    setSubmitting(false)
    clearClarification(null)
  }

  const sendMessage = async (content: string): Promise<void> => {
    const api = window.electronAPI
    if (!api?.agent?.sendMessage || submitting) return
    setSubmitting(true)
    // 用户选择气泡：先本地追加再回传，agent 的答复才有「用户选了什么」的上下文
    appendMessageToSession(state.sessionId, {
      role: 'user',
      content: [{ type: 'text', text: content }],
      timestamp: Date.now(),
    })
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
          selected_option_id: ENRICHMENT_CLARIFICATION_OPTION_ANSWER,
        },
      })
    } catch (error) {
      console.error('[clarification] 发送异常:', error)
      setGlobalUserError('回答没有送达（连接中断）：请直接在对话里回答，或等追问超时后按原信息整理。')
    }
  }

  const submitOption = (label: string): void => {
    void sendMessage(label)
  }

  const submitCustom = (): void => {
    const text = customText.trim()
    if (!text) return
    void sendMessage(text)
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
      <CharacterDecisionStage kind="clarify" cue={state}>
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
          回答后我会据此重新整理 PRD 再请你确认。
        </p>

        <div
          style={{
            padding: '12px 14px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--color-bg-secondary, #fafbfc)',
            border: '1px solid var(--color-border, #eceef3)',
            fontSize: 14,
            lineHeight: 1.6,
            marginBottom: 16,
          }}
          data-ai-id="clarification-question-0"
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
        </div>

        {hasOptions ? (
          <div style={{ display: 'grid', gap: 8 }}>
            {options.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => submitOption(option.label)}
                style={optionButtonStyle}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-primary, #4f6ef7)'
                  e.currentTarget.style.background = 'var(--color-bg-subtle, #f6f8fb)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-border, #d9dce5)'
                  e.currentTarget.style.background = 'var(--white, #fff)'
                }}
                data-ai-id={`clarification-option-${option.id}`}
              >
                {option.label}
              </button>
            ))}

            <button
              type="button"
              onClick={() => submitOption('你帮我决定')}
              style={optionButtonStyle}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-primary, #4f6ef7)'
                e.currentTarget.style.background = 'var(--color-bg-subtle, #f6f8fb)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-border, #d9dce5)'
                e.currentTarget.style.background = 'var(--white, #fff)'
              }}
              data-ai-id="clarification-option-auto"
            >
              你帮我决定
            </button>

            {customMode ? (
              <>
                <textarea
                  value={customText}
                  placeholder="写下你的回答…"
                  onChange={(event) => setCustomText(event.target.value)}
                  style={textareaStyle}
                  autoFocus
                  data-ai-id="clarification-custom-input"
                />
                <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
                  <button type="button" onClick={() => setCustomMode(false)} style={secondaryButtonStyle}>
                    返回选择
                  </button>
                  <button
                    type="button"
                    onClick={submitCustom}
                    style={{ ...primaryButtonStyle, opacity: customText.trim() ? 1 : 0.5 }}
                    disabled={!customText.trim()}
                    data-ai-id="clarification-custom-submit"
                  >
                    提交回答
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setCustomMode(true)}
                style={optionButtonStyle}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-primary, #4f6ef7)'
                  e.currentTarget.style.background = 'var(--color-bg-subtle, #f6f8fb)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-border, #d9dce5)'
                  e.currentTarget.style.background = 'var(--white, #fff)'
                }}
                data-ai-id="clarification-option-custom"
              >
                其他，自己填写
              </button>
            )}
          </div>
        ) : (
          <div>
            <textarea
              value={customText}
              placeholder="写下你的回答…"
              onChange={(event) => setCustomText(event.target.value)}
              style={textareaStyle}
              autoFocus
              data-ai-id="clarification-custom-input"
            />
            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 12 }}>
              <button
                type="button"
                onClick={submitCustom}
                style={{ ...primaryButtonStyle, opacity: customText.trim() ? 1 : 0.5 }}
                disabled={!customText.trim()}
                data-ai-id="clarification-custom-submit"
              >
                提交回答
              </button>
            </div>
          </div>
        )}
      </div>
      </CharacterDecisionStage>
    </div>
  )
}
