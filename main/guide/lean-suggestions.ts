import { createHash } from 'node:crypto'
import type { LeanScopeSuggestion } from '../../shared/types'
import type { PrdBackplane } from '../model/prd-backplane'
import { bindAcceptance } from '../project/requirement-contract'

const normalized = (text: string) => text.replace(/\s+/g, '').toLowerCase()

/** Optional ideas never become requirements merely because a model returned them. */
export function parseLeanSuggestions(value: unknown, descriptions: string[] = []): LeanScopeSuggestion[] {
  if (!Array.isArray(value)) return []
  const seen = new Set(descriptions.map(normalized)), suggestions: LeanScopeSuggestion[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    if (![row.title, row.description, row.benefit, row.expected].every(text => typeof text === 'string' && text.trim())) continue
    const [title, description, benefit, expected] = [row.title, row.description, row.benefit, row.expected].map(text => (text as string).trim())
    if (title.length > 40 || description.length > 240 || benefit.length > 160 || expected.length > 240 || seen.has(normalized(description))) continue
    seen.add(normalized(description))
    // Content-derived ids reject stale picks even if the original scope did not change.
    const id = `S-${createHash('sha256').update(JSON.stringify([title, description, benefit, expected])).digest('hex').slice(0, 16)}`
    suggestions.push({ id, title, description, benefit, expected })
    if (suggestions.length === 3) break
  }
  return suggestions
}

/** Merge only host-saved choices. Input carries ids, never replacement descriptions. */
export function adoptLeanSuggestions(brief: PrdBackplane, suggestions: LeanScopeSuggestion[], ids: unknown): PrdBackplane {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 3 || ids.some(id => typeof id !== 'string')
    || new Set(ids).size !== ids.length || ids.some(id => !suggestions.some(item => item.id === id))) throw Error('LEAN_SUGGESTION_SELECTION_INVALID')
  const selected = suggestions.filter(item => ids.includes(item.id))
  let next = Math.max(0, ...brief.requirements.map(row => Number(/^F-(\d+)$/.exec(row.id)?.[1] ?? 0))) + 1
  const acceptance = { ...brief.acceptance }
  const requirements = [...brief.requirements, ...selected.map(item => {
    const id = `F-${String(next++).padStart(3, '0')}`
    acceptance[id] = item.expected
    return { id, description: item.description, priority: 'P0' as const, behavior_assertions: [item.expected] }
  })]
  return bindAcceptance({ ...brief, user_confirmed_at: undefined, requirements, acceptance })
}
