import React from 'react'
import type { LeanScopeView } from '../../shared/types'
import { CardOptions, type CardOption } from './CardOptions'
import '../styles/scope-confirmation.css'

export const ScopeConfirmationPanel: React.FC<{ scope?: LeanScopeView; summary?: string; options: CardOption[]; onSelect: (option: CardOption) => void; busy: boolean }> = ({ scope, summary, options, onSelect, busy }) => (
  <section className="scope-confirmation" aria-label="需求确认">
    <header><span>需求已整理</span><h2>这次要做的软件</h2><p>核对下面的内容。确认后，我们再准备界面和程序。</p></header>
    <div className="scope-confirmation-content">
      {scope ? <><p className="scope-goal">{scope.goal}</p><span className="scope-usage">{scope.usage}</span><h3>包含这些功能</h3>
        <ol>{scope.features.map(feature => <li key={feature.id}><strong>{feature.description}</strong>{feature.expected && <p>{feature.expected}</p>}</li>)}</ol>
        {scope.constraints?.length > 0 && <><h3>需要遵守</h3><ul>{scope.constraints.map(text => <li key={text}>{text}</li>)}</ul></>}
        {scope.out_of_scope?.length > 0 && <><h3>这次先不做</h3><ul>{scope.out_of_scope.map(text => <li key={text}>{text}</li>)}</ul></>}
      </> : <p style={{ whiteSpace: 'pre-wrap' }}>{summary}</p>}
    </div>
    <footer><CardOptions options={options} onSelect={onSelect} disabled={busy} /></footer>
  </section>
)
