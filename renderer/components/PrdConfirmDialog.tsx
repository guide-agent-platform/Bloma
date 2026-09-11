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
 *  - 有要调整的 / 某条「这条不对」→ prd_confirm_adjust 累计池（2026-09-02 决议 7）：
 *    调整先压栈（点 N 条「这条不对」累计 N 条，不再一条一轮），统一批量提交后
 *    合并为一条消息回向导，一轮修订闭环统一处理；失败恢复弹窗、池内容不丢。
 */

import React, { useEffect, useRef, useState } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import {
  activeAgentSessionIdAtom,
  globalUserErrorAtom,
  nullPrdConfirmFallback,
  prdConfirmFamily,
  projectModeAtom,
  workflowStageAtom,
} from '../agent-atoms'
import type { PrdConfirmRequirement, PrdConfirmState } from '../agent-atoms'
import { PRD_TERMS, priorityLabel } from '../lib/prd-terms'

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
          <span style={priorityBadgeStyle(item.priority)}>{priorityLabel(item.priority)}</span>
          <strong>{item.id}</strong>　{item.story}
          {item.origin === 'guide' ? (
            <span style={{ marginLeft: 6, fontSize: 11, padding: '1px 6px', borderRadius: 999, background: 'var(--color-bg-subtle, #f0f2f7)', color: 'var(--color-text-secondary, #5b6472)' }}>向导补充</span>
          ) : item.origin === 'user' ? (
            <span style={{ marginLeft: 6, fontSize: 11, padding: '1px 6px', borderRadius: 999, background: 'var(--color-bg-subtle, #f0f2f7)', color: 'var(--color-text-secondary, #5b6472)' }}>你说的</span>
          ) : null}
          {item.implies_backend ? (
            <span style={{ marginLeft: 6, fontSize: 11, padding: '1px 6px', borderRadius: 999, background: 'rgba(47, 100, 190, 0.10)', color: '#2f64be' }}>↳ 将要求后端与数据持久化</span>
          ) : null}
        </span>
        <button type="button" style={disagreeLinkStyle} data-ai-id={`prd-confirm-disagree-${item.id}`} onClick={() => onDisagree(item.id)}>
          这条不对
        </button>
      </div>
      {item.priority === 'P0' ? (
        assertions.length > 0 ? assertionList : null
      ) : assertions.length > 0 ? (
        <details style={{ marginTop: 4 }}>
          <summary style={{ ...assertionTextStyle, cursor: 'pointer' }}>{PRD_TERMS.assertion}（{assertions.length} 条）</summary>
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
  const setGlobalUserError = useSetAtom(globalUserErrorAtom)
  const mode = useAtomValue(projectModeAtom)
  const stage = useAtomValue(workflowStageAtom)

  const [adjustOpen, setAdjustOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [adoptedIdeas, setAdoptedIdeas] = useState<Set<string>>(new Set())
  /**
   * 累计池（2026-09-02 决议 7）：调整先压栈、统一批量提交——不再「一步一问一改」
   * （此前每条「这条不对」= 关卡一轮修订闭环，N 条修改 N 轮，token 与轮时双浪费）。
   * 点条目「这条不对」往池里追加（同条目不重复）；手动入口可加空行；可增删改；
   * 一次提交合并回传，向导一轮修订统一处理。
   */
  const [adjustPool, setAdjustPool] = useState<Array<{ entryId: string; requirementId: string | null; text: string }>>([])
  /** 池路径失败内联错误条（F9a 同款：恢复弹窗+池内容全保留，原地重试） */
  const [submitError, setSubmitError] = useState<string | null>(null)

  const store = useStore()

  // 新确认卡到达时清上一轮内联错误（与失败恢复区分：恢复写回同一对象引用，不清）
  const seenStateRef = useRef<PrdConfirmState | null>(null)
  useEffect(() => {
    if (state && seenStateRef.current !== state) {
      setSubmitError(null)
      seenStateRef.current = state
    }
  }, [state])

  if (!state) return null

  const close = (): void => {
    setAdjustOpen(false)
    setSubmitting(false)
    setAdoptedIdeas(new Set())
    setAdjustPool([])
    setSubmitError(null)
    clearConfirm(null)
  }

  /** 池路径成功收尾：本地状态全清（atom 已隐藏清空） */
  const resetLocalDialogState = (): void => {
    close()
  }

  /** 池路径失败恢复：快照弹窗+池内容全保留+内联错误条；在途新卡到达则不覆盖（走全局错误通道） */
  const restoreAfterFailure = (snapshot: PrdConfirmState, message: string): void => {
    setSubmitting(false)
    const current = sessionId ? store.get(prdConfirmFamily(sessionId)) : null
    if (current === null) {
      setSubmitError(message)
      setAdjustOpen(true)
      clearConfirm(snapshot)
    } else {
      setGlobalUserError('调整没有送达（连接中断）——已收到新的确认卡，池里的修改未提交，请在最新弹窗上重新发起调整。')
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

  const sendMessage = async (
    content: string,
    selectedOptionId: string,
    adoptedIdeaList?: string[],
    opts?: { typed?: boolean },
  ): Promise<void> => {
    const api = window.electronAPI
    if (!api?.agent?.sendMessage || submitting) return
    setSubmitting(true)
    // 乐观关闭（2026-08-27 线上案例：点确认后弹窗不消失）：send-message 的 IPC 回传
    // 绑定主进程全链——confirm 回传含草图生成全程（可达数十秒），await 会让弹窗挂死。
    // 先隐藏弹窗再等 IPC；主进程侧 pending 校验失败时弹窗本就该关（旧卡/重复点击）。
    // typed 路径（累计池批量调整，2026-09-02 决议 7）：用户输入内容不可丢——隐藏但不清
    // 本地状态，失败时恢复弹窗+池内容全保留原地重试；纯决策路径维持 m-16 契约（关+全局通道）。
    const snapshot = state
    if (opts?.typed) {
      setSubmitError(null)
      clearConfirm(null)
    } else {
      close()
    }
    const fail = (message: string): void => {
      if (opts?.typed) {
        restoreAfterFailure(snapshot, message)
      } else {
        // m-16：IPC 失败时弹窗已乐观关闭，用户对「确认未送达」零感知（pending 仍挂主进程侧）。
        // 保持乐观关闭契约（陷阱 41：不 await IPC 驱动关闭），改走用户可见通道告知。
        setGlobalUserError('确认没有送达（连接中断）：请直接在对话里发「确认这份 PRD」重试，或重新打开确认卡。')
      }
    }
    try {
      const result = await api.agent.sendMessage({
        request_id: crypto.randomUUID(),
        session_id: snapshot.sessionId,
        project_id: snapshot.projectId,
        content,
        mode: mode ?? 'quick',
        current_stage: stage,
        metadata: {
          source: 'card_option',
          selected_option_id: selectedOptionId,
          ...(adoptedIdeaList && adoptedIdeaList.length > 0 ? { adopted_ideas: adoptedIdeaList } : {}),
        },
      })
      // safeInvoke 包装失败走 ok:false（此前仅 catch throw——ok:false 被当成功静默吞掉）
      if (!result?.ok) {
        fail(opts?.typed ? `调整没有送达（${result?.error?.user_visible_message ?? '未知错误'}）——弹窗已恢复，你的修改都还在，请重试。` : '确认没有送达：请直接在对话里发「确认这份 PRD」重试，或重新打开确认卡。')
        return
      }
    } catch (error) {
      console.error('[prd-confirm] 发送异常:', error)
      fail(opts?.typed ? '调整没有送达（连接中断）——弹窗已恢复，你的修改都还在，请重试。' : '确认没有送达（连接中断）：请直接在对话里发「确认这份 PRD」重试，或重新打开确认卡。')
      return
    }
    if (opts?.typed) resetLocalDialogState()
  }

  const submitConfirm = (): void => {
    // P2-2（2026-09-03 审计修复）：池里还有未提交的修改时，确认会静默丢弃用户已输入内容。
    // 拦下并展开修改池提示，让用户先「一次性提交全部修改」或移除条目，不再静默丢池。
    const pendingCount = adjustPool.filter((entry) => entry.text.trim()).length
    if (pendingCount > 0) {
      setAdjustOpen(true)
      setSubmitError(`你还有 ${pendingCount} 条修改未提交——请先「一次性提交全部修改」，或把池里的条目移除后再确认。`)
      return
    }
    void sendMessage(
      '确认这份 PRD，开始画草图。',
      'prd_confirm_confirm',
      adoptedIdeas.size > 0 ? [...adoptedIdeas] : undefined,
    )
  }

  const submitDismiss = (): void => {
    void sendMessage('稍后再说，先不确认。', 'prd_confirm_dismiss')
  }

  /** 批量提交（决议 7 累计池）：多条修改合并一次回传，向导一轮修订统一处理 */
  const submitPoolAdjust = (): void => {
    const texts = adjustPool.map((entry) => entry.text.trim()).filter(Boolean)
    if (texts.length === 0) return
    void sendMessage(texts.join('\n'), 'prd_confirm_adjust', undefined, { typed: true })
  }

  /** 点「这条不对」往池里压栈（同条目不重复；旧语义是替换——N 条修改只能一条一轮） */
  const openAdjustWith = (requirementId: string): void => {
    setAdjustOpen(true)
    setAdjustPool((previous) => {
      if (previous.some((entry) => entry.requirementId === requirementId)) return previous
      return [...previous, { entryId: crypto.randomUUID(), requirementId, text: `${requirementId} 这条不对：` }]
    })
  }

  const updatePoolEntry = (entryId: string, text: string): void => {
    setAdjustPool((previous) => previous.map((entry) => (entry.entryId === entryId ? { ...entry, text } : entry)))
  }

  const removePoolEntry = (entryId: string): void => {
    setAdjustPool((previous) => previous.filter((entry) => entry.entryId !== entryId))
  }

  const addBlankPoolEntry = (): void => {
    setAdjustPool((previous) => [...previous, { entryId: crypto.randomUUID(), requirementId: null, text: '' }])
  }

  const filledAdjustCount = adjustPool.filter((entry) => entry.text.trim()).length

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

        {/* 顶部固定说明行（闭环 PR7 婴儿模式）：看不懂的词直接指出，不猜 */}
        <p data-ai-id="prd-confirm-plain-intro" style={{ margin: 0, fontSize: 13, color: 'var(--color-text-secondary, #5b6472)' }}>
          下面是我们对你需求的理解，请逐条过目——看不懂的词，直接点「这条不对」告诉我们。
        </p>

        {/* 第一段：定位一句话 */}
        <div>
          <h3 style={sectionTitleStyle}>我们理解你要做的</h3>
          <p data-ai-id="prd-confirm-positioning" style={{ margin: '6px 0 0', fontSize: 14, lineHeight: 1.6 }}>
            {state.positioning || '（见功能清单）'}
          </p>
        </div>

        {/* 关键任务段（Phase 7 U1 H2，2026-09-10）：这一版做完什么才算交付——缺失/空数组隐藏（开关 off/无任务/旧夹具） */}
        {(state.keyTasks ?? []).length > 0 ? (
          <div data-ai-id="prd-confirm-key-tasks">
            <h3 style={sectionTitleStyle}>这一版做完这些才算交付（关键任务）</h3>
            <p style={{ margin: '4px 0 8px', fontSize: 12, color: 'var(--color-text-secondary, #5b6472)' }}>
              生成完成后，我们会按下面的任务逐项验证并如实报告做到没做到。
            </p>
            <div style={{ ...warnBlockStyle('caution'), marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {state.keyTasks!.map((task) => (
                <div key={task.taskId}>
                  <div style={{ fontWeight: 600 }}>
                    · {task.label}
                    {task.mustDeliver ? (
                      <span style={{ fontWeight: 400 }}>｜必须做到</span>
                    ) : (
                      <span style={{ fontWeight: 400 }}>｜尽力完成</span>
                    )}
                  </div>
                  {task.featureIds.length > 0 ? (
                    <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>关联功能：{task.featureIds.join('、')}</div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* 还需你确认的 1 件事（Phase 7 U4 J4）：CAP 待确认假设置顶强调——无 CAP 或无
            pending_assumption 时自动隐藏（不摆空架子） */}
        {(() => {
          const pending = (state.aiCapabilities ?? []).find((cap) => cap.source === 'pending_assumption')
          if (!pending) return null
          return (
            <div data-ai-id="prd-confirm-pending-cap" style={{ ...warnBlockStyle('danger'), marginTop: 6 }}>
              <div style={{ fontWeight: 600 }}>还需你确认的 1 件事：{pending.task}</div>
              <div style={{ fontSize: 12, marginTop: 4, opacity: 0.9 }}>
                这是根据常见做法假设的能力，还没有经你确认。确认这份 PRD 表示同意这样做；不同意可点「有要调整的」告诉我。
              </div>
            </div>
          )
        })()}

        {/* 第二段：功能清单（P0 断言展开 / P1P2 折叠，逐项可异议） */}
        <div>
          <h3 data-ai-id="prd-confirm-requirements-title" style={sectionTitleStyle}>
            功能清单（{state.requirements.length} 项）——{PRD_TERMS.P0}的每项都写清了{PRD_TERMS.assertion}
          </h3>
          <ul data-ai-id="prd-confirm-requirements" style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {state.requirements.map((item) => (
              <RequirementBlock key={item.id} item={item} onDisagree={openAdjustWith} />
            ))}
          </ul>
        </div>

        {/* 能力契约段（Phase 2 M1，2026-09-09）：AI/智能能力怎么算完成——缺失/空数组隐藏（开关 off/无 CAP/旧夹具） */}
        {(state.aiCapabilities ?? []).length > 0 ? (
          <div data-ai-id="prd-confirm-capabilities">
            <h3 style={sectionTitleStyle}>核心能力契约（{(state.aiCapabilities ?? []).length} 条）——这些能力怎么才算完成</h3>
            <div style={{ ...warnBlockStyle('caution'), marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {state.aiCapabilities!.map((cap) => (
                <div key={cap.capabilityId}>
                  <div style={{ fontWeight: 600 }}>
                    · {cap.task}
                    {cap.forbiddenSubstitutions.length > 0 ? <span style={{ fontWeight: 400 }}>｜不算完成：{cap.forbiddenSubstitutions.join('；')}</span> : null}
                  </div>
                  {cap.evidence.length > 0 ? (
                    <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>验收证据：{cap.evidence.join('；')}</div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* 第三段：明确不做的（高亮——事后争议最大） */}
        <div data-ai-id="prd-confirm-out-of-scope">
          <h3 style={sectionTitleStyle}>{PRD_TERMS.outOfScope}</h3>
          <div style={{ ...warnBlockStyle('danger'), marginTop: 6 }}>
            {state.outOfScope.length > 0 ? state.outOfScope.map((entry) => <div key={entry}>· {entry}</div>) : <div>（无明确排除项）</div>}
          </div>
        </div>

        {/* 第四段：系统替你做的决定（空段隐藏，不摆空架子） */}
        {state.assumptions.length > 0 ? (
          <div data-ai-id="prd-confirm-assumptions">
            <h3 style={sectionTitleStyle}>{PRD_TERMS.assumption}</h3>
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

        {/* 灵感参考（2026-08-29，市调想法可勾选采纳并入 PRD；空段隐藏） */}
        {state.ideas.length > 0 ? (
          <div data-ai-id="prd-confirm-ideas">
            <h3 style={sectionTitleStyle}>灵感参考（{state.ideasMode === 'agent' ? 'AI 灵感建议' : '市面上的做法'}）</h3>
            <p style={{ margin: '4px 0 8px', fontSize: 12, color: 'var(--color-text-secondary, #5b6472)' }}>
              看到想要的方向就勾上，确认后会并入这份 PRD 一起做；不勾就仅作参考。
            </p>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {state.ideas.map((idea) => {
                const adopted = adoptedIdeas.has(idea.label)
                return (
                  <li key={idea.label}>
                    <label
                      data-ai-id={`prd-confirm-idea-${idea.label.slice(0, 8)}`}
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
                      <input type="checkbox" checked={adopted} onChange={() => toggleIdea(idea.label)} style={{ marginTop: 2 }} />
                      <span>
                        <strong style={{ fontWeight: 600 }}>{idea.label}</strong>
                        {idea.note && <span style={{ color: 'var(--color-text-secondary, #5b6472)' }}> — {idea.note}</span>}
                        {idea.source && (
                          <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--color-text-muted, #8a93a5)' }} title={`来源：${idea.source}`}>
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
        ) : null}

        {/* PRD 全文（长文本，2026-09-03 形态切换）：向导工程腿产出的用户确认版 PRD 文档；
            quick 折叠 / longterm 展开（与完整视图一致）；旧背板无此字段时自动隐藏 */}
        {state.document ? (
          <details data-ai-id="prd-confirm-document" open={state.expanded} style={{ fontSize: 13 }}>
            <summary style={{ cursor: 'pointer', color: 'var(--color-text-secondary, #5b6472)' }}>
              完整 PRD 文档（长文本全文——确认即以此为准）
            </summary>
            <div
              data-ai-id="prd-confirm-document-body"
              style={{
                background: 'var(--color-bg-subtle, #f6f8fb)',
                padding: 12,
                borderRadius: 'var(--radius-sm)',
                marginTop: 10,
                maxHeight: 320,
                overflowY: 'auto',
                lineHeight: 1.8,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {state.document}
            </div>
          </details>
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
                  <span style={priorityBadgeStyle(item.priority)}>{priorityLabel(item.priority)}</span>
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
          <div data-ai-id="prd-confirm-adjust-pool" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span data-ai-id="prd-confirm-adjust-pool-count" style={sectionTitleStyle}>
              修改池（已累计 {adjustPool.length} 条）——全部改完一次性提交，向导一轮统一修订
            </span>
            {adjustPool.length === 0 ? (
              <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-secondary, #5b6472)' }}>
                点功能条目右侧的「这条不对」逐条累计到这里，或点下方按钮手动添加一条。
              </p>
            ) : (
              adjustPool.map((entry) => (
                <div
                  key={entry.entryId}
                  data-ai-id={`prd-confirm-adjust-entry-${entry.requirementId ?? 'free'}`}
                  style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
                >
                  <textarea
                    data-ai-id="prd-confirm-adjust-input"
                    value={entry.text}
                    onChange={(event) => updatePoolEntry(entry.entryId, event.target.value)}
                    placeholder={
                      entry.requirementId
                        ? `${entry.requirementId} 哪里不对、要怎么改？写在这里…`
                        : '想调整哪里？指出具体条目（如「F-002 的验收不对：我想要的是导出 Excel」）…'
                    }
                    style={{ ...inputStyle, minHeight: 56 }}
                  />
                  <button
                    type="button"
                    data-ai-id={`prd-confirm-adjust-remove-${entry.requirementId ?? entry.entryId.slice(0, 6)}`}
                    style={dismissButtonStyle}
                    onClick={() => removePoolEntry(entry.entryId)}
                  >
                    移除这条
                  </button>
                </div>
              ))
            )}
            <button type="button" data-ai-id="prd-confirm-adjust-add" style={secondaryButtonStyle} onClick={addBlankPoolEntry}>
              ＋ 再添加一条
            </button>
            {submitError && (
              <div
                data-ai-id="prd-confirm-submit-error"
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
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" style={secondaryButtonStyle} onClick={() => setAdjustOpen(false)}>
                收起（修改保留在池里）
              </button>
              <button
                type="button"
                data-ai-id="prd-confirm-adjust-send"
                style={{ ...primaryButtonStyle, opacity: filledAdjustCount > 0 ? 1 : 0.5 }}
                disabled={filledAdjustCount === 0 || submitting}
                onClick={submitPoolAdjust}
              >
                一次性提交全部修改（{filledAdjustCount} 条）
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
            {adjustPool.length > 0 ? (
              <button
                type="button"
                data-ai-id="prd-confirm-adjust-resume"
                style={{ ...secondaryButtonStyle, borderColor: 'var(--color-primary, #4f6ef7)' }}
                onClick={() => setAdjustOpen(true)}
              >
                继续调整（池里有 {adjustPool.length} 条）
              </button>
            ) : (
              <button type="button" style={secondaryButtonStyle} onClick={() => setAdjustOpen(true)}>
                有要调整的
              </button>
            )}
            <button type="button" data-ai-id="prd-confirm-submit" style={primaryButtonStyle} disabled={submitting} onClick={submitConfirm}>
              确认无误，开始画草图
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
