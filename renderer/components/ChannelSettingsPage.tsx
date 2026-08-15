/**
 * ChannelSettingsPage — 渠道管理设置页
 *
 * Sprint 2 B 交付物 · A2-17 B侧 + 迁移 Proma 渠道配置功能
 *
 * 功能：
 *   - 展示已配置渠道列表（名称/provider/模型数/启用状态）
 *   - 新增/编辑渠道表单（name / provider_type / base_url / api_key / models）
 *   - 保存前「测试连接」（testChannelDirect）与「拉取模型」（fetchModels）
 *   - 渠道编辑（updateChannel，api_key 留空 = 不更新）
 *   - 删除渠道确认
 *   - api_key 不回显明文（已加密 hex 只显示占位符）
 *
 * 说明：
 *   已对接 electronAPI.channels.*（list/create/update/test/testDirect/fetchModels/delete），
 *   A 侧已在 main/ipc.ts + preload/bridge.ts 完整实现。
 *   仅支持真实 Electron 链路，无主进程时静默跳过。
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
  ChannelUpdateInput,
  PromaPermissionMode,
  ProviderType,
} from '../../shared/types'
import { PROVIDER_DEFAULT_URLS, PROVIDER_LABELS } from '../../shared/types'
import {
  channelsListAtom,
  channelsLoadingAtom,
  channelTestResultAtom,
  permissionModeAtom,
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

const IconEdit: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden>
    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
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

const IconRefresh: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </svg>
)

const IconPlug: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden>
    <path d="M9 2v6" /><path d="M15 2v6" />
    <path d="M7 8h10v3a5 5 0 0 1-10 0V8z" />
    <path d="M12 16v6" />
  </svg>
)

// =========================================================================
// 常量（来自 shared/types 的 PROVIDER_DEFAULT_URLS / PROVIDER_LABELS）
// =========================================================================

/** provider 下拉展示顺序：常用 9 个在前，扩展的 12 个在后 */
const PROVIDER_ORDER: ProviderType[] = [
  'anthropic', 'openai', 'google', 'deepseek', 'zhipu', 'minimax', 'doubao', 'qwen', 'custom',
  'anthropic-compatible', 'openai-responses', 'kimi-api', 'kimi-coding', 'opencode-go-openai',
  'zhipu-coding', 'zhipu-coding-team', 'ark-coding-plan', 'qwen-anthropic', 'qwen-token-plan',
  'xiaomi', 'xiaomi-token-plan',
]

// =========================================================================
// 子组件：新增/编辑渠道表单
// =========================================================================

interface ChannelFormProps {
  mode: 'create' | 'edit'
  channelId?: string
  initial?: {
    name: string
    provider: ProviderType
    baseUrl: string
    models: ChannelModel[]
  }
  onSave: (input: ChannelCreateInput) => void
  onUpdate?: (channelId: string, input: ChannelUpdateInput) => void
  onCancel: () => void
  saving: boolean
}

function modelsToText(models: ChannelModel[]): string {
  return models.map((m) => m.name).join(', ')
}

function textToModels(provider: ProviderType, text: string): ChannelModel[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((modelName, i) => ({
      id: `${provider}-${modelName}-${i}`,
      name: modelName,
      enabled: true,
    }))
}

const ChannelForm: React.FC<ChannelFormProps> = ({ mode, channelId, initial, onSave, onUpdate, onCancel, saving }) => {
  const [name, setName] = useState(initial?.name ?? '')
  const [provider, setProvider] = useState<ProviderType>(initial?.provider ?? 'deepseek')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [modelsText, setModelsText] = useState(initial ? modelsToText(initial.models) : '')
  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState<{ ok: boolean; message: string } | null>(null)
  const [fetching, setFetching] = useState(false)
  const [fetchMsg, setFetchMsg] = useState<string | null>(null)

  // provider 变化时：编辑模式不清空已填 baseUrl；新增模式若未手填则自动带默认 URL
  const resolvedBaseUrl = baseUrl.trim() || PROVIDER_DEFAULT_URLS[provider] || ''

  // create 模式必须填 API Key；edit 模式留空表示不更新密钥
  const canSave =
    name.trim().length > 0 &&
    resolvedBaseUrl.length > 0 &&
    (mode === 'create' ? apiKey.trim().length > 0 : true) &&
    !saving

  // 测试连接 / 拉取模型：
  // create 模式必须填明文 API Key；edit 模式留空时回退到已保存渠道密钥（main 进程解密）。
  const canProbe =
    resolvedBaseUrl.length > 0 &&
    (mode === 'create' ? apiKey.trim().length > 0 : true) &&
    !testing && !fetching

  const handleProviderChange = (value: ProviderType) => {
    setProvider(value)
    // 未手填 baseUrl 时跟随默认值
    if (!baseUrl.trim()) setBaseUrl(PROVIDER_DEFAULT_URLS[value] || '')
  }

  const handleTest = useCallback(() => {
    const api = window.electronAPI
    // 仅支持真实 Electron 链路，无主进程时静默跳过（取消 demo 演示）
    if (!api?.channels?.testDirect) return
    setTesting(true)
    setTestMsg(null)
    void api.channels
      .testDirect({
        request_id: crypto.randomUUID(),
        input: {
          provider_type: provider,
          base_url: resolvedBaseUrl,
          // 编辑模式 Key 留空时由 main 进程回退到已保存渠道密钥
          api_key: apiKey.trim(),
          channel_id: mode === 'edit' ? channelId : undefined,
          model_id: textToModels(provider, modelsText)[0]?.name,
        },
      })
      .then((result) => {
        if (result.ok) setTestMsg({ ok: result.data.ok, message: result.data.message })
        else setTestMsg({ ok: false, message: result.error?.user_visible_message ?? '测试失败，请重试。' })
      })
      .catch(() => setTestMsg({ ok: false, message: '测试失败，请重试。' }))
      .finally(() => setTesting(false))
  }, [mode, channelId, provider, resolvedBaseUrl, apiKey, modelsText])

  const handleFetchModels = useCallback(() => {
    const api = window.electronAPI
    // 仅支持真实 Electron 链路，无主进程时静默跳过（取消 demo 演示）
    if (!api?.channels?.fetchModels) return
    setFetching(true)
    setFetchMsg(null)
    void api.channels
      .fetchModels({
        request_id: crypto.randomUUID(),
        input: {
          provider_type: provider,
          base_url: resolvedBaseUrl,
          // 编辑模式 Key 留空时由 main 进程回退到已保存渠道密钥
          api_key: apiKey.trim(),
          channel_id: mode === 'edit' ? channelId : undefined,
        },
      })
      .then((result) => {
        if (result.ok) {
          const models = result.data.models
          if (models.length === 0) {
            setFetchMsg('没有拉取到模型，可手动填写')
            return
          }
          // 合并进模型文本：保留已有手填项，追加新拉取项（按名称去重）
          const existing = new Set(modelsText.split(',').map((s) => s.trim()).filter(Boolean))
          const fresh = models.map((m) => m.name).filter((n) => !existing.has(n))
          setModelsText([...existing, ...fresh].join(', '))
          setFetchMsg(`成功获取 ${models.length} 个模型：${models.map((m) => m.name).slice(0, 3).join('、')}${models.length > 3 ? '…' : ''}`)
        } else {
          setFetchMsg(result.error?.user_visible_message ?? '拉取失败，请重试。')
        }
      })
      .catch(() => setFetchMsg('拉取失败，请重试。'))
      .finally(() => setFetching(false))
  }, [mode, channelId, provider, resolvedBaseUrl, apiKey, modelsText])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSave) return

    const models = textToModels(provider, modelsText)

    if (mode === 'create') {
      onSave({
        name: name.trim(),
        provider_type: provider,
        base_url: resolvedBaseUrl,
        api_key: apiKey.trim(),
        models: models.length > 0 ? models : undefined,
      })
    } else if (onUpdate && channelId) {
      onUpdate(channelId, {
        name: name.trim(),
        provider_type: provider,
        base_url: resolvedBaseUrl,
        models: models.length > 0 ? models : [],
        // 留空表示不更新密钥
        api_key: apiKey.trim() || undefined,
      })
    }
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
          onChange={(e) => handleProviderChange(e.target.value as ProviderType)}
        >
          {PROVIDER_ORDER.map((p) => (
            <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
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
          placeholder={PROVIDER_DEFAULT_URLS[provider] ? `留空使用 ${PROVIDER_DEFAULT_URLS[provider]}` : '自定义提供商请填写 Base URL'}
        />
      </div>

      {/* API Key */}
      <div>
        <label style={labelStyle}>API Key {mode === 'create' ? '*' : ''}</label>
        <input
          style={{ ...inputStyle, fontFamily: 'monospace' }}
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={mode === 'edit' ? '留空则不更新密钥' : 'sk-…'}
        />
        <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 4 }}>
          Key 将使用系统安全存储加密，不会明文保存
        </p>
      </div>

      {/* 模型列表 */}
      <div>
        <label style={labelStyle}>可用模型（逗号分隔）</label>
        <input
          style={inputStyle}
          value={modelsText}
          onChange={(e) => setModelsText(e.target.value)}
          placeholder="例如：deepseek-chat, deepseek-reasoner"
        />
        {modelsText.trim().length > 0 && (
          <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 4 }}>
            当前 {modelsText.split(',').filter((s) => s.trim()).length} 个模型
          </p>
        )}
      </div>

      {/* 测试连接 / 拉取模型 */}
      <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
        <button
          type="button"
          onClick={handleTest}
          disabled={!canProbe}
          style={{
            flex: 1,
            height: 36,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 'var(--space-2)',
            fontSize: 'var(--font-size-sm)',
            fontWeight: 600,
            color: canProbe ? 'var(--color-text)' : 'var(--color-text-muted)',
            background: 'var(--glass-bg-soft)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            cursor: canProbe ? 'pointer' : 'not-allowed',
            fontFamily: 'inherit',
            opacity: canProbe ? 1 : 0.5,
          }}
        >
          <IconPlug size={15} />
          {testing ? '测试中…' : '测试连接'}
        </button>
        <button
          type="button"
          onClick={handleFetchModels}
          disabled={!canProbe}
          style={{
            flex: 1,
            height: 36,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 'var(--space-2)',
            fontSize: 'var(--font-size-sm)',
            fontWeight: 600,
            color: canProbe ? 'var(--color-text)' : 'var(--color-text-muted)',
            background: 'var(--glass-bg-soft)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            cursor: canProbe ? 'pointer' : 'not-allowed',
            fontFamily: 'inherit',
            opacity: canProbe ? 1 : 0.5,
          }}
        >
          <IconRefresh size={15} />
          {fetching ? '拉取中…' : '拉取模型'}
        </button>
      </div>

      {/* 测试 / 拉取结果 */}
      {(testMsg || fetchMsg) && (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--space-2)',
            padding: 'var(--space-3) var(--space-4)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 'var(--font-size-sm)',
            fontWeight: 500,
            color: (testMsg && !testMsg.ok) ? '#991B1B' : '#065F46',
            background: (testMsg && !testMsg.ok) ? '#FEF2F2' : '#ECFDF5',
            border: `1px solid ${(testMsg && !testMsg.ok) ? '#FECACA' : '#A7F3D0'}`,
          }}
        >
          {(testMsg && !testMsg.ok) ? <IconAlertTriangle size={16} /> : <IconCheck size={16} />}
          <span>{testMsg?.message ?? fetchMsg}</span>
        </div>
      )}

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
          {saving ? '保存中…' : (mode === 'edit' ? '保存修改' : '保存渠道')}
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

// =========================================================================
// 权限模式三档选项（与 shared/types 的 PromaPermissionMode 对齐）
// =========================================================================

const PERMISSION_MODE_OPTIONS: { value: PromaPermissionMode; label: string; desc: string }[] = [
  { value: 'safe', label: '安全', desc: '危险操作直接拒绝' },
  { value: 'ask', label: '每次询问', desc: '执行前弹窗确认（默认）' },
  { value: 'allow-all', label: '全部放行', desc: '仅开发 / 演示用' },
]

export const ChannelSettingsPage: React.FC<ChannelSettingsPageProps> = ({ onBack }) => {
  const [channels, setChannels] = useAtom(channelsListAtom)
  const [loading, setLoading] = useAtom(channelsLoadingAtom)
  const [testResult, setTestResult] = useAtom(channelTestResultAtom)
  const [showForm, setShowForm] = useState(false)
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null)
  const [saving, setSaving] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [permissionMode, setPermissionModeAtom] = useAtom(permissionModeAtom)

  // ==================== 权限模式切换 ====================

  const handleChangePermissionMode = useCallback(
    (next: PromaPermissionMode) => {
      setPermissionModeAtom(next)
      const api = window.electronAPI
      if (api?.permissions?.setMode) {
        void api.permissions.setMode({ request_id: crypto.randomUUID(), mode: next })
      }
    },
    [setPermissionModeAtom],
  )

  // ==================== 加载渠道列表 ====================

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.channels?.list) return
    setLoading('loading')
    void api.channels
      .list({ request_id: crypto.randomUUID() })
      .then((result) => {
        if (result.ok) {
          setChannels(result.data)
          setLoading('loaded')
        } else {
          setLoading('error')
        }
      })
      .catch(() => setLoading('error'))
  }, [setChannels, setLoading])

  // ==================== 新增渠道 ====================

  const handleCreateChannel = useCallback(
    (input: ChannelCreateInput) => {
      const api = window.electronAPI
      // 仅支持真实 Electron 链路，无主进程时静默跳过（取消 demo 演示）
      if (!api?.channels?.create) return
      setSaving(true)
      void api.channels
        .create({ request_id: crypto.randomUUID(), ...input })
        .then((result) => {
          if (result.ok) {
            setChannels((prev) => [...prev, result.data])
            setShowForm(false)
            setEditingChannel(null)
          } else {
            setTestResult({ channelId: '', ok: false, message: result.error?.user_visible_message ?? '渠道创建失败，请重试。' })
          }
        })
        .catch(() => {
          setTestResult({ channelId: '', ok: false, message: '渠道创建失败，请重试。' })
        })
        .finally(() => setSaving(false))
    },
    [setChannels, setTestResult],
  )

  // ==================== 更新渠道（编辑） ====================

  const handleUpdateChannel = useCallback(
    (channelId: string, input: ChannelUpdateInput) => {
      const api = window.electronAPI
      // 仅支持真实 Electron 链路，无主进程时静默跳过（取消 demo 演示）
      if (!api?.channels?.update) return
      setSaving(true)
      void api.channels
        .update({ request_id: crypto.randomUUID(), channel_id: channelId, input })
        .then((result) => {
          if (result.ok) {
            setChannels((prev) => prev.map((c) => c.id === channelId ? result.data : c))
            setShowForm(false)
            setEditingChannel(null)
          } else {
            setTestResult({ channelId, ok: false, message: result.error?.user_visible_message ?? '渠道更新失败，请重试。' })
          }
        })
        .catch(() => {
          setTestResult({ channelId, ok: false, message: '渠道更新失败，请重试。' })
        })
        .finally(() => setSaving(false))
    },
    [setChannels, setTestResult],
  )

  const handleEditChannel = useCallback((channel: Channel) => {
    setEditingChannel(channel)
    setTestResult(null)
    setShowForm(true)
  }, [setTestResult])

  // ==================== 测试连接 ====================

  const handleTestConnection = useCallback(
    (channelId: string) => {
      const api = window.electronAPI
      if (!api?.channels?.test) return
      setTestingId(channelId)
      setTestResult(null)
      void api.channels
        .test({ channel_id: channelId, request_id: crypto.randomUUID() })
        .then((result) => {
          if (result.ok) {
            setTestResult({ channelId, ok: result.data.ok, message: result.data.message })
          } else {
            setTestResult({ channelId, ok: false, message: result.error?.user_visible_message ?? '测试失败，请重试。' })
          }
        })
        .catch(() => {
          setTestResult({ channelId, ok: false, message: '测试失败，请重试。' })
        })
        .finally(() => setTestingId(null))
    },
    [setTestResult],
  )

  // ==================== 删除渠道 ====================

  const handleDeleteChannel = useCallback(
    (channelId: string) => {
      const api = window.electronAPI
      if (!api?.channels?.delete) return
      void api.channels
        .delete({ channel_id: channelId, request_id: crypto.randomUUID() })
        .then((result) => {
          if (result.ok) {
            setChannels((prev) => prev.filter((c) => c.id !== channelId))
          } else {
            setTestResult({ channelId, ok: false, message: result.error?.user_visible_message ?? '删除失败，请重试。' })
          }
        })
        .catch(() => {
          setTestResult({ channelId, ok: false, message: '删除失败，请重试。' })
        })
        .finally(() => setDeleteConfirmId(null))
    },
    [setChannels, setTestResult],
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
        {/* ── 权限模式 ── */}
        <section
          aria-label="权限模式"
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}
        >
          <div>
            <h3 style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-text)', margin: 0 }}>
              权限模式
            </h3>
            <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', margin: '4px 0 0' }}>
              控制向导 Agent 执行本地操作时的确认策略
            </p>
          </div>
          <div role="radiogroup" aria-label="权限模式" style={{ display: 'flex', gap: 'var(--space-2)' }}>
            {PERMISSION_MODE_OPTIONS.map((opt) => {
              const active = permissionMode === opt.value
              return (
                <button
                  key={opt.value}
                  role="radio"
                  aria-checked={active}
                  onClick={() => handleChangePermissionMode(opt.value)}
                  data-ai-id={`permission-mode-${opt.value}`}
                  style={{
                    flex: 1,
                    padding: 'var(--space-3)',
                    textAlign: 'left',
                    borderRadius: 'var(--radius-md)',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    border: active ? '1px solid var(--color-quick)' : '1px solid var(--color-border)',
                    background: active ? 'var(--color-quick-soft)' : 'var(--white)',
                    transition: 'all var(--transition-fast)',
                  }}
                >
                  <span
                    style={{
                      display: 'block',
                      fontSize: 'var(--font-size-xs)',
                      fontWeight: 700,
                      color: active ? 'var(--color-quick)' : 'var(--color-text)',
                    }}
                  >
                    {opt.label}
                  </span>
                  <span
                    style={{
                      display: 'block',
                      fontSize: 'var(--font-size-xs)',
                      color: 'var(--color-text-muted)',
                      marginTop: 2,
                    }}
                  >
                    {opt.desc}
                  </span>
                </button>
              )
            })}
          </div>
        </section>

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
              onClick={() => {
                setEditingChannel(null)
                setShowForm(true)
              }}
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
                      {PROVIDER_LABELS[channel.provider_type] ?? channel.provider_type}
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

                  <button
                    onClick={() => handleEditChannel(channel)}
                    title="编辑渠道"
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
                      e.currentTarget.style.background = 'var(--color-quick-soft)'
                      e.currentTarget.style.color = 'var(--color-quick)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                      e.currentTarget.style.color = 'var(--color-text-muted)'
                    }}
                  >
                    <IconEdit size={16} />
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
              onClick={() => {
                setEditingChannel(null)
                setShowForm(true)
              }}
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

        {/* ── 新增/编辑表单 ── */}
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
                {editingChannel ? `编辑渠道：${editingChannel.name}` : '新增模型渠道'}
              </h3>
              <button
                onClick={() => {
                  setShowForm(false)
                  setEditingChannel(null)
                }}
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
              mode={editingChannel ? 'edit' : 'create'}
              channelId={editingChannel?.id}
              initial={editingChannel ? {
                name: editingChannel.name,
                provider: editingChannel.provider_type,
                baseUrl: editingChannel.base_url,
                models: editingChannel.models,
              } : undefined}
              onSave={handleCreateChannel}
              onUpdate={handleUpdateChannel}
              onCancel={() => {
                setShowForm(false)
                setEditingChannel(null)
              }}
              saving={saving}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export default ChannelSettingsPage
