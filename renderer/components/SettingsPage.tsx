import React, { useState } from 'react'
import { ChannelSettingsPage } from './ChannelSettingsPage'
import { PromptSettingsPage } from './PromptSettingsPage'
import { NotificationSoundSettingsPage } from './NotificationSoundSettingsPage'
import { ArrowLeft, IconSettings, FileText, Conversation, IconMic } from './icons'
import { StudioPageFrame, type StudioNavigationProps } from './StudioPageFrame'

type SettingsTab = 'channels' | 'prompts' | 'sound'
const tabs = [
  { id: 'channels' as const, label: '模型渠道', Icon: Conversation },
  { id: 'prompts' as const, label: '提示词配置', Icon: FileText },
  { id: 'sound' as const, label: '通知与声音', Icon: IconMic },
]
export interface SettingsPageProps extends StudioNavigationProps { onBack: () => void; backLabel?: string }

export const SettingsPage: React.FC<SettingsPageProps> = ({ onBack, backLabel = '返回工作区', ...navigation }) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>('channels')
  return <StudioPageFrame active="settings" {...navigation}><main data-ai-id="settings-page" className="studio-settings">
    <header className="studio-settings-header"><button type="button" className="theatre-tool" data-ai-id="settings-back" aria-label={backLabel} onClick={onBack}><ArrowLeft size={18} />{backLabel}</button><h1><IconSettings size={20} />设置</h1></header>
    <div className="studio-settings-layout">
      <nav role="tablist" aria-label="设置分类" className="studio-settings-nav">{tabs.map(({ id, label, Icon }) => <button key={id} id={`settings-tab-${id}`} type="button" role="tab" aria-selected={activeTab === id} aria-controls="settings-content" data-ai-id={`settings-tab-${id}`} onClick={() => setActiveTab(id)}><Icon size={17} />{label}</button>)}</nav>
      <section key={activeTab} id="settings-content" role="tabpanel" aria-labelledby={`settings-tab-${activeTab}`} className="studio-settings-content">{activeTab === 'channels' ? <ChannelSettingsPage /> : activeTab === 'sound' ? <NotificationSoundSettingsPage /> : <PromptSettingsPage />}</section>
    </div>
  </main></StudioPageFrame>
}
export default SettingsPage
