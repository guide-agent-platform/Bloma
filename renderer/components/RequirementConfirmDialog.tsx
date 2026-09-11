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

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import {
  globalUserErrorAtom,
  nullRequirementConfirmFallback,
  projectModeAtom,
  requirementConfirmFamily,
  workflowStageAtom,
  activeAgentSessionIdAtom,
} from '../agent-atoms'
import type { RequirementConfirmState } from '../agent-atoms'

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
  const store = useStore()
  const setGlobalUserError = useSetAtom(globalUserErrorAtom)

  const [checked, setChecked] = useState<Set<string> | null>(null)
  const [adoptedIdeas, setAdoptedIdeas] = useState<Set<string>>(new Set())
  const [supplementOpen, setSupplementOpen] = useState(false)
  const [supplementText, setSupplementText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // web-reference 接线 UI 段（2026-08-28）：可选参考网页链接，confirm 时透传后端提取设计参考卡
  const [referenceUrl, setReferenceUrl] = useState('')
  const [referenceError, setReferenceError] = useState(false)
  /** F9a（r84）：提交/发送失败内联错误条——失败不关窗，用户可重试 */
  const [submitError, setSubmitError] = useState<string | null>(null)

  // 新弹窗到达时重置本地勾选（缺省全选）；checked=null 表示「全选」
  const effectiveChecked = useMemo(() => {
    if (!state) return new Set<string>()
    if (checked) return checked
    return new Set(state.requirements.map((item) => item.id))
  }, [state, checked])

  // F9a 重兑现（2026-09-02，r124）：新确认卡到达时清掉上一轮的内联错误条。
  // 与「失败恢复」区分：恢复写回的是同一对象引用（seenStateRef 命中，不清），
  // 新事件归约出的必是新对象（引用不同，清）。ref 跨隐藏期保留旧引用。
  const seenStateRef = useRef<RequirementConfirmState | null>(null)
  useEffect(() => {
    if (state && seenStateRef.current !== state) {
      setSubmitError(null)
      seenStateRef.current = state
    }
  }, [state])

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

  /** 本地状态全清（atom 已在提交时隐藏清空，成功路径收尾用） */
  const resetLocalDialogState = (): void => {
    setChecked(null)
    setAdoptedIdeas(new Set())
    setSupplementOpen(false)
    setSupplementText('')
    setSubmitting(false)
    setReferenceUrl('')
    setReferenceError(false)
    setSubmitError(null)
  }

  /**
   * F9a 失败恢复（r124）：恢复快照弹窗+保留全部本地状态+内联错误条，可原地重试。
   * 竞态守卫：在途期间若已到达新确认卡（atom 非 null），不覆盖新卡——旧卡数据已过期，
   * 改走全局错误通道（m-16 同款）指引用户在最新弹窗上操作。
   */
  const restoreAfterFailure = (snapshot: RequirementConfirmState, message: string): void => {
    setSubmitting(false)
    const current = sessionId ? store.get(requirementConfirmFamily(sessionId)) : null
    if (current === null) {
      setSubmitError(message)
      clearConfirm(snapshot)
    } else {
      setGlobalUserError('刚才的确认没有送达（连接中断）——已收到新的需求清单，请在最新弹窗中重新确认。')
    }
  }

  const toggleIdea = (label: string): void => {
    setAdoptedIdeas((previous) => {
      const next = new Set(previous)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

  const submitDecision = async (decision: 'confirm' | 'delegate'): Promise<void> => {
    const api = window.electronAPI
    if (!api?.agent?.confirmRequirements || submitting) return
    // SSRF 双保险第一道：填了链接必须 http(s) 开头（后端 buildReferenceSection 还有同款门）
    const trimmedReference = referenceUrl.trim()
    if (trimmedReference && !/^https?:\/\//i.test(trimmedReference)) {
      setReferenceError(true)
      return
    }
    setReferenceError(false)
    setSubmitError(null)
    setSubmitting(true)
    // F9a 混合契约（2026-09-02 重兑现，r124）：da737d5 半合并曾把 c9ab674 的「失败不关窗」
    // 回退成乐观关闭，错误分支沦为死代码（弹窗已关、错误条永不渲染、勾选清零）。
    // 现：先隐藏弹窗（IPC 回传绑定 PRD 全程可达数十秒，滞留弹窗=盲等——3817a6f 线上案例），
    // 失败时 restoreAfterFailure 恢复弹窗+勾选/灵感/参考链接全保留，决定不再静默丢失。
    const snapshot = state
    clearConfirm(null)
    try {
      const result = await api.agent.confirmRequirements({
        request_id: crypto.randomUUID(),
        session_id: snapshot.sessionId,
        project_id: snapshot.projectId,
        decision,
        requirement_ids: decision === 'confirm' ? [...effectiveChecked] : undefined,
        adopted_ideas: decision === 'confirm' && adoptedIdeas.size > 0 ? [...adoptedIdeas] : undefined,
        reference_url: trimmedReference || undefined,
      })
      if (!result?.ok) {
        restoreAfterFailure(snapshot, result?.error?.user_visible_message ?? '提交失败，请重试。')
        return
      }
    } catch (error) {
      console.error('[requirement-confirm] 提交异常:', error)
      restoreAfterFailure(snapshot, '提交失败：连接异常——请重试')
      return
    }
    resetLocalDialogState()
  }

  const submitSupplement = async (): Promise<void> => {
    const api = window.electronAPI
    const text = supplementText.trim()
    if (!api?.agent?.sendMessage || submitting || !text) return
    setSubmitError(null)
    setSubmitting(true)
    // F9a 混合契约（同 submitDecision）：先隐藏，失败恢复+文本保留可重发
    const snapshot = state
    clearConfirm(null)
    try {
      const result = await api.agent.sendMessage({
        request_id: crypto.randomUUID(),
        session_id: snapshot.sessionId,
        project_id: snapshot.projectId,
        content: text,
        mode: mode ?? 'quick',
        current_stage: stage,
        metadata: { source: 'chat' },
      })
      if (!result?.ok) {
        restoreAfterFailure(snapshot, result?.error?.user_visible_message ?? '发送失败，请重试。')
        return
      }
    } catch (error) {
      console.error('[requirement-confirm] 补充说明发送异常:', error)
      restoreAfterFailure(snapshot, '发送失败：连接异常——请重试')
      return
    }
    resetLocalDialogState()
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

        {state.ideas.length > 0 ? (
          <div data-ai-id="requirement-confirm-ideas" style={{ marginTop: 4 }}>
            <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600, color: 'var(--color-text, inherit)' }}>
              灵感参考（{state.research.mode === 'agent' ? 'AI 灵感建议' : '市面上的做法'}）
            </p>
            <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--color-text-secondary, #5b6472)' }}>
              看到想要的方向就勾上，会并入需求清单一起做；不勾就仅作参考。
            </p>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {state.ideas.map((idea) => {
                const adopted = adoptedIdeas.has(idea.label)
                return (
                  <li key={idea.label}>
                    <label
                      data-ai-id={`requirement-confirm-idea-${idea.label.slice(0, 8)}`}
                      style={{
                        display: 'flex',
                        gap: 10,
                        alignItems: 'flex-start',
                        padding: '8px 12px',
                        borderRadius: 'var(--radius-sm)',
                        border: adopted
                          ? '1px solid var(--color-primary, #4f6ef7)'
                          : '1px dashed var(--color-border, #e2e6ee)',
                        background: adopted ? 'var(--color-bg-subtle, #f6f8fb)' : 'transparent',
                        cursor: 'pointer',
                        fontSize: 13,
                        lineHeight: 1.5,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={adopted}
                        onChange={() => toggleIdea(idea.label)}
                        style={{ marginTop: 2 }}
                      />
                      <span>
                        <strong style={{ fontWeight: 600 }}>{idea.label}</strong>
                        {idea.note && (
                          <span style={{ color: 'var(--color-text-secondary, #5b6472)' }}> — {idea.note}</span>
                        )}
                        {idea.source && (
                          <span
                            style={{ marginLeft: 6, fontSize: 11, color: 'var(--color-text-muted, #8a93a5)' }}
                            title={`来源：${idea.source}`}
                          >
                            {idea.source}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : (
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
        )}

        {/* 参考链接（web-reference 接线 UI 段，2026-08-28）：可选，confirm 时透传提取设计参考卡 */}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--color-text-secondary, #5b6472)' }}>参考网页链接（可选）</span>
          <input
            data-ai-id="requirement-confirm-reference-url"
            type="text"
            value={referenceUrl}
            onChange={(event) => {
              setReferenceUrl(event.target.value)
              setReferenceError(false)
            }}
            placeholder="做个像某网站那样的？贴链接（http(s)://…）"
            style={{ ...inputStyle, minHeight: 0 }}
          />
          {referenceError && (
            <span data-ai-id="requirement-confirm-reference-error" style={{ fontSize: 12, color: '#d64545' }}>
              链接需以 http:// 或 https:// 开头，请修改后再确认
            </span>
          )}
        </label>

        {submitError && (
          <div
            data-ai-id="requirement-confirm-submit-error"
            role="alert"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: 'var(--space-2) var(--space-3)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 12,
              color: '#d64545',
              background: '#FEF2F2',
              border: '1px solid #FECACA',
            }}
          >
            {submitError}
          </div>
        )}

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
