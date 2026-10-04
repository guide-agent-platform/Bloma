import React from 'react'
import { useAtomValue } from 'jotai'
import { RotateCw } from './icons'
import { Markdown } from './Markdown'
import { currentProjectAtom } from '../agent-atoms'

/**
 * DeliveryPanel — 桌面项目交付面板（2026-10-04 呈现层收口）。
 *
 * 替代 web 线遗产的空预览沙箱（桌面项目没有 web 产物，旧面板永远空白）：
 * - 项目文件清单（≤200，跳过归档/依赖/构建目录）；
 * - DELIVERY.md 渲染（运行方式/依赖/已知限制）；
 * - 「启动程序」按钮：仅 completed 项目（安全门+启动冒烟已过）+ LAUNCH.json 合法时可点，
 *   detached 启动——产品进程独立于 Bloma 存活；
 * - 数据经 PROJECT_DELIVERABLES / PROJECT_LAUNCH_APP IPC（四层链路）。
 */
const MarkdownLazy: React.FC<{ text: string }> = Markdown

export const DeliveryPanel: React.FC = () => {
  const project = useAtomValue(currentProjectAtom)
  const projectId = project?.project_id
  const [data, setData] = React.useState<Awaited<ReturnType<typeof fetchDeliverables>> | undefined>()
  const [loading, setLoading] = React.useState(false)
  const [launchState, setLaunchState] = React.useState<string | null>(null)

  const fetchDeliverables = React.useCallback(async (id: string) => {
    const api = (window as unknown as { bloma?: { projectDeliverables?: { get: (input: { request_id?: string; project_id: string }) => Promise<{ ok: boolean; data?: unknown; error?: { message?: string } }> } } }).bloma
    const result = await api?.projectDeliverables?.get({ project_id: id })
    if (result?.ok && result.data) return result.data as { files: string[]; delivery_md?: string; launch: { declared: boolean; parse_ok: boolean; parse_error?: string; command?: string[] }; can_launch: boolean }
    return undefined
  }, [])

  const refresh = React.useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      setData(await fetchDeliverables(projectId))
    } finally {
      setLoading(false)
    }
  }, [projectId, fetchDeliverables])

  React.useEffect(() => {
    void refresh()
    setLaunchState(null)
  }, [refresh])

  const onLaunch = async (): Promise<void> => {
    if (!projectId) return
    setLaunchState('启动中…')
    const api = (window as unknown as { bloma?: { projectDeliverables?: { launch: (input: { request_id?: string; project_id: string }) => Promise<{ ok: boolean; data?: { started: boolean; pid?: number }; error?: { message?: string } }> } } }).bloma
    const result = await api?.projectDeliverables?.launch({ project_id: projectId })
    if (result?.ok && result.data?.started) {
      setLaunchState(`已启动（进程 ${result.data.pid ?? '?'}）`)
    } else {
      setLaunchState(`启动失败：${result?.error?.message ?? '未知错误'}`)
    }
  }

  return (
    <div
      data-ai-id="delivery-panel"
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--white)',
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--color-border)',
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--color-border)' }}>
        <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600 }}>交付面板</span>
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>桌面项目产物</span>
        <div style={{ flex: 1 }} />
        <button
          data-ai-id="delivery-refresh"
          onClick={() => void refresh()}
          style={{ background: 'none', border: '1px solid var(--color-border)', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontSize: 'var(--font-size-xs)' }}
        >
          刷新
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: '1px solid var(--color-border)' }}>
        <button
          data-ai-id="delivery-launch-button"
          onClick={() => void onLaunch()}
          disabled={!data?.can_launch}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: data?.can_launch ? 'var(--color-quick)' : 'var(--gray-200)',
            color: data?.can_launch ? 'var(--white)' : 'var(--gray-500)',
            border: 'none', borderRadius: 8, padding: '6px 14px',
            fontSize: 'var(--font-size-sm)', fontWeight: 600,
            cursor: data?.can_launch ? 'pointer' : 'not-allowed',
          }}
        >
          ▶ 启动程序
        </button>
        {data && !data.can_launch && (
          <span data-ai-id="delivery-launch-hint" style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>
            {data.launch.declared && !data.launch.parse_ok
              ? `LAUNCH.json 不合法：${data.launch.parse_error ?? ''}`
              : !data.launch.declared
                ? '项目根缺少 LAUNCH.json 启动声明'
                : '项目完成后可启动'}
          </span>
        )}
        {launchState && <span data-ai-id="delivery-launch-state" style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>{launchState}</span>}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px', minHeight: 0 }}>
        {loading && <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}><RotateCw size={12} /> 读取产物…</div>}
        {data && (
          <>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginBottom: 6 }}>
              ▤ 项目文件（{data.files.length}）
            </div>
            <div data-ai-id="delivery-file-list" style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 'var(--font-size-xs)', lineHeight: 1.7, color: 'var(--color-text)', marginBottom: 12 }}>
              {data.files.map((file) => (
                <div key={file} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{file}</div>
              ))}
            </div>
            {data.delivery_md && (
              <>
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginBottom: 6 }}>
                  ▤ 交付说明
                </div>
                <React.Suspense fallback={<div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>渲染中…</div>}>
                  <div data-ai-id="delivery-md" style={{ fontSize: 'var(--font-size-sm)' }}>
                    <MarkdownLazy text={data.delivery_md} />
                  </div>
                </React.Suspense>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
