/**
 * ChannelSettingsPage — 渠道管理设置页
 *
 * Sprint 2 B 交付物 · A2-17 B侧
 *
 * 功能：
 *   - 展示已配置渠道列表（名称/provider/模型数/启用状态）
 *   - 新增渠道表单（name / provider_type / base_url / api_key / models）
 *   - 测试连接按钮
 *   - 删除渠道确认
 *   - api_key 不回显明文（已加密 hex 只显示占位符）
 *
 * 说明：
 *   A 侧暂未实现 channel:list/create/test/delete 的 IPC channel
 *   （shared/types.ts IPC_CHANNELS 中无对应常量）。
 *   本组件使用本地 atoms（channelsListAtom 等）管理状态，
 *   集成时替换为 electronAPI.channels.* 调用。
 *
 * 集成方式：
 *   在 App.tsx 的 settings 路由中渲染，或通过设置面板/弹窗打开。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { useAtom } from 'jotai'
import type {
  Channel,
  ChannelCreateInput,
  ChannelModel,
  ProviderType,
} from '../../shared/types'
import {
  channelsListAtom,
  channelsLoadingAtom,
  channelTestResultAtom,
} from './atoms-sprint2'

// =========================================================================
// 内联 SVG 图标
// =========================================================================

const IconX: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden>
    <path d="M18 6 6 18" /><path d="M6 6l12 12" />
  </svg>
)

const IconPlus: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden>
    <path d="M12 5v14" /><path d="M5 12h14" />
  </svg>
)

const IconTrash: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden>
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
  </svg>
)

const IconZap: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden>
    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
  </svg>
)

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

const IconArrowLeft: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden>
    <path d="m15 18-6-6 6-6" />
  </svg>
)

// =========================================================================
// 常量
// =========================================================================

const PROVIDERS: { value: ProviderType; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'zhipu', label: '智谱' },
  { value: 'minimax', label: 'MiniMax' },
  { value: 'doubao', label: '豆包' },
  { value: 'qwen', label: '通义千问' },
  { value: 'custom', label: '自定义' },
]

const PROVIDER_LABEL_MAP: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  deepseek: 'DeepSeek',
  zhipu: '智谱',
  minimax: 'MiniMax',
  doubao: '豆包',
  qwen: '通义千问',
  custom: '自定义',
}

// =========================================================================
// 子组件：新增/编辑渠道表单
// =========================================================================

interface ChannelFormProps {
  onSave: (input: ChannelCreateInput) => void
  onCancel: () => void
  saving: boolean
}

const ChannelForm: React.FC<ChannelFormProps> = ({ onSave, onCancel, saving }) => {
  const [name, setName] = useState('')
  const [provider, setProvider] = useState<ProviderType>('deepseek')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [modelsText, setModelsText] = useState('')

  const canSave =
    name.trim().length > 0 && apiKey.trim().length > 0 && !saving

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSave) return

    const models: ChannelModel[] = modelsText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((modelName, i) => ({
        id: `${provider}-${modelName}-${i}`,
        name: modelName,
        enabled: true,
      }))

    onSave({
      name: name.trim(),
      provider_type: provider,
      base_url: baseUrl.trim() || '',
      api_key: apiKey.trim(),
      models: models.length > 0 ? models : undefined,
    })
  }

  const labelStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-xs)',
    fontWeight: 600,
    color: 'var(--color-text)',
    marginBottom: 4,
    display: 'block',
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    height: 38,
    padding: '0 var(--space-3)',
    fontSize: 'var(--font-size-sm)',
    fontFamily: 'inherit',
    color: 'var(--color-text)',
    background: 'var(--white)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    outline: 'none',
    boxSizing: 'border-box',
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      {/* 渠道名称 */}
      <div>
        <label style={labelStyle}>渠道名称 *</label>
        <input
          style={inputStyle}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：我的 DeepSeek"
          autoFocus
        />
      </div>

      {/* 提供商 */}
      <div>
        <label style={labelStyle}>模型提供商 *</label>
        <select
          style={inputStyle}
          value={provider}
          onChange={(e) => setProvider(e.target.value as ProviderType)}
        >
          {PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
      </div>

      {/* Base URL */}
      <div>
        <label style={labelStyle}>Base URL</label>
        <input
          style={inputStyle}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="留空使用默认地址"
        />
      </div>

      {/* API Key */}
      <div>
        <label style={labelStyle}>API Key *</label>
        <input
          style={{ ...inputStyle, fontFamily: 'monospace' }}
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-…"
        />
        <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 4 }}>
          Key 将使用系统安全存储加密，不会明文保存
        </p>
      </div>

      {/* 模型列表 */}
      <div>
        <label style={labelStyle}>可用模型（逗号分隔，可选）</label>
        <input
          style={inputStyle}
          value={modelsText}
          onChange={(e) => setModelsText(e.target.value)}
          placeholder="例如：deepseek-chat, deepseek-reasoner"
        />
        {modelsText.trim().length > 0 && (
          <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 4 }}>
            将添加 {modelsText.split(',').filter((s) => s.trim()).length} 个模型
          </p>
        )}
      </div>

      {/* 操作按钮 */}
      <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end', marginTop: 'var(--space-2)' }}>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          style={{
            height: 36,
            padding: '0 var(--space-5)',
            fontSize: 'var(--font-size-sm)',
            fontWeight: 600,
            color: 'var(--color-text)',
            background: 'var(--color-surface-muted)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            cursor: saving ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
            opacity: saving ? 0.5 : 1,
          }}
        >
          取消
        </button>
        <button
          type="submit"
          disabled={!canSave}
          style={{
            height: 36,
            padding: '0 var(--space-5)',
            fontSize: 'var(--font-size-sm)',
            fontWeight: 600,
            color: 'var(--white)',
            background: canSave
              ? 'linear-gradient(135deg, var(--color-quick), var(--color-quick-bright))'
              : 'var(--gray-300)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            cursor: canSave ? 'pointer' : 'not-allowed',
            fontFamily: 'inherit',
            boxShadow: canSave ? '0 4px 12px -2px rgba(124,58,237,0.35)' : 'none',
          }}
        >
          {saving ? '保存中…' : '保存渠道'}
        </button>
      </div>
    </form>
  )
}

// =========================================================================
// 主组件
// =========================================================================

export interface ChannelSettingsPageProps {
  /** 返回工作区的回调 */
  onBack?: () => void
}

export const ChannelSettingsPage: React.FC<ChannelSettingsPageProps> = ({ onBack }) => {
  const [channels, setChannels] = useAtom(channelsListAtom)
  const [loading, setLoading] = useAtom(channelsLoadingAtom)
  const [testResult, setTestResult] = useAtom(channelTestResultAtom)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  // ==================== 模拟数据加载 ====================
  // 集成时替换为: electronAPI.channels.list()

  useEffect(() => {
    if (loading === 'idle') {
      setLoading('loading')
      // 模拟异步加载
      const timer = setTimeout(() => {
        setLoading('loaded')
      }, 300)
      return () => clearTimeout(timer)
    }
  }, [loading, setLoading])

  // ==================== 新增渠道 ====================
  // 集成时替换为: electronAPI.channels.create(input)

  const handleCreateChannel = useCallback(
    (input: ChannelCreateInput) => {
      setSaving(true)
      // 模拟异步保存
      // 集成时替换为: electronAPI.channels.create(input)
      setTimeout(() => {
        const newChannel: Channel = {
          id: `ch-${Date.now()}`,
          name: input.name,
          provider_type: input.provider_type,
          base_url: input.base_url || '',
          /** M-002 修复（2026-08-12）：Channel.api_key 类型约定为 safeStorage 加密后的 hex 字符串，
           *  不是展示掩码。mock 使用明确占位值，集成后由 A 侧 createChannel handler 填充。 */
          api_key: '[encrypted-by-safeStorage]',
          models: input.models ?? [],
          enabled: true,
        }
        setChannels((prev) => [...prev, newChannel])
        setSaving(false)
        setShowForm(false)
      }, 500)
    },
    [setChannels],
  )

  // ==================== 测试连接 ====================
  // 集成时替换为: electronAPI.channels.test(channelId)
  // N-009 修复（2026-08-12）：mock 不再对所有 channelId 返回成功；
  // 仅当 channelId 存在于当前渠道列表中时才返回成功。

  const handleTestConnection = useCallback(
    (channelId: string) => {
      setTestingId(channelId)
      setTestResult(null)
      // 模拟异步测试
      setTimeout(() => {
        const exists = channels.some((c) => c.id === channelId)
        setTestResult({
          channelId,
          ok: exists,
          message: exists
            ? '连接成功，模型列表已同步'
            : '渠道不存在，请刷新后重试',
        })
        setTestingId(null)
        // 3 秒后清除结果
        setTimeout(() => setTestResult(null), 3000)
      }, 1500)
    },
    [channels, setTestResult],
  )

  // ==================== 删除渠道 ====================
  // 集成时替换为: electronAPI.channels.delete(channelId)

  const handleDeleteChannel = useCallback(
    (channelId: string) => {
      setChannels((prev) => prev.filter((c) => c.id !== channelId))
      setDeleteConfirmId(null)
    },
    [setChannels],
  )

  // ==================== 渲染 ====================

  return (
    <div
      data-ai-id="channel-settings-page"
      style={{
        position: 'relative',
        zIndex: 1,
        maxWidth: 680,
        margin: '0 auto',
        padding: 'var(--space-8) var(--space-5)',
      }}
    >
      {/* ── 头部 ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          marginBottom: 'var(--space-6)',
        }}
      >
        {onBack && (
          <button
            onClick={onBack}
            aria-label="返回工作区"
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
        )}
        <div>
          <h1
            style={{
              fontSize: 'var(--font-size-lg)',
              fontWeight: 700,
              color: 'var(--color-text)',
              margin: 0,
            }}
          >
            模型渠道管理
          </h1>
          <p
            style={{
              fontSize: 'var(--font-size-sm)',
              color: 'var(--color-text-muted)',
              margin: '4px 0 0',
            }}
          >
            配置 AI 模型连接，向导 Agent 将从这里调用模型
          </p>
        </div>
      </div>

      {/* ── 页面主体放在 glass tile 中 ── */}
      <div
        className="tile"
        style={{
          padding: 'var(--space-5)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        {/* ── 测试结果提示 ── */}
        {testResult && (
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
              color: testResult.ok ? '#065F46' : '#991B1B',
              background: testResult.ok ? '#ECFDF5' : '#FEF2F2',
              border: `1px solid ${testResult.ok ? '#A7F3D0' : '#FECACA'}`,
            }}
          >
            {testResult.ok ? <IconCheck size={18} /> : <IconAlertTriangle size={18} />}
            {testResult.message}
          </div>
        )}

        {/* ── 渠道列表 ── */}
        {loading === 'loading' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            {[1, 2].map((i) => (
              <div
                key={i}
                style={{
                  height: 64,
                  borderRadius: 'var(--radius-sm)',
                  animation: `shimmer 1.5s ease-in-out ${i * 0.15}s infinite`,
                  background: 'linear-gradient(90deg, var(--glass-bg-soft) 25%, var(--glass-bg) 50%, var(--glass-bg-soft) 75%)',
                  backgroundSize: '200% 100%',
                }}
              />
            ))}
          </div>
        ) : channels.length === 0 && !showForm ? (
          /* 空状态 */
          <div
            style={{
              textAlign: 'center',
              padding: 'var(--space-8) var(--space-4)',
            }}
          >
            <span
              aria-hidden
              style={{
                width: 56,
                height: 56,
                borderRadius: 'var(--radius-md)',
                background: 'var(--white)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 'var(--space-3)',
                color: 'var(--color-quick)',
                boxShadow: 'var(--shadow-sm)',
              }}
            >
              <IconZap size={28} />
            </span>
            <p style={{ fontSize: 'var(--font-size-md)', fontWeight: 600, color: 'var(--color-text)', marginBottom: 4 }}>
              还没有配置模型渠道
            </p>
            <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-4)' }}>
              添加一个模型渠道来让向导 Agent 开始工作
            </p>
            <button
              onClick={() => setShowForm(true)}
              style={{
                height: 38,
                padding: '0 var(--space-5)',
                fontSize: 'var(--font-size-sm)',
                fontWeight: 600,
                color: 'var(--white)',
                background: 'linear-gradient(135deg, var(--color-quick), var(--color-quick-bright))',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                fontFamily: 'inherit',
                boxShadow: '0 4px 12px -2px rgba(124,58,237,0.35)',
              }}
            >
              添加第一个渠道
            </button>
          </div>
        ) : (
          /* 渠道卡片列表 */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            {channels.map((channel) => (
              <div
                key={channel.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: 'var(--space-4)',
                  background: 'var(--white)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  gap: 'var(--space-3)',
                }}
              >
                {/* 渠道信息 */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 4 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: channel.enabled ? 'var(--color-success)' : 'var(--gray-400)',
                        display: 'inline-block',
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--color-text)' }}>
                      {channel.name}
                    </span>
                    <span
                      style={{
                        fontSize: 'var(--font-size-xs)',
                        color: 'var(--color-text-muted)',
                        padding: '2px var(--space-2)',
                        background: 'var(--glass-bg-soft)',
                        borderRadius: 'var(--radius-full)',
                      }}
                    >
                      {PROVIDER_LABEL_MAP[channel.provider_type]}
                    </span>
                  </div>
                  <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', margin: 0 }}>
                    {channel.models.length > 0
                      ? `${channel.models.length} 个模型：${channel.models.map((m) => m.name).join('、')}`
                      : '未配置模型'}
                    {channel.base_url && ` · ${channel.base_url}`}
                  </p>
                </div>

                {/* 操作按钮 */}
                <div style={{ display: 'flex', gap: 'var(--space-2)', flexShrink: 0 }}>
                  <button
                    onClick={() => handleTestConnection(channel.id)}
                    disabled={testingId === channel.id}
                    title="测试连接"
                    style={{
                      height: 32,
                      padding: '0 var(--space-3)',
                      fontSize: 'var(--font-size-xs)',
                      fontWeight: 500,
                      color: 'var(--color-text)',
                      background: 'var(--glass-bg-soft)',
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-sm)',
                      cursor: testingId ? 'not-allowed' : 'pointer',
                      fontFamily: 'inherit',
                      opacity: testingId ? 0.5 : 1,
                    }}
                  >
                    {testingId === channel.id ? '测试中…' : '测试连接'}
                  </button>

                  {deleteConfirmId === channel.id ? (
                    <>
                      <button
                        onClick={() => handleDeleteChannel(channel.id)}
                        style={{
                          height: 32,
                          padding: '0 var(--space-3)',
                          fontSize: 'var(--font-size-xs)',
                          fontWeight: 600,
                          color: 'var(--white)',
                          background: 'var(--color-danger)',
                          border: 'none',
                          borderRadius: 'var(--radius-sm)',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        确认删除
                      </button>
                      <button
                        onClick={() => setDeleteConfirmId(null)}
                        style={{
                          height: 32,
                          padding: '0 var(--space-3)',
                          fontSize: 'var(--font-size-xs)',
                          fontWeight: 500,
                          color: 'var(--color-text-muted)',
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setDeleteConfirmId(channel.id)}
                      title="删除渠道"
                      style={{
                        width: 32,
                        height: 32,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: 'var(--radius-sm)',
                        color: 'var(--color-text-muted)',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        transition: 'all var(--transition-fast)',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'var(--color-danger-soft)'
                        e.currentTarget.style.color = 'var(--color-danger)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent'
                        e.currentTarget.style.color = 'var(--color-text-muted)'
                      }}
                    >
                      <IconTrash size={16} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── 分隔线与新增按钮 ── */}
        {!showForm && channels.length > 0 && (
          <div style={{ paddingTop: 'var(--space-2)' }}>
            <button
              onClick={() => setShowForm(true)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                height: 38,
                padding: '0 var(--space-5)',
                fontSize: 'var(--font-size-sm)',
                fontWeight: 600,
                color: 'var(--color-quick)',
                background: 'var(--color-quick-soft)',
                border: '1px dashed var(--violet-200)',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                fontFamily: 'inherit',
                transition: 'all var(--transition-fast)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--violet-100)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--color-quick-soft)'
              }}
            >
              <IconPlus size={16} />
              添加新渠道
            </button>
          </div>
        )}

        {/* ── 新增表单 ── */}
        {showForm && (
          <div
            style={{
              padding: 'var(--space-5)',
              background: 'var(--glass-bg-soft)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              marginTop: 'var(--space-2)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 'var(--space-4)',
              }}
            >
              <h3 style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-text)', margin: 0 }}>
                新增模型渠道
              </h3>
              <button
                onClick={() => setShowForm(false)}
                disabled={saving}
                aria-label="关闭"
                style={{
                  width: 28,
                  height: 28,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--color-text-muted)',
                  background: 'transparent',
                  border: 'none',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  opacity: saving ? 0.5 : 1,
                }}
              >
                <IconX size={16} />
              </button>
            </div>
            <ChannelForm
              onSave={handleCreateChannel}
              onCancel={() => setShowForm(false)}
              saving={saving}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export default ChannelSettingsPage
