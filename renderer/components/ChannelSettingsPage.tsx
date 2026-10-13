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

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAtom } from 'jotai'
import type {
  AgentRoutingRole,
  CategoryRoutingRoleUpdateEnvelope,
  CategoryRoutingRoleView,
  Channel,
  ChannelCreateInput,
  ChannelModel,
  ChannelUpdateInput,
  DocumentCategory,
  PromaPermissionMode,
  ProviderType,
} from '../../shared/types'
import {
  PROVIDER_DEFAULT_URLS,
  PROVIDER_LABELS,
  isAgentProtocolProvider,
} from '../../shared/types'
import {
  categoryRoutingRoleViewsAtom,
  channelsListAtom,
  channelsLoadingAtom,
  channelTestResultAtom,
  permissionModeAtom,
  refreshChannelsList,
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

/** 逗号分隔文本 → 模型条目（手动添加/历史数据兼容；按名称去重，默认启用） */
function textToModels(provider: ProviderType, text: string): ChannelModel[] {
  const seen = new Set<string>()
  const out: ChannelModel[] = []
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((modelName, i) => {
      if (seen.has(modelName)) return
      seen.add(modelName)
      out.push({ id: `${provider}-${modelName}-${i}`, name: modelName, enabled: true, source: 'manual' })
    })
  return out
}

/** 保证同一渠道内模型 id 唯一（勾选列表按 id 定位，撞车会一次改到两条） */
function withUniqueId(list: ChannelModel[], candidate: ChannelModel): ChannelModel {
  const taken = new Set(list.map((m) => m.id))
  if (!taken.has(candidate.id)) return candidate
  let n = 1
  while (taken.has(`${candidate.id}#${n}`)) n += 1
  return { ...candidate, id: `${candidate.id}#${n}` }
}

/**
 * 把拉取到的模型并入选中列表：已有条目保持原启用状态与能力位，
 * 新条目默认启用（按名称去重）。修复旧文本框实现「拉一次模型就把全部启用位重置为 true」。
 */
function mergeFetchedModels(existing: ChannelModel[], provider: ProviderType, fetched: ChannelModel[]): ChannelModel[] {
  const byName = new Map(existing.map((m) => [m.name, m]))
  let next = existing
  const appended: ChannelModel[] = []
  for (const m of fetched) {
    const name = (m.name || m.id || '').trim()
    if (!name || byName.has(name)) continue
    const candidate: ChannelModel = {
      id: m.id || `${provider}-${name}-f${appended.length}`,
      name,
      enabled: m.enabled !== false,
      source: 'fetched',
      ...(m.supports_tools === undefined ? {} : { supports_tools: m.supports_tools }),
      ...(m.edit_format === undefined ? {} : { edit_format: m.edit_format }),
    }
    byName.set(name, candidate)
    appended.push(candidate)
  }
  if (appended.length === 0) return next
  next = [...existing]
  for (const cand of appended) next.push(withUniqueId(next, cand))
  return next
}

const ChannelForm: React.FC<ChannelFormProps> = ({ mode, channelId, initial, onSave, onUpdate, onCancel, saving }) => {
  const [name, setName] = useState(initial?.name ?? '')
  const [provider, setProvider] = useState<ProviderType>(initial?.provider ?? 'deepseek')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  // 模型点选列表状态（用户 2026-08-30 点名：逗号文本框在阿里云 245 模型下不可用）
  const [modelList, setModelList] = useState<ChannelModel[]>(initial?.models ?? [])
  const [modelFilter, setModelFilter] = useState('')
  const [newModelName, setNewModelName] = useState('')
  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState<{ ok: boolean; message: string } | null>(null)
  const [fetching, setFetching] = useState(false)
  const [fetchMsg, setFetchMsg] = useState<{ ok: boolean; message: string } | null>(null)

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
          model_id: (modelList.find((m) => m.enabled) ?? modelList[0])?.name,
        },
      })
      .then((result) => {
        if (result.ok) setTestMsg({ ok: result.data.ok, message: result.data.message })
        else setTestMsg({ ok: false, message: result.error?.user_visible_message ?? '测试失败，请重试。' })
      })
      .catch(() => setTestMsg({ ok: false, message: '测试失败，请重试。' }))
      .finally(() => setTesting(false))
  }, [mode, channelId, provider, resolvedBaseUrl, apiKey, modelList])

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
            setFetchMsg({ ok: false, message: '没有拉取到模型，可手动填写' })
            return
          }
          // 合并进勾选列表：已有条目保留启用状态，新条目默认启用（按名称去重）
          setModelList((prev) => mergeFetchedModels(prev, provider, models))
          setFetchMsg({ ok: true, message: `成功获取 ${models.length} 个模型：${models.map((m) => m.name).slice(0, 3).join('、')}${models.length > 3 ? '…' : ''}` })
        } else {
          setFetchMsg({ ok: false, message: result.error?.user_visible_message ?? '拉取失败，请重试。' })
        }
      })
      .catch(() => setFetchMsg({ ok: false, message: '拉取失败，请重试。' }))
      .finally(() => setFetching(false))
  }, [mode, channelId, provider, resolvedBaseUrl, apiKey])

  // ===== 模型勾选列表：过滤 / 开关 / 全选清空 / 手动添加 / 移除 =====
  const keyword = modelFilter.trim().toLowerCase()
  const filteredModels = keyword
    ? modelList.filter((m) => `${m.name} ${m.id}`.toLowerCase().includes(keyword))
    : modelList
  const enabledCount = modelList.filter((m) => m.enabled).length

  const handleToggleModel = (id: string) => {
    setModelList((prev) => prev.map((m) => (m.id === id ? { ...m, enabled: !m.enabled } : m)))
  }

  const handleRemoveModel = (id: string) => {
    setModelList((prev) => prev.filter((m) => m.id !== id))
  }

  /** 全选/清空只作用于当前筛选结果（避免搜「qwen」时误动其余 200+ 模型） */
  const applyEnabledToFiltered = (enabled: boolean) => {
    const ids = new Set(filteredModels.map((m) => m.id))
    setModelList((prev) => prev.map((m) => (ids.has(m.id) ? { ...m, enabled } : m)))
  }

  /** 手动添加：支持逗号批量；重名不新增，只把已有条目重新启用 */
  const handleAddModel = () => {
    const names = textToModels(provider, newModelName)
    if (names.length === 0) return
    setModelList((prev) => {
      const known = new Set(prev.map((m) => m.name))
      const reEnabled = new Set(names.filter((m) => known.has(m.name)).map((m) => m.name))
      const added = names.filter((m) => !known.has(m.name))
      const base = reEnabled.size > 0
        ? prev.map((m) => (reEnabled.has(m.name) ? { ...m, enabled: true } : m))
        : prev
      if (added.length === 0) return base
      const merged = [...base]
      for (const cand of added) merged.push(withUniqueId(merged, cand))
      return merged
    })
    setNewModelName('')
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSave) return

    // 整表保存（含未启用项），使取消勾选可持久化并允许日后重新启用
    const models = modelList

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

  const miniBtnStyle = (disabled: boolean): React.CSSProperties => ({
    height: 26,
    padding: '0 var(--space-3)',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 600,
    color: disabled ? 'var(--color-text-muted)' : 'var(--color-text)',
    background: 'var(--glass-bg-soft)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit',
    opacity: disabled ? 0.5 : 1,
    flexShrink: 0,
  })

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      {/* 渠道名称（QW#5：去「渠道」黑话，0 基础用户不知道什么是渠道） */}
      <div>
        <label style={labelStyle}>给它起个名字 *</label>
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

      {/* Base URL（QW#5：去技术黑话） */}
      <div>
        <label style={labelStyle}>服务地址（一般不用改）</label>
        <input
          style={inputStyle}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={PROVIDER_DEFAULT_URLS[provider] ? `留空使用 ${PROVIDER_DEFAULT_URLS[provider]}` : '自定义提供商请填写服务地址'}
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

      {/* 模型点选列表（对齐 proma ChannelModel 勾选列表：每项 enabled 开关 + 搜索过滤 + 全选/清空） */}
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <label style={{ ...labelStyle, marginBottom: 0 }}>可用模型（勾选启用）</label>
          <span
            data-ai-id="channel-model-count"
            style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}
          >
            已启用 {enabledCount} / 共 {modelList.length}
          </span>
        </div>

        {modelList.length > 0 && (
          <>
            {/* 搜索过滤：阿里云等渠道 200+ 模型，不可过滤即不可用 */}
            <input
              style={{ ...inputStyle, height: 32, marginTop: 6, marginBottom: 6 }}
              data-ai-id="channel-model-filter"
              value={modelFilter}
              onChange={(e) => setModelFilter(e.target.value)}
              placeholder="搜索模型名…"
              aria-label="搜索模型"
            />
            <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 6 }}>
              <button
                type="button"
                data-ai-id="channel-model-select-all"
                onClick={() => applyEnabledToFiltered(true)}
                disabled={filteredModels.length === 0}
                style={miniBtnStyle(filteredModels.length === 0)}
              >
                全选{keyword ? `（${filteredModels.length}）` : ''}
              </button>
              <button
                type="button"
                data-ai-id="channel-model-clear"
                onClick={() => applyEnabledToFiltered(false)}
                disabled={filteredModels.length === 0}
                style={miniBtnStyle(filteredModels.length === 0)}
              >
                清空
              </button>
            </div>
            <div
              data-ai-id="channel-model-list"
              style={{
                maxHeight: 200,
                overflowY: 'auto',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--white)',
                padding: 'var(--space-1) 0',
              }}
            >
              {filteredModels.length === 0 && (
                <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', padding: 'var(--space-2) var(--space-3)', margin: 0 }}>
                  没有匹配的模型，换个关键词
                </p>
              )}
              {filteredModels.map((m) => (
                <div
                  key={m.id}
                  data-ai-id={`channel-model-row-${m.name}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                    padding: '4px var(--space-3)',
                    opacity: m.enabled ? 1 : 0.55,
                  }}
                >
                  <input
                    type="checkbox"
                    data-ai-id={`channel-model-${m.name}`}
                    checked={m.enabled}
                    onChange={() => handleToggleModel(m.id)}
                    aria-label={`启用模型 ${m.name}`}
                    style={{ width: 14, height: 14, accentColor: 'var(--color-quick)', cursor: 'pointer', flexShrink: 0 }}
                  />
                  <span style={{ flex: 1, fontSize: 'var(--font-size-sm)', color: 'var(--color-text)', wordBreak: 'break-all' }}>
                    {m.name}
                  </span>
                  <button
                    type="button"
                    data-ai-id={`channel-model-remove-${m.name}`}
                    onClick={() => handleRemoveModel(m.id)}
                    disabled={saving}
                    style={{ ...miniBtnStyle(false), color: 'var(--color-text-muted)' }}
                  >
                    移除
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {/* 手动添加：保留自由输入（支持逗号批量），兼容拉不到模型的渠道 */}
        <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: modelList.length > 0 ? 6 : 8 }}>
          <input
            style={{ ...inputStyle, flex: 1 }}
            data-ai-id="channel-model-add-input"
            value={newModelName}
            onChange={(e) => setNewModelName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleAddModel()
              }
            }}
            placeholder="手动添加模型，逗号可一次填多个"
            aria-label="手动添加模型"
          />
          <button
            type="button"
            data-ai-id="channel-model-add"
            onClick={handleAddModel}
            disabled={newModelName.trim().length === 0}
            style={miniBtnStyle(newModelName.trim().length === 0)}
          >
            添加
          </button>
        </div>
        {modelList.length === 0 && (
          <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 4 }}>
            还没有模型：点上方「拉取模型」自动填入，或在这里手动添加
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
            // F1 修复（r73）：拉取失败也红——fetchMsg 结构化补 ok 标志，色逻辑合并两源
            color: ((testMsg && !testMsg.ok) || (fetchMsg && !fetchMsg.ok)) ? '#991B1B' : '#065F46',
            background: ((testMsg && !testMsg.ok) || (fetchMsg && !fetchMsg.ok)) ? '#FEF2F2' : '#ECFDF5',
            border: `1px solid ${((testMsg && !testMsg.ok) || (fetchMsg && !fetchMsg.ok)) ? '#FECACA' : '#A7F3D0'}`,
          }}
        >
          {((testMsg && !testMsg.ok) || (fetchMsg && !fetchMsg.ok)) ? <IconAlertTriangle size={16} /> : <IconCheck size={16} />}
          <span>{testMsg?.message ?? fetchMsg?.message}</span>
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
// M5 子组件：三角色渠道配置（角色 → 底层类别路由）
// =========================================================================

interface RoleRoutingDraftRow {
  channelId?: string
  fallbackIds: string[]
  /** 裁判角色专属（2026-09 内审闭环）：内审（audit）渠道；undefined = 随主渠道 */
  auditChannelId?: string
}

type RoleRoutingDraft = Partial<Record<AgentRoutingRole, RoleRoutingDraftRow>>

/** 渠道列表模型摘要文案（与表单内「已启用 x / 共 y」同口径）：
 *  Agent 实际只会用 enabled 模型（main getEnabledModels），旧文案把禁用项一并列出且不分口径，
 *  在点选列表上线后会让用户误读「四个模型都可用」。 */
function modelsSummary(channel: Channel | undefined): string {
  const models = modelsOf(channel)
  if (models.length === 0) return '未配置模型'
  const enabled = models.filter((m) => m.enabled)
  if (enabled.length === 0) return `未启用任何模型（共 ${models.length} 个，可在「编辑渠道」里勾选）`
  const head = enabled.slice(0, 3).map((m) => m.name).join('、')
  return `已启用 ${enabled.length}/${models.length}：${head}${enabled.length > 3 ? ' 等' : ''}`
}

function routingSelectableChannels(channels: Channel[]): Channel[] {
  return channels.filter((channel) => isAgentProtocolProvider(channel.provider_type))
}

/**
 * 渠道模型列表取位防御：channels.json 允许用户手改/旧版本字段缺失（类型上必填但运行时不可信），
 * 与 main/channel-manager.ts:150 getEnabledModels 的 `(channel.models ?? [])` 口径保持一致。
 */
function modelsOf(channel: Channel | undefined): ChannelModel[] {
  return channel?.models ?? []
}

function previewModelName(channel: Channel | undefined): string | undefined {
  return modelsOf(channel).find((model) => model.enabled)?.name
}

const ROLE_ORDER: AgentRoutingRole[] = ['guide', 'programming', 'judge']

const RoleRoutingSection: React.FC<{
  channels: Channel[]
  views: CategoryRoutingRoleView[] | null
  onViewsSaved: (views: CategoryRoutingRoleView[]) => void
}> = ({ channels, views, onViewsSaved }) => {
  const [draft, setDraft] = useState<RoleRoutingDraft>({})
  const [draftReady, setDraftReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [expandedRole, setExpandedRole] = useState<AgentRoutingRole | null>(null)
  const selectable = routingSelectableChannels(channels)

  useEffect(() => {
    if (!views) return
    const next: RoleRoutingDraft = {}
    for (const view of views) {
      next[view.role] = {
        channelId: view.channel_id,
        fallbackIds: [...(view.fallback_channel_ids ?? [])],
        auditChannelId: view.audit?.channel_id,
      }
    }
    setDraft(next)
    setDraftReady(true)
  }, [views])

  const patchRow = useCallback((role: AgentRoutingRole, patch: Partial<RoleRoutingDraftRow>) => {
    setDraft((previous) => ({
      ...previous,
      [role]: { channelId: previous[role]?.channelId, fallbackIds: previous[role]?.fallbackIds ?? [], ...patch },
    }))
  }, [])

  // Electron 的关闭态原生 select 不吞滚轮：此处把悬停滚动定义为角色渠道循环切换。
  const cycleChannelRef = useRef<(role: AgentRoutingRole, step: number) => void>(() => {})
  cycleChannelRef.current = (role, step) => {
    const order = ['', ...selectable.map((channel) => channel.id)]
    let index = order.indexOf(draft[role]?.channelId ?? '')
    if (index < 0) index = 0
    patchRow(role, { channelId: order[(index + step + order.length) % order.length] || undefined })
  }
  const wheelAccRef = useRef(0)
  useEffect(() => {
    const cycleOnWheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null
      if (!target || target.tagName !== 'SELECT') return
      const aiId = target.getAttribute('data-ai-id') ?? ''
      // 内审（audit）子下拉不参与主渠道滚轮循环切换（角色 key 不是合法 AgentRoutingRole）
      if (!aiId.startsWith('role-routing-select-') || aiId.includes('-audit') || (target as HTMLSelectElement).disabled) return
      event.preventDefault()
      wheelAccRef.current += event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 33 : event.deltaY
      const step = Math.trunc(wheelAccRef.current / 100)
      if (step === 0) return
      wheelAccRef.current -= step * 100
      cycleChannelRef.current(aiId.replace('role-routing-select-', '') as AgentRoutingRole, step)
    }
    document.addEventListener('wheel', cycleOnWheel, { passive: false })
    return () => document.removeEventListener('wheel', cycleOnWheel)
  }, [])

  const saveRouting = useCallback((routing: CategoryRoutingRoleUpdateEnvelope['routing']) => {
    const api = window.electronAPI
    if (!api?.channels?.categoryRoutingRoleUpdate) return
    setSaving(true)
    void api.channels.categoryRoutingRoleUpdate({ request_id: crypto.randomUUID(), routing })
      .then((result) => { if (result.ok) onViewsSaved(result.data.views) })
      .finally(() => setSaving(false))
  }, [onViewsSaved])

  const handleSave = useCallback(() => {
    if (!views) return
    const routing: CategoryRoutingRoleUpdateEnvelope['routing'] = {}
    for (const role of ROLE_ORDER) {
      const row = draft[role]
      if (!row || (!row.channelId && row.fallbackIds.length === 0 && row.auditChannelId === undefined)) continue
      routing[role] = {
        ...(row.channelId ? { channel_id: row.channelId } : {}),
        ...(row.fallbackIds.length ? { fallback_channel_ids: [...row.fallbackIds] } : {}),
        // 内审渠道仅裁判角色有效；undefined 不携带（main 侧缺省随主渠道展开）
        ...(role === 'judge' && row.auditChannelId !== undefined ? { audit_channel_id: row.auditChannelId || undefined } : {}),
      }
    }
    saveRouting(routing)
  }, [draft, saveRouting, views])

  const handleResetAll = useCallback(() => saveRouting({}), [saveRouting])

  const moveFallback = useCallback((role: AgentRoutingRole, index: number, delta: -1 | 1) => {
    setDraft((previous) => {
      const row = previous[role]
      if (!row) return previous
      const fallbackIds = [...row.fallbackIds]
      const target = index + delta
      if (target < 0 || target >= fallbackIds.length) return previous
      ;[fallbackIds[index], fallbackIds[target]] = [fallbackIds[target]!, fallbackIds[index]!]
      return { ...previous, [role]: { ...row, fallbackIds } }
    })
  }, [])

  const toggleFallback = useCallback((role: AgentRoutingRole, channelId: string) => {
    setDraft((previous) => {
      const row = previous[role]
      if (!row) return previous
      const fallbackIds = row.fallbackIds.includes(channelId)
        ? row.fallbackIds.filter((id) => id !== channelId)
        : [...row.fallbackIds, channelId]
      return { ...previous, [role]: { ...row, fallbackIds } }
    })
  }, [])

  const dirty = views?.some((view) => {
    const row = draft[view.role]
    if (!row) return false
    if (view.effective === 'mixed') return row.channelId !== undefined || row.fallbackIds.length > 0
    if (row.channelId !== view.channel_id || JSON.stringify(row.fallbackIds) !== JSON.stringify(view.fallback_channel_ids ?? [])) return true
    // 裁判角色：内审渠道独立比较（undefined = 随主渠道）
    if (view.role === 'judge' && row.auditChannelId !== view.audit?.channel_id) return true
    return false
  }) ?? false

  const selectStyle: React.CSSProperties = {
    height: 32,
    padding: '0 var(--space-2)',
    fontSize: 'var(--font-size-xs)',
    color: 'var(--color-text)',
    background: 'var(--white)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    outline: 'none',
    fontFamily: 'inherit',
  }
  const smallButtonStyle = (tone: 'default' | 'danger'): React.CSSProperties => ({
    height: 26,
    padding: '0 var(--space-2)',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 500,
    color: tone === 'danger' ? 'var(--color-danger)' : 'var(--color-text-muted)',
    background: 'transparent',
    border: `1px solid ${tone === 'danger' ? 'var(--color-danger-soft)' : 'var(--color-border)'}`,
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    fontFamily: 'inherit',
  })

  if (!views && !draftReady) return null

  return (
    <section aria-label="角色配置" data-ai-id="role-routing-section" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
        <div>
          <h3 style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-text)', margin: 0 }}>角色配置</h3>
          <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', margin: '4px 0 0' }}>
            为向导、编程、裁判三个 Agent 分配模型渠道；一个角色的选择会应用到其全部工作环节
          </p>
        </div>
        <button type="button" onClick={handleResetAll} disabled={saving} data-ai-id="role-routing-reset-all" style={smallButtonStyle('danger')}>恢复全部默认</button>
      </div>

      {views?.map((view) => {
        const row = draft[view.role]
        if (!row) return null
        const selected = row.channelId ? channels.find((channel) => channel.id === row.channelId) : undefined
        const dangling = view.effective === 'dangling' && row.channelId === view.channel_id
        const mixed = view.effective === 'mixed'
        const preview = selected ? previewModelName(selected) : view.model_name
        const expanded = expandedRole === view.role
        return (
          <div key={view.role} data-ai-id={`role-routing-row-${view.role}`} style={{
            padding: 'var(--space-3) var(--space-4)',
            background: dangling || mixed ? '#FFFBEB' : 'var(--white)',
            border: `1px solid ${dangling || mixed ? '#FDE68A' : 'var(--color-border)'}`,
            borderRadius: 'var(--radius-md)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-text)' }}>{view.label}</span>
                <span style={{ display: 'block', marginTop: 2, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>{view.description}</span>
                {preview && <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>生效模型：{preview}</span>}
              </div>
              <select
                aria-label={`${view.label} 渠道`}
                data-ai-id={`role-routing-select-${view.role}`}
                style={selectStyle}
                value={row.channelId ?? ''}
                disabled={saving}
                onChange={(event) => patchRow(view.role, { channelId: event.target.value || undefined })}
              >
                <option value="">{mixed ? '多个渠道（选择一个渠道统一）' : `自动 / 全局默认${view.channel_name && view.effective === 'auto' ? `（${view.channel_name}）` : ''}`}</option>
                {selectable.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}（{PROVIDER_LABELS[channel.provider_type] ?? channel.provider_type}）</option>)}
              </select>
              {view.role === 'judge' && view.audit && (
                <select
                  aria-label="内审渠道（攻击 / 修订 / 复核）"
                  data-ai-id="role-routing-select-judge-audit"
                  style={selectStyle}
                  value={row.auditChannelId ?? ''}
                  disabled={saving}
                  onChange={(event) => patchRow(view.role, { auditChannelId: event.target.value || undefined })}
                >
                  <option value="">内审随主渠道{view.audit.effective === 'auto' && view.audit.channel_name ? `（${view.audit.channel_name}）` : ''}</option>
                  {selectable.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}（{PROVIDER_LABELS[channel.provider_type] ?? channel.provider_type}）</option>)}
                </select>
              )}
              <button type="button" onClick={() => setExpandedRole(expanded ? null : view.role)} style={smallButtonStyle('default')} aria-expanded={expanded} disabled={saving}>
                备用顺序{row.fallbackIds.length > 0 ? `（${row.fallbackIds.length}）` : ''}
              </button>
            </div>

            {mixed && (
              <div role="alert" data-ai-id={`role-routing-mixed-${view.role}`} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--font-size-xs)', color: '#92400E' }}>
                <IconAlertTriangle size={14} />
                <span>该角色沿用了旧的分项配置，当前包含多个渠道。选择一个渠道并保存即可统一。</span>
                <button type="button" onClick={() => patchRow(view.role, { channelId: undefined, fallbackIds: [] })} style={smallButtonStyle('default')}>统一为自动</button>
              </div>
            )}
            {dangling && (
              <div role="alert" data-ai-id={`role-routing-dangling-${view.role}`} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--font-size-xs)', color: '#92400E' }}>
                <IconAlertTriangle size={14} />
                <span>指向的渠道已被删除，当前回退全局默认</span>
                <button type="button" onClick={() => patchRow(view.role, { channelId: undefined })} style={smallButtonStyle('default')}>恢复自动</button>
              </div>
            )}

            {expanded && (
              <div data-ai-id={`role-routing-fallback-${view.role}`} style={{ padding: 'var(--space-3)', background: 'var(--glass-bg-soft)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', margin: 0 }}>该角色渠道故障时依次尝试的备用顺序（勾选加入，↑↓ 调整顺序）。</p>
                {selectable.map((channel) => {
                  const index = row.fallbackIds.indexOf(channel.id)
                  const checked = index >= 0
                  return (
                    <div key={channel.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--font-size-xs)', flex: 1, cursor: 'pointer' }}>
                        <input type="checkbox" checked={checked} disabled={saving} onChange={() => toggleFallback(view.role, channel.id)} />
                        {channel.name}
                      </label>
                      {checked && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>#{index + 1}</span>
                          <button type="button" aria-label="上移" disabled={index === 0 || saving} onClick={() => moveFallback(view.role, index, -1)} style={smallButtonStyle('default')}>↑</button>
                          <button type="button" aria-label="下移" disabled={index === row.fallbackIds.length - 1 || saving} onClick={() => moveFallback(view.role, index, 1)} style={smallButtonStyle('default')}>↓</button>
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}

      {views && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" onClick={handleSave} disabled={!dirty || saving} data-ai-id="role-routing-save" style={{
            height: 32,
            padding: '0 var(--space-4)',
            fontSize: 'var(--font-size-xs)',
            fontWeight: 600,
            color: dirty && !saving ? 'var(--white)' : 'var(--color-text-muted)',
            background: dirty && !saving ? 'linear-gradient(135deg, var(--color-quick), var(--color-quick-bright))' : 'var(--gray-200)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            cursor: dirty && !saving ? 'pointer' : 'not-allowed',
            fontFamily: 'inherit',
          }}>{saving ? '保存中…' : '保存角色配置'}</button>
        </div>
      )}
    </section>
  )
}

// =========================================================================
// 主组件
// =========================================================================

// =========================================================================
// 权限模式三档选项（与 shared/types 的 PromaPermissionMode 对齐）
// =========================================================================

const PERMISSION_MODE_OPTIONS: { value: PromaPermissionMode; label: string; desc: string }[] = [
  { value: 'safe', label: '安全', desc: '危险操作直接拒绝' },
  { value: 'ask', label: '每次询问', desc: '执行前弹窗确认（默认）' },
  { value: 'allow-all', label: '全部放行', desc: '仅开发 / 演示用' },
]

export const ChannelSettingsPage: React.FC = () => {
  const [channels, setChannels] = useAtom(channelsListAtom)
  const [loading, setLoading] = useAtom(channelsLoadingAtom)
  const [testResult, setTestResult] = useAtom(channelTestResultAtom)
  const [showForm, setShowForm] = useState(false)
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null)
  const [saving, setSaving] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [permissionMode, setPermissionModeAtom] = useAtom(permissionModeAtom)
  const [routingRoleViews, setRoutingRoleViews] = useAtom(categoryRoutingRoleViewsAtom)

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
    // QW#1：复用启动加载（幂等——App 挂载已加载，这里仅确保 settings 页打开时数据新鲜）
    void refreshChannelsList(setChannels, setLoading)
  }, [setChannels, setLoading])

  // ==================== M5：加载三角色渠道配置视图 ====================

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.channels?.categoryRoutingRoleList) return
    void api.channels
      .categoryRoutingRoleList({ request_id: crypto.randomUUID() })
      .then((result) => {
        if (result.ok) setRoutingRoleViews(result.data.views)
      })
      .catch(() => {
        // 角色配置区不可用不阻塞普通渠道管理
      })
  }, [setRoutingRoleViews])

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
      {/* ── 小节标题 ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          marginBottom: 'var(--space-6)',
        }}
      >
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

        {/* ── M5 三角色渠道配置（向导 / 编程 / 裁判）── */}
        <RoleRoutingSection channels={channels} views={routingRoleViews} onViewsSaved={(views) => setRoutingRoleViews(views)} />

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
                    {(() => {
                      // 刀5（2026-10-02）：渠道状态三态点——测试中（黄）/最近测试通过（绿）/
                      // 最近测试失败（红）/启用未测（绿描边）/禁用（灰）；复用现有 15s 探活
                      // 收口（channelTestResultAtom），不另造探测。title 提示当前态与操作出口。
                      const testing = testingId === channel.id
                      const tested = testResult?.channelId === channel.id ? testResult : undefined
                      const dotColor = testing
                        ? 'var(--color-warning)'
                        : tested && !tested.ok
                          ? 'var(--color-danger)'
                          : channel.enabled
                            ? 'var(--color-success)'
                            : 'var(--gray-400)'
                      const dotTitle = testing
                        ? '测试中（最多 15 秒）…'
                        : tested && !tested.ok
                          ? `最近测试失败：${tested.message}——点右侧「测试」重试，或编辑渠道更新配置`
                          : channel.enabled
                            ? tested?.ok
                              ? `最近测试通过（${tested.message}）`
                              : '已启用（本页未测试）——点「测试」探活'
                            : '已禁用'
                      return (
                        <span
                          data-ai-id={`channel-status-dot-${channel.id}`}
                          title={dotTitle}
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: dotColor,
                            display: 'inline-block',
                            flexShrink: 0,
                          }}
                        />
                      )
                    })()}
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
                    {modelsSummary(channel)}
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
              // 切换编辑目标必须重挂载：useState(initial) 只在挂载时取值，无 key 时 React 复用实例
              // 导致名称/URL/模型列表残留上一渠道，且拉取结果会 merge 进旧列表随保存写坏新渠道（目检缺陷 #1）
              key={editingChannel?.id ?? 'create'}
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
