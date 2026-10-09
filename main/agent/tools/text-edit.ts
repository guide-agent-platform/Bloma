/** Exact editing with a CRLF/LF-only fallback; never relax other whitespace. */
export function replaceUniqueText(current: string, oldText: string, newText: string):
  | { ok: true; content: string }
  | { ok: false; matches: number } {
  if (!oldText) return { ok: false, matches: 0 }
  const exact = current.split(oldText).length - 1
  if (exact > 1) return { ok: false, matches: exact }
  let start: number
  let length: number
  if (exact === 1) {
    start = current.indexOf(oldText)
    length = oldText.length
  } else {
    const escaped = oldText.replace(/\r\n/g, '\n').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(escaped.replace(/\n/g, '\\r?\\n'), 'g')
    const matches = [...current.matchAll(pattern)]
    if (matches.length !== 1) return { ok: false, matches: matches.length }
    start = matches[0].index!
    length = matches[0][0].length
  }
  // Match in the original bytes so unrelated content and mixed endings survive.
  const ending = current.slice(start, start + length).match(/\r?\n/)?.[0] ?? current.match(/\r?\n/)?.[0] ?? '\n'
  const replacement = newText.replace(/\r\n/g, '\n').replace(/\n/g, ending)
  return { ok: true, content: current.slice(0, start) + replacement + current.slice(start + length) }
}
