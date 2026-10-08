import React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import {
  activeAgentSessionIdAtom,
  correctionDoneAtom,
  correctionPicksAtom,
  correctionSessionAtom,
  currentProjectAtom,
} from '../agent-atoms'

/**
 * CorrectionPanel — 修改预览会话视图（批11 MVP-E，2026-10-08；嵌入 DeliveryPanel）。
 *
 * 方案 D 协作式纠错的 Bloma 侧呈现：启动隔离纠错实例（可见窗口+页内点选层，数据
 * 只读快照）；轮询 picks.jsonl 选区卡片流；产物侧「完成点选」后收口——主进程组装
 * 结构化反馈文本，本组件经 AGENT_SEND_MESSAGE 代发为普通用户消息，走 delivered
 * 反馈回炉链（意图层持久化——修改落在背板约束，不落文件补丁）。
 *
 * 视觉：品牌渐变头条与产物侧点选层（ui/correction.js w-corr-bar）同语言——用户在
 * 两个窗口看到的是同一件事的两种呈现。
 */
const KIND_META: Record<string, { label: string; bg: string; color: string }> = {
  guess: { label: '让系统猜', bg: '#f5f3ff', color: '#6d28d9' },
  visual: { label: '外观 / 布局', bg: '#eff6ff', color: '#1d4ed8' },
  function: { label: '功能 / 操作', bg: '#fff7ed', color: '#c2410c' },
}

const AVA_GRADIENTS = [
  ['linear-gradient(135deg,#4f46e5,#818cf8)', '#fff'],
  ['linear-gradient(135deg,#0ea5e9,#6366f1)', '#fff'],
  ['linear-gradient(135deg,#f59e0b,#ef4444)', '#fff'],
  ['linear-gradient(135deg,#10b981,#0ea5e9)', '#fff'],
]

export const CorrectionPanel: React.FC = () => {
  const project = useAtomValue(currentProjectAtom)
  const projectId = project?.project_id
  const sessionId = useAtomValue(activeAgentSessionIdAtom)
  const [session, setSession] = useAtom(correctionSessionAtom)
  const [picks, setPicks] = useAtom(correctionPicksAtom)
  const [done, setDone] = useAtom(correctionDoneAtom)
  const [sending, setSending] = React.useState(false)
  const [sent, setSent] = React.useState(false)
  const [applyError, setApplyError] = React.useState<string | undefined>(undefined)

  const active = session.status === 'active'

  const onStart = async (): Promise<void> => {
    if (!projectId) return
    setSession({ status: 'starting' })
    setPicks([])
    setSent(false)
    const api = window.electronAPI?.correction
    if (!api) {
      setSession({ status: 'error', message: '当前环境不支持修改预览通道' })
      return
    }
    const result = await api.start({ request_id: crypto.randomUUID(), project_id: projectId })
    if (result.ok && result.data.ok && result.data.session) {
      setSession({ status: 'active', sessionKey: result.data.session.sessionKey, startedAt: result.data.session.startedAt })
    } else {
      const message = result.ok ? result.data.error ?? '修改预览启动失败' : result.error?.user_visible_message ?? '修改预览启动失败'
      setSession({ status: 'error', message })
    }
  }

  /* 选区轮询（2s 文件交接） */
  React.useEffect(() => {
    if (!active || !projectId) return
    let stopped = false
    const poll = async (): Promise<void> => {
      const api = window.electronAPI?.correction
      if (!api || stopped) return
      const result = await api.picks({ request_id: crypto.randomUUID(), project_id: projectId })
      if (stopped) return
      if (result?.ok && result.data?.ok) {
        setPicks(result.data.picks)
        setDone(Boolean(result.data.done))
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 2000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [active, projectId, setPicks])

  /** 收口：finish（主进程组装反馈文本单一来源）→ 代发用户消息 → 回炉链。
   *  假成功防护（批11 审查修复，2026-10-08）：无活跃会话/finish 失败/发送异常均如实呈现
   *  错误且不发假「已提交」提示；无 sessionId 时不 finish（选区与会话保留可重试）。 */
  const onApply = async (): Promise<void> => {
    if (!projectId || !project || sending || sent) return
    if (!sessionId) {
      setApplyError('当前没有进行中的对话——请先在左侧对话里发一条消息，再回来点提交（点选已保留，不会丢）')
      return
    }
    setSending(true)
    setApplyError(undefined)
    try {
      const api = window.electronAPI?.correction
      const agentApi = window.electronAPI?.agent
      if (!api || !agentApi?.sendMessage) {
        setApplyError('当前环境不支持修改预览通道，点选已保留')
        return
      }
      const result = await api.finish({ request_id: crypto.randomUUID(), project_id: projectId })
      if (!result.ok || !result.data.ok || !result.data.feedback) {
        setApplyError('提交没有成功（预览可能已关闭或没有可提交的点选）——请重试，或直接在左侧对话里说要改哪里')
        return
      }
      await agentApi.sendMessage({
        request_id: crypto.randomUUID(),
        session_id: sessionId,
        project_id: projectId,
        content: result.data.feedback,
        mode: project.mode ?? 'longterm',
        current_stage: project.current_stage ?? 'completed',
      })
      setSent(true)
      setSession({ status: 'idle' })
      setPicks([])
      setDone(false)
    } catch {
      setApplyError('提交中断——请直接在左侧对话里告诉我要改哪里（重试可能会重复提交）')
    } finally {
      setSending(false)
    }
  }

  /** 取消/结束预览（丢弃选区，不发反馈） */
  const onDiscard = async (): Promise<void> => {
    if (!projectId) return
    const api = window.electronAPI?.correction
    if (api) await api.finish({ request_id: crypto.randomUUID(), project_id: projectId })
    setSession({ status: 'idle' })
    setPicks([])
    setDone(false)
    setApplyError(undefined)
  }

  /* ── 入口态（未启动） ─────────────────────────────────────── */
  if (session.status !== 'active') {
    return (
      <div style={{ padding: '4px 2px' }}>
        <button
          data-ai-id="correction-start-button"
          onClick={() => void onStart()}
          disabled={session.status === 'starting' || !projectId}
          style={{
            width: '100%',
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '12px 14px',
            background: session.status === 'starting' ? 'var(--gray-200)' : 'linear-gradient(90deg,#4f46e5,#818cf8)',
            color: session.status === 'starting' ? 'var(--gray-500)' : '#fff',
            border: 'none', borderRadius: 10,
            fontSize: 'var(--font-size-sm)', fontWeight: 600,
            cursor: session.status === 'starting' ? 'wait' : 'pointer',
            transition: 'opacity .15s ease, transform .1s ease',
            opacity: session.status === 'starting' ? 1 : 0.96,
          }}
          onMouseEnter={(e) => { if (session.status !== 'starting') e.currentTarget.style.opacity = '1' }}
          onMouseLeave={(e) => { if (session.status !== 'starting') e.currentTarget.style.opacity = '0.96' }}
        >
          <span style={{
            width: 24, height: 24, borderRadius: 999, flexShrink: 0,
            background: 'rgba(255,255,255,.22)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12,
          }}>✎</span>
          {session.status === 'starting' ? '正在打开修改预览…' : '修改这个应用'}
          <span style={{ marginLeft: 'auto', fontSize: 'var(--font-size-xs)', fontWeight: 400, opacity: 0.85 }}>
            {session.status === 'starting' ? '' : '点选你想改的地方'}
          </span>
        </button>
        {session.status === 'error' && (
          <p data-ai-id="correction-start-error" style={{ fontSize: 'var(--font-size-xs)', color: '#b91c1c', margin: '8px 2px 0', lineHeight: 1.6 }}>
            {session.message}
          </p>
        )}
        {sent && (
          <p data-ai-id="correction-sent-hint" style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', margin: '8px 2px 0', lineHeight: 1.6 }}>
            ✓ 修改意见已提交——制作进度看左侧对话，完成后会重新请你验收。
          </p>
        )}
      </div>
    )
  }

  /* ── 会话态（修改预览进行中） ──────────────────────────────── */
  return (
    <div data-ai-id="correction-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 4 }}>
      {/* 品牌头条（与产物侧点选层同语言） */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 12px', borderRadius: 10,
        background: 'linear-gradient(90deg,#4f46e5 0%,#6366f1 55%,#818cf8 100%)',
        color: '#fff', boxShadow: '0 2px 10px rgba(79,70,229,.3)',
      }}>
        <span style={{
          width: 22, height: 22, borderRadius: 999, flexShrink: 0,
          background: 'rgba(255,255,255,.22)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11,
        }}>✎</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700 }}>修改预览进行中</div>
          <div style={{ fontSize: 'var(--font-size-xs)', opacity: 0.85 }}>在弹出的窗口里直接点选想改的地方</div>
        </div>
        {picks.length > 0 && (
          <span style={{ padding: '2px 10px', borderRadius: 999, background: 'rgba(255,255,255,.2)', fontSize: 'var(--font-size-xs)', fontWeight: 600, flexShrink: 0 }}>
            已选 {picks.length} 处
          </span>
        )}
      </div>

      <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', margin: 0, lineHeight: 1.6 }}>
        数据是只读快照，不会动你的真实数据；点完在预览窗口点「完成点选」，或在这里直接开始修改。
      </p>

      {/* 选区卡片流 */}
      {picks.length === 0 ? (
        <div style={{
          border: '1.5px dashed var(--color-border)', borderRadius: 10,
          padding: '18px 12px', textAlign: 'center',
          fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', lineHeight: 1.7,
        }}>
          还没有点选——到修改预览窗口里，点一下想改的按钮、输入框或列表试试
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {picks.map((pick, index) => {
            const kind = KIND_META[pick.kind ?? 'guess'] ?? KIND_META.guess!
            const ava = AVA_GRADIENTS[index % AVA_GRADIENTS.length]!
            return (
              <div key={pick.seq ?? index} data-ai-id={`correction-pick-${pick.seq ?? index}`} style={{
                display: 'flex', gap: 10, alignItems: 'flex-start',
                background: 'var(--white)', border: '1px solid var(--color-border)',
                borderRadius: 10, padding: '10px 12px',
              }}>
                <span style={{
                  width: 26, height: 26, borderRadius: 999, flexShrink: 0,
                  background: ava[0], color: ava[1],
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 'var(--font-size-xs)', fontWeight: 700,
                }}>{index + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--color-text)' }}>
                      {pick.displayName ?? pick.componentId ?? '界面元素'}
                    </span>
                    <span style={{ padding: '1px 8px', borderRadius: 999, background: kind.bg, color: kind.color, fontSize: 'var(--font-size-xs)', fontWeight: 600 }}>
                      {kind.label}
                    </span>
                    {pick.preview?.detail && (
                      <span style={{ padding: '1px 8px', borderRadius: 999, background: '#ecfdf5', color: '#047857', fontSize: 'var(--font-size-xs)' }}>
                        试过 · {pick.preview.detail}
                      </span>
                    )}
                  </div>
                  {pick.note && (
                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 3, lineHeight: 1.5 }}>
                      「{pick.note}」
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 收口（产物侧 done 或手动） */}
      {done && picks.length > 0 && (
        <div style={{
          background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 10,
          padding: '10px 12px', fontSize: 'var(--font-size-xs)', color: '#065f46', fontWeight: 600,
        }}>
          ✓ 预览窗口里已提交 {picks.length} 处点选
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          data-ai-id="correction-apply-button"
          onClick={() => void onApply()}
          disabled={picks.length === 0 || sending || sent}
          style={{
            flex: 1, padding: '8px 0', border: 'none', borderRadius: 10,
            background: picks.length === 0 || sending ? 'var(--gray-200)' : 'linear-gradient(90deg,#4f46e5,#6366f1)',
            color: picks.length === 0 || sending ? 'var(--gray-500)' : '#fff',
            fontSize: 'var(--font-size-sm)', fontWeight: 700, cursor: picks.length === 0 || sending ? 'not-allowed' : 'pointer',
          }}
        >
          {sending ? '正在提交…' : `开始修改（${picks.length} 处）`}
        </button>
        <button
          data-ai-id="correction-discard-button"
          onClick={() => void onDiscard()}
          style={{
            padding: '8px 14px', border: '1px solid var(--color-border)', borderRadius: 10,
            background: 'var(--white)', color: 'var(--color-text-muted)',
            fontSize: 'var(--font-size-sm)', cursor: 'pointer',
          }}
        >
          结束预览
        </button>
      </div>
      {applyError && (
        <p data-ai-id="correction-apply-error" style={{ fontSize: 'var(--font-size-xs)', color: '#b91c1c', margin: 0, lineHeight: 1.6 }}>
          {applyError}
        </p>
      )}
    </div>
  )
}
