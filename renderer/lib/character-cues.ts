/** Session-scoped display markers. Never store requirement text, execute actions or change project state. */
const STORAGE_KEY = 'bloma.character-cues.v1'
const fallback = new Set<string>()
export function characterCueKey(kind: string, value: unknown): string {
  const text = JSON.stringify(value) ?? ''
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619)
  return `${kind}:${(hash >>> 0).toString(16)}:${text.length}`
}
export function hasCharacterCue(key: string): boolean {
  try {
    const values: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]')
    if (Array.isArray(values) && values.includes(key)) return true
  } catch { /* The in-memory fallback also covers unavailable storage. */ }
  return fallback.has(key)
}
export function rememberCharacterCue(key: string): void {
  fallback.add(key)
  if (fallback.size > 128) fallback.delete(fallback.values().next().value!)
  try {
    const previous: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]')
    const values = Array.isArray(previous) ? previous.filter((value): value is string => typeof value === 'string' && value !== key) : []
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...values, key].slice(-128)))
  } catch { /* Static controls remain usable without storage. */ }
}
