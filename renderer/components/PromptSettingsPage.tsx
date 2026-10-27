/**
 * PromptSettingsPage — 设置页「提示词配置」Tab
 *
 * 功能：
 *   - 展示全部提示词槽位（prd-system 已启用可编辑，sketch/mvp/guide 预留未启用）
 *   - 编辑已启用槽位的提示词全文，保存后写入 {PROMA_HOME}/prompts/{id}.md 即时生效
 *   - 「恢复内置默认」删除覆盖文件，回到引擎内置提示词
 *   - 未启用槽位只读展示，标注「未启用」
 *
 * 说明：
 *   已对接 electronAPI.prompts.*（list/read/save/reset），A 侧已在 main/ipc.ts +
 *   preload/bridge.ts 完整实现。仅支持真实 Electron 链路，无主进程时静默跳过。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { useAtom } from 'jotai'
import type { PromptSlotDetail, PromptSlotId, PromptSlotInfo } from '../../shared/types'
import {
  promptActiveSlotIdAtom,
  promptSlotsAtom,
  promptSlotsLoadingAtom,
  promptSaveStatusAtom,
} from './atoms-sprint2'

// =========================================================================
// 内联 SVG 图标
// =========================================================================

const IconCheck: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden>
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

const IconAlertTriangle: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <path d="M12 9v4" /><path d="M12 17h.01" />
  </svg>
)

const IconLock: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden>
    <rect width="18" height="11" x="3" y="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
)

const IconFileText: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" />
  </svg>
)

const IconRefresh: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </svg>
)

// =========================================================================
// 子组件：槽位列表
// =========================================================================

interface PromptSlotCardProps {
  detail: PromptSlotInfo
  active: boolean
  onClick: () => void
}

const PromptSlotCard: React.FC<PromptSlotCardProps> = ({ detail, active, onClick }) => {
  const statusColor = detail.enabled ? 'var(--color-quick)' : 'var(--gray-400)'
  const statusText = detail.enabled ? '已启用' : '已退役 · 历史只读'
  return (
    <button
      type="button"
      onClick={onClick}
      data-ai-id={`prompt-slot-${detail.id}`}
      aria-pressed={active}
      style={{
        flex: '1 1 220px',
        maxWidth: '100%',
        padding: 'var(--space-3) var(--space-4)',
        textAlign: 'left',
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        border: active ? '1px solid var(--color-quick)' : '1px solid var(--color-border)',
        background: active ? 'var(--color-quick-soft)' : 'var(--white)',
        transition: 'all var(--transition-fast)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 2 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: statusColor,
            display: 'inline-block',
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: 'var(--font-size-xs)',
            fontWeight: 700,
            color: active ? 'var(--color-quick)' : 'var(--color-text)',
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {detail.label}
        </span>
        {detail.has_override && (
          <span
            style={{
              fontSize: 'var(--font-size-xs)',
              color: 'var(--color-warning)',
              padding: '1px var(--space-2)',
              background: 'var(--color-warning-soft, #FEF3C7)',
              borderRadius: 'var(--radius-full)',
              whiteSpace: 'nowrap',
            }}
          >
            {detail.enabled?'自定义中':'历史覆盖已保留'}
          </span>
        )}
      </div>
      <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', margin: 0 }}>
        {statusText} · {detail.description.length > 46 ? `${detail.description.slice(0, 46)}…` : detail.description}
      </p>
    </button>
  )
}

// =========================================================================
// 主组件
// =========================================================================

const EMPTY_DETAIL: PromptSlotDetail = {
  id: 'sketch-system',
  label: '',
  description: '',
  enabled: false,
  has_override: false,
  content: '',
}

export const PromptSettingsPage: React.FC = () => {
  const [slots, setSlots] = useAtom(promptSlotsAtom)
  const [loading, setLoading] = useAtom(promptSlotsLoadingAtom)
  const [activeSlotId, setActiveSlotId] = useAtom(promptActiveSlotIdAtom)
  const [saveStatus, setSaveStatus] = useAtom(promptSaveStatusAtom)

  const [detail, setDetail] = useState<PromptSlotDetail>(EMPTY_DETAIL)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  // 加载槽位列表，默认选中第一个已启用槽位
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.prompts?.list) return
    setLoading('loading')
    void api.prompts
      .list({ request_id: crypto.randomUUID() })
      .then((result) => {
        if (result.ok) {
          setSlots(result.data)
          setLoading('loaded')
          const firstEnabled = result.data.find((s) => s.enabled)
          setActiveSlotId((prev) => prev&&result.data.some(slot=>slot.id===prev) ? prev : (firstEnabled?.id ?? result.data[0]?.id ?? null))
        } else {
          setLoading('error')
        }
      })
      .catch(() => setLoading('error'))
  }, [setSlots, setLoading, setActiveSlotId])

  // 选中槽位变化时加载详情
  const loadDetail = useCallback((id: PromptSlotId) => {
    const api = window.electronAPI
    if (!api?.prompts?.read) return
    void api.prompts
      .read({ request_id: crypto.randomUUID(), prompt_id: id })
      .then((result) => {
        if (result.ok) {
          setDetail(result.data)
          setDraft(result.data.content)
        }
      })
  }, [])

  useEffect(() => {
    if (!activeSlotId) return
    setSaveStatus(null)
    loadDetail(activeSlotId)
  }, [activeSlotId, loadDetail, setSaveStatus])

  // 切换选中槽位
  const handleSelectSlot = useCallback((id: PromptSlotId) => {
    setActiveSlotId(id)
  }, [setActiveSlotId])

  // 保存覆盖提示词
  const handleSave = useCallback(() => {
    const api = window.electronAPI
    if (!api?.prompts?.save || !activeSlotId) return
    setSaving(true)
    setSaveStatus(null)
    void api.prompts
      .save({ request_id: crypto.randomUUID(), prompt_id: activeSlotId, content: draft })
      .then((result) => {
        if (result.ok) {
          const trimmed = draft.trim()
          setSaveStatus({ ok: true, message: '已保存，下次生成时立即生效。' })
          // 刷新详情：has_override 变 true、content 为已保存内容，编辑框同步 trim 后的落盘内容
          setDetail((prev) => ({ ...prev, has_override: true, content: trimmed }))
          setDraft(trimmed)
          setSlots((prev) => prev.map((s) => (s.id === activeSlotId ? { ...s, has_override: true } : s)))
        } else {
          setSaveStatus({ ok: false, message: result.error?.user_visible_message ?? '保存失败，请重试。' })
        }
      })
      .catch(() => setSaveStatus({ ok: false, message: '保存失败，请重试。' }))
      .finally(() => setSaving(false))
  }, [activeSlotId, draft, setSaveStatus, setSlots])

  // 恢复内置默认（删除覆盖文件）
  const handleReset = useCallback(() => {
    const api = window.electronAPI
    if (!api?.prompts?.reset || !activeSlotId) return
    setSaving(true)
    setSaveStatus(null)
    void api.prompts
      .reset({ request_id: crypto.randomUUID(), prompt_id: activeSlotId })
      .then((result) => {
        if (result.ok) {
          setSaveStatus({ ok: true, message: '已恢复为内置默认提示词。' })
          loadDetail(activeSlotId)
          setSlots((prev) => prev.map((s) => (s.id === activeSlotId ? { ...s, has_override: false } : s)))
        } else {
          setSaveStatus({ ok: false, message: result.error?.user_visible_message ?? '恢复失败，请重试。' })
        }
      })
      .catch(() => setSaveStatus({ ok: false, message: '恢复失败，请重试。' }))
      .finally(() => setSaving(false))
  }, [activeSlotId, loadDetail, setSaveStatus, setSlots])

  const isEditable = detail.enabled

  return (
    <div
      data-ai-id="prompt-settings-page"
      style={{
        position: 'relative',
        zIndex: 1,
        maxWidth: 680,
        margin: '0 auto',
        padding: 'var(--space-8) var(--space-5)',
      }}
    >
      {/* ── 小节标题 ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
        <span
          aria-hidden
          style={{
            width: 40,
            height: 40,
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-quick-soft)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--color-quick)',
            flexShrink: 0,
          }}
        >
          <IconFileText size={20} />
        </span>
        <div>
          <h2 style={{ fontSize: 'var(--font-size-md)', fontWeight: 700, color: 'var(--color-text)', margin: 0 }}>
            提示词配置
          </h2>
          <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', margin: '2px 0 0' }}>
            调整引擎生成时使用的提示词。保存后立即生效，无需重启。
          </p>
        </div>
      </div>

      {/* ── 页面主体放在 glass tile 中 ── */}
      <div className="tile" style={{ padding: 'var(--space-5)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {/* ── 槽位列表 ── */}
        {loading === 'loading' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            {[1, 2].map((i) => (
              <div
                key={i}
                style={{
                  height: 56,
                  borderRadius: 'var(--radius-sm)',
                  animation: `shimmer 1.5s ease-in-out ${i * 0.15}s infinite`,
                  background: 'linear-gradient(90deg, var(--glass-bg-soft) 25%, var(--glass-bg) 50%, var(--glass-bg-soft) 75%)',
                  backgroundSize: '200% 100%',
                }}
              />
            ))}
          </div>
        ) : loading === 'error' ? (
          <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', color: 'var(--color-danger)', fontSize: 'var(--font-size-sm)', padding: 'var(--space-3) var(--space-4)' }}>
            <IconAlertTriangle size={16} />
            <span>提示词列表加载失败，请重试。</span>
          </div>
        ) : slots.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 'var(--space-8) var(--space-4)', color: 'var(--color-text-muted)', fontSize: 'var(--font-size-sm)' }}>
            暂无可用提示词配置。
          </div>
        ) : (
          <div data-ai-id="prompt-slot-list" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
            {slots.map((slot) => (
              <PromptSlotCard
                key={slot.id}
                detail={slot}
                active={slot.id === activeSlotId}
                onClick={() => handleSelectSlot(slot.id)}
              />
            ))}
          </div>
        )}

        {/* ── 编辑器 ── */}
        {activeSlotId && loading === 'loaded' && (
          <div
            data-ai-id="prompt-editor"
            style={{
              padding: 'var(--space-5)',
              background: 'var(--glass-bg-soft)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-4)',
            }}
          >
            {isEditable ? (
              <>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-text)' }}>
                      {detail.label}（覆盖引擎内置默认）
                    </label>
                    <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>
                      {draft.length} 字 · {draft.split('\n').length} 行
                    </span>
                  </div>
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    spellCheck={false}
                    style={{
                      width: '100%',
                      minHeight: 320,
                      padding: 'var(--space-3)',
                      fontSize: 'var(--font-size-sm)',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      lineHeight: 1.6,
                      color: 'var(--color-text)',
                      background: 'var(--white)',
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-sm)',
                      outline: 'none',
                      boxSizing: 'border-box',
                      resize: 'vertical',
                    }}
                  />
                  <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', margin: '4px 0 0' }}>
                    留空并保存无效；「恢复内置默认」可随时回到引擎原始提示词。
                  </p>
                </div>

                {/* 状态提示 */}
                {saveStatus && (
                  <div
                    role="status"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-2)',
                      padding: 'var(--space-3) var(--space-4)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 'var(--font-size-sm)',
                      fontWeight: 500,
                      color: saveStatus.ok ? '#065F46' : '#991B1B',
                      background: saveStatus.ok ? '#ECFDF5' : '#FEF2F2',
                      border: `1px solid ${saveStatus.ok ? '#A7F3D0' : '#FECACA'}`,
                    }}
                  >
                    {saveStatus.ok ? <IconCheck size={16} /> : <IconAlertTriangle size={16} />}
                    <span>{saveStatus.message}</span>
                  </div>
                )}

                {/* 操作按钮 */}
                <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end' }}>
                  {detail.has_override && (
                    <button
                      type="button"
                      onClick={handleReset}
                      disabled={saving}
                      data-ai-id="prompt-reset"
                      title="删除覆盖文件，回到引擎内置提示词"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 'var(--space-2)',
                        height: 36,
                        padding: '0 var(--space-4)',
                        fontSize: 'var(--font-size-sm)',
                        fontWeight: 600,
                        color: 'var(--color-text-muted)',
                        background: 'transparent',
                        border: '1px solid var(--color-border)',
                        borderRadius: 'var(--radius-sm)',
                        cursor: saving ? 'not-allowed' : 'pointer',
                        fontFamily: 'inherit',
                        opacity: saving ? 0.5 : 1,
                      }}
                    >
                      <IconRefresh size={15} />
                      恢复内置默认
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving || !draft.trim()}
                    data-ai-id="prompt-save"
                    style={{
                      height: 36,
                      padding: '0 var(--space-5)',
                      fontSize: 'var(--font-size-sm)',
                      fontWeight: 600,
                      color: 'var(--white)',
                      background: !saving && draft.trim()
                        ? 'linear-gradient(135deg, var(--color-quick), var(--color-quick-bright))'
                        : 'var(--gray-300)',
                      border: 'none',
                      borderRadius: 'var(--radius-sm)',
                      cursor: !saving && draft.trim() ? 'pointer' : 'not-allowed',
                      fontFamily: 'inherit',
                      boxShadow: !saving && draft.trim() ? '0 4px 12px -2px rgba(124,58,237,0.35)' : 'none',
                    }}
                  >
                    {saving ? '保存中…' : '保存'}
                  </button>
                </div>
              </>
            ) : (
              /* 未启用槽位：只读说明 */
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-8) var(--space-4)', textAlign: 'center' }}>
                <span
                  aria-hidden
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--glass-bg-soft)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--gray-400)',
                  }}
                >
                  <IconLock size={22} />
                </span>
                <div>
                  <p style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--color-text)', margin: 0 }}>
                    {detail.label}
                  </p>
                  <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', margin: '4px 0 0' }}>
                    {detail.description}
                  </p>
                  {detail.has_override&&<textarea aria-label="历史提示词（只读）" readOnly value={detail.content} style={{width:'100%',minHeight:180,marginTop:12}}/>}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default PromptSettingsPage
