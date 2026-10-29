import React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { RotateCw, LayoutTemplate, Play } from './icons'
import { Markdown } from './Markdown'
import { CorrectionPanel } from './CorrectionPanel'
import { ProgramScreenshot } from './ProgramScreenshot'
import { SketchViewport } from './SketchViewport'
import { SoftwareSuggestions } from './SoftwareSuggestions'
import { LongtermProjectPanel } from './LongtermProjectPanel'
import { longtermStatusLabel } from '../lib/project-status'
import { correctionSessionAtom, currentProjectAtom, desktopArtifactsAtom, desktopPhaseAtom, hasActiveStreamAtom, softwarePreviewsAtom, softwareTrialsAtom, softwareSuggestionsVersionAtom, longtermVersionAtom } from '../agent-atoms'
import type { ProjectDeliverablesResult } from '../../shared/types'

/**
 * DeliveryPanel — 桌面项目交付面板（2026-10-04 呈现层收口；同日审计修复 A-02/A-08）。
 *
 * 替代 web 线遗产的空预览沙箱（桌面项目没有 web 产物，旧面板永远空白）：
 * - 项目文件清单（≤200，跳过归档/依赖/构建目录）；
 * - DELIVERY.md 渲染（运行方式/依赖/已知限制）；
 * - 「启动程序」按钮：仅 completed 项目（安全门+启动冒烟已过）+ LAUNCH.json 合法时可点，
 *   detached 启动——产品进程独立于 Bloma 存活；
 * - 数据经 PROJECT_DELIVERABLES / PROJECT_LAUNCH_APP IPC（四层链路；A-02 修复：改经
 *   window.electronAPI——原 window.bloma 从未被 preload 暴露，面板整体死链）；
 * - A-08 修复：桌面阶段推进/产物变更信号自动重拉 + 空态文案，不再只依赖手动刷新。
 */
const MarkdownLazy: React.FC<{ text: string }> = Markdown

export const DeliveryPanel: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const project = useAtomValue(currentProjectAtom)
  const running = useAtomValue(hasActiveStreamAtom)
  const correctionSession = useAtomValue(correctionSessionAtom)
  const projectId = project?.project_id
  const liveUrl = useAtomValue(softwarePreviewsAtom)[projectId ?? '']
  const setTrials = useSetAtom(softwareTrialsAtom)
  const suggestionsVersion=useAtomValue(softwareSuggestionsVersionAtom)
  const longtermVersion=useAtomValue(longtermVersionAtom)
  // 自动刷新信号：桌面阶段推进（stage_changed 回填后变化）或产物变更（version+1）
  const desktopPhase = useAtomValue(desktopPhaseAtom)
  const artifactsVersion = useAtomValue(desktopArtifactsAtom).version
  const [data, setData] = React.useState<ProjectDeliverablesResult | undefined>()
  const [loading, setLoading] = React.useState(false)
  const [launchState, setLaunchState] = React.useState<string | null>(null)
  const [needsRestart, setNeedsRestart] = React.useState(false)
  const [restartPrevious, setRestartPrevious] = React.useState(false)
  const [showCorrection, setShowCorrection] = React.useState(false)
  const [restoreId, setRestoreId] = React.useState('')
  const [confirmRestore, setConfirmRestore] = React.useState(false)
  const [restorePrevious, setRestorePrevious] = React.useState(false)
  const currentProjectId = React.useRef(projectId)
  const refreshSequence = React.useRef(0)
  currentProjectId.current = projectId
  React.useEffect(() => { refreshSequence.current++; setData(undefined); setLaunchState(null); setNeedsRestart(false); setRestartPrevious(false); setRestoreId(''); setConfirmRestore(false); setRestorePrevious(false) }, [projectId])

  const refresh = React.useCallback(async () => {
    if (!projectId) return
    const api = window.electronAPI?.projectDeliverables
    if (!api) return
    const sequence = ++refreshSequence.current
    setLoading(true)
    try {
      const result = await api.get({ request_id: crypto.randomUUID(), project_id: projectId })
      if (currentProjectId.current === projectId && sequence === refreshSequence.current) {
        setData(result.ok ? result.data : undefined)
        if (result.ok) setTrials(previous => { const next = { ...previous }; if (result.data.trial&&['running','exited'].includes(result.data.trial.state)) next[projectId] = result.data.trial; else delete next[projectId]; return next })
      }
    } catch {
      if (currentProjectId.current === projectId && sequence === refreshSequence.current) setData(undefined)
    } finally {
      if (currentProjectId.current === projectId && sequence === refreshSequence.current) setLoading(false)
    }
  }, [projectId])

  React.useEffect(() => {
    void refresh()
    setLaunchState(null)
    // 依赖含 desktopPhase/artifactsVersion：阶段推进与产物变更信号触发重拉（A-08）
  }, [refresh, desktopPhase, artifactsVersion, project?.current_stage, suggestionsVersion,longtermVersion,running])

  const onLaunch = async (restart = false, snapshot?: string, previous = false, trial = false): Promise<void> => {
    if (!projectId) return
    setLaunchState('启动中…')
    const api = window.electronAPI?.projectDeliverables
    if (!api) {
      setLaunchState('启动失败：当前环境不支持启动通道')
      return
    }
    let result
    try { result = await api.launch({ request_id: crypto.randomUUID(), project_id: projectId, ...(restart ? { restart: true } : {}), ...(snapshot ? { restore_snapshot: snapshot, restore_data_confirmed: true } : {}), ...(previous ? { previous_release: true } : {}), ...(trial ? { trial: true, trial_version: data?.trial?.release_id } : {}) }) }
    catch { if (currentProjectId.current === projectId) setLaunchState('启动失败：请重试，或告诉向导你遇到的问题'); return }
    if (currentProjectId.current !== projectId) return
    if (result.ok && result.data.trial&&['running','exited'].includes(result.data.trial.state)) {
      const current = result.data.trial
      setData(previous => previous ? { ...previous, trial: current } : previous)
      setTrials(previous => ({...previous, [projectId]: current}))
    }
    setConfirmRestore(false); void refresh()
    if (result.ok && result.data.started) {
      setNeedsRestart(false)
      setLaunchState(result.data.detail ?? '已启动，可以开始使用。')
    } else {
      setNeedsRestart(result.ok && result.data.needs_restart === true)
      setRestartPrevious(previous)
      setLaunchState(result.ok && result.data.detail ? result.data.detail : `启动失败：${result.ok ? '进程未能存活' : result.error?.user_visible_message || result.error?.message || '未知错误'}`)
    }
  }
  const onCloseTrial = async () => {
    if (!projectId || !data?.trial) return
    const api = window.electronAPI?.projectDeliverables
    if (!api) return
    const result = await api.launch({request_id:crypto.randomUUID(),project_id:projectId,trial:true,stop_trial:true,trial_version:data.trial.release_id})
    if (currentProjectId.current !== projectId) return
    setLaunchState(result.ok ? result.data.detail ?? '试用已关闭' : result.error.message)
    void refresh()
  }

  return (
    <div
      data-ai-id="delivery-panel"
      className={embedded ? 'theatre-delivery-window' : undefined}
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--color-surface)',
        borderRadius: embedded ? 0 : 'var(--radius-lg)',
        border: embedded ? 'none' : '1px solid var(--color-border)',
        overflow: 'hidden',
      }}
    >
      <div className="theatre-program-bar" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--color-border)' }}>
        {embedded && <LayoutTemplate size={14} />}
        <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 500 }}>{project?.name ?? '你的软件'}</span>
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>{data?.status_view?.goal.label ?? (project && longtermStatusLabel(project) || (liveUrl ? '程序试用 · 测试数据 · 尚未交付' : project?.current_stage === 'completed' ? '可以使用' : project?.desktop_blocked && !running ? '制作暂时停止' : desktopPhase ? '正在制作' : '等待想法成形'))}</span>
        <div style={{ flex: 1 }} />
        <button
          data-ai-id="delivery-refresh"
          aria-label="刷新产物"
          onClick={() => void refresh()}
          style={{ background: 'none', border: '1px solid var(--color-border)', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontSize: 'var(--font-size-xs)' }}
        >
          <RotateCw size={13} />
        </button>
      </div>

      {data?.status_view && <div role="status" aria-label="执行与交付状态" style={{display:'flex',gap:12,flexWrap:'wrap',padding:'7px 14px',fontSize:'var(--font-size-xs)',color:'var(--color-text-muted)',borderBottom:'1px solid var(--line-2)'}}>
        <span title={data.status_view.execution.reason}>执行：{data.status_view.execution.label}</span>
        <span>检查：{data.status_view.verification.label}</span>
        {data.status_view.verification.scope_note&&<span>{data.status_view.verification.scope_note}</span>}
        <span>交付：{data.status_view.goal.label}</span>
        {data.status_view.active_commands>0&&<span>后台命令 {data.status_view.active_commands} 项</span>}
      </div>}

      {(!embedded || data?.can_launch || data?.launch.declared || project?.current_stage === 'completed') && <div className="theatre-launch-row" style={{ display: 'flex', flexWrap:'wrap', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: '1px solid var(--color-border)' }}>
        <button
          data-ai-id="delivery-launch-button"
          onClick={() => void onLaunch()}
          disabled={loading || !data?.can_launch}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: data?.can_launch ? 'var(--theatre-accent, var(--color-quick))' : 'var(--color-surface-muted)',
            color: data?.can_launch ? 'var(--theatre-on-accent, var(--white))' : 'var(--color-text-muted)',
            border: 'none', borderRadius: 8, padding: '6px 14px',
            fontSize: 'var(--font-size-sm)', fontWeight: 600,
            cursor: data?.can_launch ? 'pointer' : 'not-allowed',
          }}
        >
          <Play />启动程序
        </button>
        {!loading && data && !data.can_launch && (
          <span data-ai-id="delivery-launch-hint" style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>
            {project?.current_stage !== 'completed' ? '项目完成后可启动' : data.launch.declared && !data.launch.parse_ok
              ? `LAUNCH.json 不合法：${data.launch.parse_error ?? ''}`
              : !data.launch.declared
                ? '项目根缺少 LAUNCH.json 启动声明'
                : '项目完成后可启动'}
          </span>
        )}
        {launchState && <span data-ai-id="delivery-launch-state" style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>{launchState}</span>}
        {data?.delivery_qualification && <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>{data.delivery_qualification.detail}</span>}
        {needsRestart && <button type="button" disabled={running || !data?.can_launch} onClick={() => void onLaunch(true, undefined, restartPrevious)}>已保存，关闭旧版本并启动更新</button>}
        {data?.can_use_previous_release && <button type="button" disabled={running || !data.can_launch} onClick={() => void onLaunch(false, undefined, true)}>启动上一可用版本</button>}
        {Boolean(data?.data_snapshots?.length) && <>
          <select aria-label="选择数据备份" value={restoreId} onChange={event => { setRestoreId(event.target.value); setConfirmRestore(false) }}>
            <option value="">数据备份…</option>
            {data?.data_snapshots?.map(snapshot => <option key={snapshot.id} value={snapshot.id}>{new Date(snapshot.at).toLocaleString()}</option>)}
          </select>
          <button type="button" disabled={!restoreId || running || !data?.can_launch} onClick={() => setConfirmRestore(true)}>恢复备份…</button>
          {confirmRestore && <div role="alert">请先保存并关闭程序。将恢复所选时点的数据，当前数据会另外备份。
            {data?.can_use_previous_release && <label><input type="checkbox" checked={restorePrevious} onChange={event => setRestorePrevious(event.target.checked)} />同时使用上一可用的软件版本</label>}
            <button type="button" disabled={running} onClick={() => void onLaunch(true, restoreId, Boolean(data?.can_use_previous_release && restorePrevious))}>已保存，恢复所选数据</button>
            <button type="button" onClick={() => setConfirmRestore(false)}>取消</button>
          </div>}
        </>}
      </div>}

      {(data?.can_trial || data?.trial) && <div className="theatre-launch-row software-trial-controls" style={{padding: '8px 14px', display:'flex', gap:8, flexWrap:'wrap'}}>
        <button type="button" data-ai-id="software-trial-launch" disabled={loading || !data?.can_trial} onClick={() => void onLaunch(false, undefined, false, true)}>打开独立试用</button>
        {data.trial?.state === 'running' && <button type="button" data-ai-id="software-trial-update" disabled={loading} onClick={() => void onLaunch(true, undefined, false, true)}>已保存，切换到当前代码试用</button>}
        {data.trial?.state === 'running' && <button type="button" disabled={loading} onClick={() => void onCloseTrial()}>关闭试用</button>}
        <span>测试数据 · {data.trial?.qualification==='host_verified_test_data'?'已有宿主检查，待阶段确认':'尚未验收'}{data.trial?.state==='running'?' · 自动验收期间可继续使用':''}{data.trial ? ` · 版本 ${data.trial.release_id.slice(0,12)}` : ''}</span>
      </div>}
      {data?.trial?.state==='exited'&&data.trial.last_output!==undefined&&<pre className="software-command-trial" aria-label="命令试用输出">{data.trial.last_output||'命令运行完成，无输出。'}</pre>}
      {embedded && data?.trial?.state === 'running' && data.trial.url && <iframe key={data.trial.release_id} title="独立程序试用（测试数据，尚未验收）" src={data.trial.url} sandbox="allow-scripts allow-forms allow-same-origin allow-downloads" style={{ flex: 1, width: '100%', minHeight: 360, border: 0 }} />}
      {embedded && data?.trial?.state !== 'running' && liveUrl && <><span>开发调试画面 · 可能随调试关闭</span><iframe title="开发调试画面" src={liveUrl} sandbox="allow-scripts allow-forms allow-same-origin allow-downloads" style={{ flex: 1, width: '100%', minHeight: 360, border: 0 }} /></>}
      {embedded && !liveUrl && data?.trial?.state !== 'running' && project?.current_stage !== 'completed' && data?.confirmed_sketch_url && <div className="delivery-confirmed-sketch"><SketchViewport src={data.confirmed_sketch_url} readOnly /></div>}
      <div className="theatre-delivery-body" data-has-sketch={Boolean(embedded && project?.current_stage !== 'completed' && data?.confirmed_sketch_url)} style={{ flex: data?.trial?.state === 'running' ? '0 0 auto' : 1, overflowY: 'auto', padding: '10px 14px', minHeight: 0 }}>
        {project?.mode==='longterm'&&project.workflow_version==='software-v1'&&projectId&&<LongtermProjectPanel key={projectId} projectId={projectId} state={data?.longterm} error={data?.longterm_error} archived={project.status==='archived'||project.status==='abandoned'} refresh={()=>void refresh()} />}
        <SoftwareSuggestions key={projectId} value={data?.improvement_suggestions} refresh={()=>void refresh()} />
        {data?.trial?.state !== 'running' && <ProgramScreenshot />}
        {!loading && !liveUrl && !project?.longterm_summary && data?.trial?.state !== 'running' && (data || embedded) && <div className="theatre-delivery-hero"><span className="theatre-idea-emblem"><LayoutTemplate size={25} /></span><h3>{project?.current_stage === 'completed' ? '这是你的软件了。' : project?.desktop_blocked ? '已有的工作，都保留了。' : desktopPhase ? '正在接通完整功能。' : '这里，会是你的软件。'}</h3><p>{project?.current_stage === 'completed' ? '启动后在独立窗口使用，随时可以继续改进。' : desktopPhase ? '从确认过的界面，继续成为真实程序。' : '先说你想解决什么，我们一起把它做出来。'}</p></div>}
        {/* 点选纠错（批11 MVP-E，2026-10-08）：入口/会话视图内嵌交付面板；completed 项目
            可用（主进程校验，旧骨架产物返回 unsupported 如实置灰提示） */}
        {project?.current_stage === 'completed' && (
          <div style={{ marginBottom: 8 }}>
            {data?.supports_point_selection === false ? <p>想继续改进，直接在聊天中描述位置和期望效果即可。</p> : <>
              {embedded && <button type="button" className="theatre-tool" aria-expanded={showCorrection} onClick={() => setShowCorrection(previous => !previous)}>反馈改进与点选修改</button>}
              {(!embedded || showCorrection) && <CorrectionPanel />}
            </>}
          </div>
        )}
        {loading && <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}><RotateCw size={12} /> 读取产物…</div>}
        {!loading && !data && !embedded && (
          <div data-ai-id="delivery-empty" style={{ padding: 'var(--space-6) var(--space-2)', textAlign: 'center' }}>
            <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text)', fontWeight: 600, margin: '0 0 4px' }}>项目还没有可展示的交付内容</p>
            <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', margin: 0, lineHeight: 1.6 }}>
              制作完成后，可以在这里启动程序、查看文件与使用说明。
            </p>
          </div>
        )}
        {data && (
          <>
            {data.files.length > 0 && <details className="theatre-delivery-details"><summary>程序文件 · {data.files.length}</summary><div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginBottom: 6 }}>
              ▤ 项目文件（{data.files.length}）
            </div>
            <div data-ai-id="delivery-file-list" style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 'var(--font-size-xs)', lineHeight: 1.7, color: 'var(--color-text)', marginBottom: 12 }}>
              {data.files.map((file) => (
                <div key={file} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{file}</div>
              ))}
            </div>
            </details>}
            {data.delivery_md && (
              <details className="theatre-delivery-details"><summary>使用与交付说明</summary>
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginBottom: 6 }}>
                  使用与交付说明
                </div>
                <React.Suspense fallback={<div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>渲染中…</div>}>
                  <div data-ai-id="delivery-md" style={{ fontSize: 'var(--font-size-sm)' }}>
                    <MarkdownLazy text={data.delivery_md} />
                  </div>
                </React.Suspense>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  )
}
