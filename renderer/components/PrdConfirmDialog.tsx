/**
 * PrdConfirmDialog — PRD 用户确认弹窗（prd_confirm 流，2026-08-26 改造 3）
 *
 * 触发链：六维审查通过 → main 发 user_decision_required(kind='prd_confirm')
 * → agent-atoms 归约进 prdConfirmFamily → 本组件弹窗渲染。
 *
 * 确认的是「系统加工的理解细节」（story 化/行为断言/优先级/范围外/假设），
 * 不是用户说过的话（需求弹窗已确认过）。四段式主体 + 折叠完整视图：
 * - P0 功能项断言逐条展开（决策密度最高的确认对象）；
 * - P1/P2 story 一行、断言折叠（P0 已覆盖风险大头）；
 * - 「明确不做的」高亮（事后争议最大的段落）；
 * - 「系统替你做的决定」（assumptions，可推翻；空段隐藏）；
 * - 完整 PRD 视图：longterm 默认展开 / quick 折叠。
 *
 * 两出口（整体确认 + 逐项异议，均复用 card_option 元数据，零新 IPC）：
 *  - 确认无误，开始画草图 → prd_confirm_confirm（主进程落 user_confirmed_at 后开草图）
 *  - 有要调整的 / 某条「这条不对」→ prd_confirm_adjust（补充文本带条目 id 回向导修订）
 */

import React, { useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  activeAgentSessionIdAtom,
  nullPrdConfirmFallback,
  prdConfirmFamily,
  projectModeAtom,
  workflowStageAtom,
} from '../agent-atoms'
import type { PrdConfirmRequirement } from '../agent-atoms'

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

/** 暂不确认（第三出口）：弱化为文字链接风格，避免与两个主行动争夺注意力。 */
const dismissButtonStyle: React.CSSProperties = {
  ...secondaryButtonStyle,
  border: 'none',
  color: 'var(--color-text-muted, #8a94a6)',
  textDecoration: 'underline',
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '10px 12px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--color-border, #d9dee7)',
  fontSize: 13,
  fontFamily: 'inherit',
  resize: 'vertical',
  minHeight: 72,
}

const sectionTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--color-text-secondary, #5b6472)',
}

const priorityBadgeStyle = (priority: 'P0' | 'P1' | 'P2'): React.CSSProperties => ({
  display: 'inline-block',
  padding: '1px 6px',
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
  marginRight: 6,
  background: priority === 'P0' ? '#fde8e8' : priority === 'P1' ? '#fff4dd' : '#eef1f6',
  color: priority === 'P0' ? '#c0392b' : priority === 'P1' ? '#b7791f' : '#5b6472',
})

const warnBlockStyle = (tone: 'danger' | 'caution'): React.CSSProperties => ({
  padding: '10px 12px',
  borderRadius: 'var(--radius-sm)',
  background: tone === 'danger' ? '#fdf2f2' : '#fffbeb',
  border: `1px solid ${tone === 'danger' ? '#fecaca' : '#fde68a'}`,
  fontSize: 13,
  lineHeight: 1.6,
})

const assertionTextStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-secondary, #5b6472)',
  lineHeight: 1.6,
}

const disagreeLinkStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  fontSize: 12,
  color: 'var(--color-primary, #4f6ef7)',
  cursor: 'pointer',
  textDecoration: 'underline',
}

function RequirementBlock(props: { item: PrdConfirmRequirement; onDisagree: (id: string) => void }): React.ReactElement {
  const { item, onDisagree } = props
  const assertions = item.assertions
  const assertionList = (
    <ul style={{ margin: '6px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 3 }}>
      {assertions.map((assertion, index) => (
        <li key={index} style={assertionTextStyle}>
          ▸ {assertion}
        </li>
      ))}
    </ul>
  )
  return (
    <li
      data-ai-id={`prd-confirm-item-${item.id}`}
      style={{
        padding: '10px 12px',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--color-border, #e2e6ee)',
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span>
          <span style={priorityBadgeStyle(item.priority)}>{item.priority}</span>
          <strong>{item.id}</strong>　{item.story}
        </span>
        <button type="button" style={disagreeLinkStyle} data-ai-id={`prd-confirm-disagree-${item.id}`} onClick={() => onDisagree(item.id)}>
          这条不对
        </button>
      </div>
      {item.priority === 'P0' ? (
        assertions.length > 0 ? assertionList : null
      ) : assertions.length > 0 ? (
        <details style={{ marginTop: 4 }}>
          <summary style={{ ...assertionTextStyle, cursor: 'pointer' }}>验收细节（{assertions.length} 条）</summary>
          {assertionList}
        </details>
      ) : null}
    </li>
  )
}

export const PrdConfirmDialog: React.FC = () => {
  const sessionId = useAtomValue(activeAgentSessionIdAtom)
  const state = useAtomValue(sessionId ? prdConfirmFamily(sessionId) : nullPrdConfirmFallback)
  const clearConfirm = useSetAtom(sessionId ? prdConfirmFamily(sessionId) : nullPrdConfirmFallback)
  const mode = useAtomValue(projectModeAtom)
  const stage = useAtomValue(workflowStageAtom)

  const [adjustOpen, setAdjustOpen] = useState(false)
  const [adjustText, setAdjustText] = useState('')
  const [submitting, setSubmitting] = useState(false)

  if (!state) return null

  const close = (): void => {
    setAdjustOpen(false)
    setAdjustText('')
    setSubmitting(false)
    clearConfirm(null)
  }

  const sendMessage = async (content: string, selectedOptionId: string): Promise<void> => {
    const api = window.electronAPI
    if (!api?.agent?.sendMessage || submitting) return
    setSubmitting(true)
    // 乐观关闭（2026-08-27 线上案例：点确认后弹窗不消失）：send-message 的 IPC 回传
    // 绑定主进程全链——confirm 回传含草图生成全程（可达数十秒），await 会让弹窗挂死。
    // 先关弹窗再等 IPC；主进程侧 pending 校验失败时弹窗本就该关（旧卡/重复点击）。
    close()
    try {
      await api.agent.sendMessage({
        request_id: crypto.randomUUID(),
        session_id: state.sessionId,
        project_id: state.projectId,
        content,
        mode: mode ?? 'quick',
        current_stage: stage,
        metadata: { source: 'card_option', selected_option_id: selectedOptionId },
      })
    } catch (error) {
      console.error('[prd-confirm] 发送异常:', error)
    }
  }

  const submitConfirm = (): void => {
    void sendMessage('确认这份 PRD，开始画草图。', 'prd_confirm_confirm')
  }

  const submitDismiss = (): void => {
    void sendMessage('稍后再说，先不确认。', 'prd_confirm_dismiss')
  }

  const submitAdjust = (): void => {
    const text = adjustText.trim()
    if (!text) return
    void sendMessage(text, 'prd_confirm_adjust')
  }

  const openAdjustWith = (requirementId: string): void => {
    setAdjustOpen(true)
    setAdjustText((previous) => (previous.includes(requirementId) ? previous : `${requirementId} 这条不对：`))
  }

  return (
    <div
      data-ai-id="prd-confirm-overlay"
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
        data-ai-id="prd-confirm-dialog"
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
        <h2 data-ai-id="prd-confirm-title" style={{ margin: 0, fontSize: 18 }}>
          {state.title}
        </h2>

        {/* 第一段：定位一句话 */}
        <div>
          <h3 style={sectionTitleStyle}>我们理解你要做的</h3>
          <p data-ai-id="prd-confirm-positioning" style={{ margin: '6px 0 0', fontSize: 14, lineHeight: 1.6 }}>
            {state.positioning || '（见功能清单）'}
          </p>
        </div>

        {/* 第二段：功能清单（P0 断言展开 / P1P2 折叠，逐项可异议） */}
        <div>
          <h3 style={sectionTitleStyle}>
            功能清单（{state.requirements.length} 项）——P0 为核心必须，附验收细节
          </h3>
          <ul data-ai-id="prd-confirm-requirements" style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {state.requirements.map((item) => (
              <RequirementBlock key={item.id} item={item} onDisagree={openAdjustWith} />
            ))}
          </ul>
        </div>

        {/* 第三段：明确不做的（高亮——事后争议最大） */}
        <div data-ai-id="prd-confirm-out-of-scope">
          <h3 style={sectionTitleStyle}>明确不做的</h3>
          <div style={{ ...warnBlockStyle('danger'), marginTop: 6 }}>
            {state.outOfScope.length > 0 ? state.outOfScope.map((entry) => <div key={entry}>· {entry}</div>) : <div>（无明确排除项）</div>}
          </div>
        </div>

        {/* 第四段：系统替你做的决定（空段隐藏，不摆空架子） */}
        {state.assumptions.length > 0 ? (
          <div data-ai-id="prd-confirm-assumptions">
            <h3 style={sectionTitleStyle}>系统替你做的决定（可推翻）</h3>
            <div style={{ ...warnBlockStyle('caution'), marginTop: 6 }}>
              {state.assumptions.map((entry) => (
                <div key={entry}>· {entry}</div>
              ))}
            </div>
          </div>
        ) : null}

        {/* 用户约束回显（空段隐藏） */}
        {state.constraints.length > 0 ? (
          <div data-ai-id="prd-confirm-constraints">
            <h3 style={sectionTitleStyle}>你说过的约束</h3>
            <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.6 }}>
              {state.constraints.map((entry) => (
                <div key={entry}>· {entry}</div>
              ))}
            </div>
          </div>
        ) : null}

        {/* 完整 PRD 视图：quick 折叠 / longterm 展开 */}
        <details data-ai-id="prd-confirm-full-view" open={state.expanded} style={{ fontSize: 13 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--color-text-secondary, #5b6472)' }}>查看完整 PRD（全部验收细节）</summary>
          <div
            style={{
              background: 'var(--color-bg-subtle, #f6f8fb)',
              padding: 12,
              borderRadius: 'var(--radius-sm)',
              marginTop: 10,
              maxHeight: 260,
              overflowY: 'auto',
              lineHeight: 1.7,
            }}
          >
            {state.requirements.map((item) => (
              <div key={item.id} style={{ marginBottom: 10 }}>
                <div>
                  <span style={priorityBadgeStyle(item.priority)}>{item.priority}</span>
                  <strong>{item.id}</strong>　{item.story}
                </div>
                {item.assertions.map((assertion, index) => (
                  <div key={index} style={assertionTextStyle}>
                  　▸ {assertion}
                  </div>
                ))}
              </div>
            ))}
            {state.outOfScope.length > 0 ? <div style={assertionTextStyle}>范围外：{state.outOfScope.join('；')}</div> : null}
            {state.constraints.length > 0 ? <div style={assertionTextStyle}>约束：{state.constraints.join('；')}</div> : null}
          </div>
        </details>

        {adjustOpen ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <textarea
              data-ai-id="prd-confirm-adjust-input"
              value={adjustText}
              onChange={(event) => setAdjustText(event.target.value)}
              placeholder="想调整哪里？指出具体条目（如「F-002 的验收不对：我想要的是导出 Excel」）…"
              style={inputStyle}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" style={secondaryButtonStyle} onClick={() => setAdjustOpen(false)}>
                先不调整
              </button>
              <button
                type="button"
                data-ai-id="prd-confirm-adjust-send"
                style={{ ...primaryButtonStyle, opacity: adjustText.trim() ? 1 : 0.5 }}
                disabled={!adjustText.trim() || submitting}
                onClick={submitAdjust}
              >
                发送调整说明
              </button>
            </div>
          </div>
        ) : (
          <div data-ai-id="prd-confirm-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {/* 暂不确认出口（2026-08-27 线上案例：弹窗无关闭方式，用户被强制二选一） */}
            <button
              type="button"
              data-ai-id="prd-confirm-dismiss"
              style={dismissButtonStyle}
              disabled={submitting}
              onClick={submitDismiss}
            >
              稍后再说
            </button>
            <button type="button" style={secondaryButtonStyle} onClick={() => setAdjustOpen(true)}>
              有要调整的
            </button>
            <button type="button" data-ai-id="prd-confirm-submit" style={primaryButtonStyle} disabled={submitting} onClick={submitConfirm}>
              确认无误，开始画草图
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
