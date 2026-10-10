import React from 'react'
import { Markdown } from './Markdown'

/** Display only; the full model response remains available and is never rewritten. */
export const CompactReply: React.FC<{ text: string }> = ({ text }) => {
  if (text.length <= 180 && text.split('\n').length <= 4) return <Markdown text={text} />
  const first = text.split(/\n\s*\n/).find(part => part.trim()) ?? text
  const preview = first.length > 140 ? `${first.slice(0, 140)}…` : first
  return <details className="compact-reply" data-ai-id="compact-reply">
    <summary><span className="compact-reply-preview">{preview}</span><span className="compact-reply-label">展开完整回复 · {text.length} 字</span></summary>
    <Markdown text={text} />
  </details>
}
