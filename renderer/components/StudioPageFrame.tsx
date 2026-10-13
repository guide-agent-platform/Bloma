import React from 'react'
import { House, FolderOpen, PanelsTopLeft } from 'lucide-react'
import { Sprout, IconSettings } from './icons'
import { StudioFumoNote } from './StudioCompanion'

export interface StudioNavigationProps {
  onHome?: () => void
  onProjects?: () => void
  onWorkspace?: () => void
  onSettings?: () => void
}

export const StudioBrand: React.FC = () => <span className="studio-brand"><Sprout size={27} /><span>Bloma<small>让想法成为作品</small></span></span>

export const StudioNavigation: React.FC<StudioNavigationProps & { active: 'home' | 'projects' | 'workspace' | 'settings' }> = ({ active, onHome, onProjects, onWorkspace }) => <nav className="studio-main-navigation" aria-label="主要导航">
  {[{ key: 'home', label: '主页面', Icon: House, action: onHome }, { key: 'projects', label: '我的项目', Icon: FolderOpen, action: onProjects }, { key: 'workspace', label: '项目工作区', Icon: PanelsTopLeft, action: onWorkspace }].map(({ key, label, Icon, action }) => <button key={key} type="button" className="theatre-tool" aria-current={active === key ? 'page' : undefined} disabled={!action && active !== key} onClick={action}><Icon size={16} strokeWidth={1.7} aria-hidden="true" />{label}</button>)}
</nav>

export const StudioPageFrame: React.FC<StudioNavigationProps & { active: 'home' | 'projects' | 'settings'; mode?: 'quick' | 'longterm'; children: React.ReactNode }> = ({ active, mode = 'quick', children, ...navigation }) => <div className="studio-page-frame" data-mode={mode}>
  <aside className="studio-page-sidebar"><StudioBrand /><StudioNavigation active={active} {...navigation} /><div className="studio-page-sidebar-foot"><StudioFumoNote /><button type="button" className="theatre-tool" onClick={navigation.onSettings} aria-label="设置（模型渠道）" aria-current={active === 'settings' ? 'page' : undefined} disabled={!navigation.onSettings && active !== 'settings'}><IconSettings size={16} />设置</button></div></aside>
  <div className="studio-page-scroll">{children}</div>
</div>
