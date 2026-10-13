import React from 'react'
import { useAtomValue } from 'jotai'
import { IconSettings, ChevronDown } from './icons'
import { StudioBrand, StudioNavigation } from './StudioPageFrame'
import { canUpgradeAtom, currentProjectAtom, networkOnlineAtom, projectModeAtom } from './atoms'
import { hasUsableChannelsAtom } from './atoms-sprint2'

export interface WorkspaceHeaderProps {
  showConnection?: boolean
  onAllProjects?: () => void
  onOpenSettings?: () => void
  onUpgrade?: () => void
  onHome?: () => void
}

export const WorkspaceHeader: React.FC<WorkspaceHeaderProps> = ({ onAllProjects, onOpenSettings, onUpgrade, onHome, showConnection = true }) => {
  const project = useAtomValue(currentProjectAtom)
  const mode = useAtomValue(projectModeAtom)
  const isOnline = useAtomValue(networkOnlineAtom)
  const hasChannels = useAtomValue(hasUsableChannelsAtom)
  const canUpgrade = useAtomValue(canUpgradeAtom)
  return <header data-ai-id="workspace-header" className="theatre-header">
    <StudioBrand />
    <StudioNavigation active="workspace" onHome={onHome} onProjects={onAllProjects} />
    <button type="button" className="theatre-project" data-ai-id="all-projects-button" aria-label="所有项目" onClick={onAllProjects} disabled={!onAllProjects} title="查看所有项目"><h1>{project?.name ?? '未命名项目'}</h1><ChevronDown /></button>
    <span className="theatre-header-spacer" />
    <span className="theatre-mode"><span>{mode === 'longterm' ? '长期型' : '快速型'}</span></span>
    {showConnection && hasChannels !== null && <span className="theatre-connection" data-state={hasChannels === false ? 'missing' : isOnline ? 'ready' : 'offline'}>{hasChannels === false ? '未配置 AI' : isOnline ? 'AI 就绪' : '离线'}</span>}
    {canUpgrade && <button type="button" data-ai-id="upgrade-to-longterm-button" className="theatre-tool" onClick={onUpgrade}>升级为长期模式</button>}
    {onOpenSettings && <button type="button" data-ai-id="settings-button" className="theatre-tool" aria-label="设置（模型渠道）" title="设置与模型渠道" onClick={onOpenSettings}><IconSettings size={16} /></button>}
  </header>
}

export const WorkspaceConnection: React.FC = () => {
  const online = useAtomValue(networkOnlineAtom)
  const channels = useAtomValue(hasUsableChannelsAtom)
  return channels === null ? null : <span className="theatre-connection" data-state={channels === false ? 'missing' : online ? 'ready' : 'offline'}><span className="theatre-status-dot" aria-hidden />{channels === false ? '未配置 AI' : online ? 'AI 就绪' : '离线'}</span>
}
