/**
 * RequirementConfirmDialog — 需求确认弹窗（confirm_requirements 流，2026-08-26）
 *
 * 触发链：向导判定需求基本成型 → main 发 user_decision_required(kind='requirement_confirm')
 * → agent-atoms 归约进 requirementConfirmFamily → 本组件弹窗渲染。
 *
 * 三出口（对齐用户需求「不得臆断，除非用户选择由向导决定」）：
 *  - 确认，开始做：勾选子集 → agent:confirm-requirements(decision=confirm)
 *  - 继续补充说明：文本 → 既有 agent:send-message（回到向导下一轮）
 *  - 由向导决定：decision=delegate（用户主动让渡）
 *
 * 市调摘要（DDG 免 key）折叠展示；不可用时如实标注，不阻断确认。
 * 挂载方式：App 根组件常驻（同 PermissionDialog），无状态时渲染 null。
 */

import React, { useMemo, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  nullRequirementConfirmFallback,
  projectModeAtom,
  requirementConfirmFamily,
  workflowStageAtom,
  activeAgentSessionIdAtom,
} from '../agent-atoms'

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '10px 12px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--color-border, #d9dee7)',
  fontSize: 13,
  fontFamily: 'inherit',
  resize: 'vertical',
  minHeight: 64,
}

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

export const RequirementConfirmDialog: React.FC = () => {
  const sessionId = useAtomValue(activeAgentSessionIdAtom)
  const state = useAtomValue(sessionId ? requirementConfirmFamily(sessionId) : nullRequirementConfirmFallback)
  const clearConfirm = useSetAtom(sessionId ? requirementConfirmFamily(sessionId) : nullRequirementConfirmFallback)
  const mode = useAtomValue(projectModeAtom)
  const stage = useAtomValue(workflowStageAtom)

  const [checked, setChecked] = useState<Set<string> | null>(null)
  const [supplementOpen, setSupplementOpen] = useState(false)
  const [supplementText, setSupplementText] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // 新弹窗到达时重置本地勾选（缺省全选）；checked=null 表示「全选」
  const effectiveChecked = useMemo(() => {
    if (!state) return new Set<string>()
    if (checked) return checked
    return new Set(state.requirements.map((item) => item.id))
  }, [state, checked])

  if (!state) return null

  const toggle = (id: string): void => {
    setChecked((previous) => {
      const base = previous ?? new Set(state.requirements.map((item) => item.id))
      const next = new Set(base)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const close = (): void => {
    setChecked(null)
    setSupplementOpen(false)
    setSupplementText('')
    setSubmitting(false)
    clearConfirm(null)
  }

  const submitDecision = async (decision: 'confirm' | 'delegate'): Promise<void> => {
    const api = window.electronAPI
    if (!api?.agent?.confirmRequirements || submitting) return
    setSubmitting(true)
    // 乐观关闭（2026-08-27）：confirmRequirements 的 IPC 回传绑定 PRD 管线全程
    // （PRD 生成+六维审查，可达数十秒），await 会让弹窗挂死——先关再等。
    close()
    try {
      const result = await api.agent.confirmRequirements({
        request_id: crypto.randomUUID(),
        session_id: state.sessionId,
        project_id: state.projectId,
        decision,
        requirement_ids: decision === 'confirm' ? [...effectiveChecked] : undefined,
      })
      if (!result?.ok) console.error('[requirement-confirm] 提交失败:', result?.error)
    } catch (error) {
      console.error('[requirement-confirm] 提交异常:', error)
    }
  }

  const submitSupplement = async (): Promise<void> => {
    const api = window.electronAPI
    const text = supplementText.trim()
    if (!api?.agent?.sendMessage || submitting || !text) return
    setSubmitting(true)
    // 乐观关闭（同 submitDecision：不等 IPC 返回）
    close()
    try {
      await api.agent.sendMessage({
        request_id: crypto.randomUUID(),
        session_id: state.sessionId,
        project_id: state.projectId,
        content: text,
        mode: mode ?? 'quick',
        current_stage: stage,
        metadata: { source: 'chat' },
      })
    } catch (error) {
      console.error('[requirement-confirm] 补充说明发送异常:', error)
    }
  }

  const allChecked = effectiveChecked.size === state.requirements.length && state.requirements.length > 0

  return (
    <div
      data-ai-id="requirement-confirm-overlay"
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
        data-ai-id="requirement-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={state.title}
        style={{
          width: 'min(560px, 92vw)',
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
        <h2 data-ai-id="requirement-confirm-title" style={{ margin: 0, fontSize: 18 }}>
          {state.title}
        </h2>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-secondary, #5b6472)' }}>
          下面是我按你的描述整理的需求清单，确认后我会先整理成一份需求文档请你过目，再开始画草图。
          有想改的地方直接补充，或者交给我来定。
        </p>

        <ul data-ai-id="requirement-confirm-list" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {state.requirements.map((item) => (
            <li key={item.id}>
              <label
                data-ai-id={`requirement-confirm-item-${item.id}`}
                style={{
                  display: 'flex',
                  gap: 10,
                  alignItems: 'flex-start',
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--color-border, #e2e6ee)',
                  cursor: 'pointer',
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                <input
                  type="checkbox"
                  checked={effectiveChecked.has(item.id)}
                  onChange={() => toggle(item.id)}
                  style={{ marginTop: 2 }}
                />
                <span>
                  {item.origin === 'guide' && (
                    <span
                      data-ai-id={`requirement-confirm-origin-${item.id}`}
                      title="这条不是你说的，是向导根据需求闭环自主补的——不想要就取消勾选"
                      style={{
                        display: 'inline-block',
                        marginRight: 6,
                        padding: '0 6px',
                        fontSize: 11,
                        lineHeight: '18px',
                        borderRadius: 9,
                        color: 'var(--color-text-secondary, #5b6472)',
                        background: 'var(--color-bg-secondary, #f0f2f7)',
                        border: '1px solid var(--color-border, #e2e6ee)',
                        verticalAlign: 1,
                      }}
                    >
                      向导补充
                    </span>
                  )}
                  {item.description}
                </span>
              </label>
            </li>
          ))}
        </ul>

        <details data-ai-id="requirement-confirm-research" style={{ fontSize: 13 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--color-text-secondary, #5b6472)' }}>
            {state.research.available ? '市面上类似的产品（市调参考）' : '市调参考（本次不可用）'}
          </summary>
          {state.research.available ? (
            <pre
              data-ai-id="requirement-confirm-research-body"
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                background: 'var(--color-bg-subtle, #f6f8fb)',
                padding: 12,
                borderRadius: 'var(--radius-sm)',
                fontSize: 12,
                margin: '10px 0 0',
                maxHeight: 180,
                overflowY: 'auto',
              }}
            >
              {state.research.summary || '（无摘要）'}
            </pre>
          ) : (
            <p style={{ margin: '10px 0 0', color: 'var(--color-text-secondary, #5b6472)' }}>
              本次没查到可用的市调结果，可直接确认需求，不影响生成。
            </p>
          )}
        </details>

        {supplementOpen ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <textarea
              data-ai-id="requirement-confirm-supplement-input"
              value={supplementText}
              onChange={(event) => setSupplementText(event.target.value)}
              placeholder="想补充或修改什么，直接写在这里…"
              style={inputStyle}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" style={secondaryButtonStyle} onClick={() => setSupplementOpen(false)}>
                先不补充
              </button>
              <button
                type="button"
                data-ai-id="requirement-confirm-supplement-send"
                style={{ ...primaryButtonStyle, opacity: supplementText.trim() ? 1 : 0.5 }}
                disabled={!supplementText.trim() || submitting}
                onClick={() => void submitSupplement()}
              >
                发送补充说明
              </button>
            </div>
          </div>
        ) : (
          <div data-ai-id="requirement-confirm-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button type="button" style={secondaryButtonStyle} onClick={() => setSupplementOpen(true)}>
              继续补充说明
            </button>
            <button
              type="button"
              style={secondaryButtonStyle}
              onClick={() => void submitDecision('delegate')}
              disabled={submitting}
            >
              由向导决定
            </button>
            <button
              type="button"
              data-ai-id="requirement-confirm-submit"
              style={{ ...primaryButtonStyle, opacity: effectiveChecked.size > 0 ? 1 : 0.5 }}
              disabled={effectiveChecked.size === 0 || submitting}
              onClick={() => void submitDecision('confirm')}
            >
              {allChecked ? '确认，开始做' : `确认勾选的 ${effectiveChecked.size} 项，开始做`}
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
