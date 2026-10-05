/**
 * SettingsPage — 设置页容器（Tab 切换）
 *
 * 统一管理设置入口的返回按钮、页面标题与 Tab 栏：
 *   - 「模型渠道」Tab：ChannelSettingsPage（渠道管理）
 *   - 「提示词配置」Tab：PromptSettingsPage（引擎提示词外置覆盖配置）
 *   - 「通知与声音」Tab：NotificationSoundSettingsPage（2026-10-06 体验批 A）
 *
 * 进入方式：App.tsx 的 settings 路由。返回按钮回到工作区。
 */

import React, { useState } from 'react'
import { ChannelSettingsPage } from './ChannelSettingsPage'
import { PromptSettingsPage } from './PromptSettingsPage'
import { NotificationSoundSettingsPage } from './NotificationSoundSettingsPage'

const IconArrowLeft: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden>
    <path d="m15 18-6-6 6-6" />
  </svg>
)

const IconSettings: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

type SettingsTab = 'channels' | 'prompts' | 'sound'

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'channels', label: '模型渠道' },
  { id: 'prompts', label: '提示词配置' },
  { id: 'sound', label: '通知与声音' },
]

export interface SettingsPageProps {
  /** 返回工作区回调 */
  onBack: () => void
}

export const SettingsPage: React.FC<SettingsPageProps> = ({ onBack }) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>('channels')

  return (
    <div data-ai-id="settings-page" style={{ position: 'relative', zIndex: 1 }}>
      {/* ── 页面头部：返回 + 标题 + Tab ── */}
      <div
        style={{
          maxWidth: 720,
          margin: '0 auto',
          padding: 'var(--space-6) var(--space-5) var(--space-4)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-5)' }}>
          <button
            onClick={onBack}
            aria-label="返回工作区"
            data-ai-id="settings-back"
            style={{
              width: 36,
              height: 36,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--color-text-muted)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              transition: 'all var(--transition-fast)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--color-surface-muted)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
            }}
          >
            <IconArrowLeft size={20} />
          </button>
          <div>
            <h1 style={{ fontSize: 'var(--font-size-lg)', fontWeight: 700, color: 'var(--color-text)', margin: 0 }}>
              设置
            </h1>
            <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)', margin: '4px 0 0' }}>
              配置模型渠道与引擎提示词
            </p>
          </div>
          <span
            aria-hidden
            style={{
              marginLeft: 'auto',
              width: 40,
              height: 40,
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-quick-soft)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--color-quick)',
            }}
          >
            <IconSettings size={20} />
          </span>
        </div>

        {/* ── Tab 栏 ── */}
        <div role="tablist" aria-label="设置分类" style={{ display: 'flex', gap: 'var(--space-2)' }}>
          {SETTINGS_TABS.map((tab) => {
            const active = activeTab === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveTab(tab.id)}
                data-ai-id={`settings-tab-${tab.id}`}
                style={{
                  flex: 1,
                  height: 38,
                  fontSize: 'var(--font-size-sm)',
                  fontWeight: 600,
                  fontFamily: 'inherit',
                  color: active ? 'var(--color-quick)' : 'var(--color-text-muted)',
                  background: active ? 'var(--color-quick-soft)' : 'transparent',
                  border: `1px solid ${active ? 'var(--color-quick)' : 'var(--color-border)'}`,
                  borderRadius: 'var(--radius-md)',
                  cursor: 'pointer',
                  transition: 'all var(--transition-fast)',
                }}
              >
                {tab.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* ── Tab 内容 ── */}
      {activeTab === 'channels' ? <ChannelSettingsPage /> : activeTab === 'sound' ? <NotificationSoundSettingsPage /> : <PromptSettingsPage />}
    </div>
  )
}

export default SettingsPage
