// Size is a review cue, not an architecture verdict or a reason to split a module.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { root: { type: 'string' }, threshold: { type: 'string', default: '800' } } })
const root = resolve(values.root ?? fileURLToPath(new URL('../', import.meta.url)))
const threshold = Number(values.threshold)
if (!Number.isSafeInteger(threshold) || threshold < 1) throw new Error('threshold must be a positive integer')
const rows = []
function visit(directory) {
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || ['node_modules', 'dist', 'dist-main', '.git'].includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) visit(path)
    else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name) && !/\.d\./.test(entry.name)) {
      rows.push({ path: relative(root, path).replaceAll('\\', '/'), lines: readFileSync(path, 'utf8').split('\n').length })
    }
  }
}
for (const directory of ['main', 'shared']) visit(join(root, directory))
console.log(JSON.stringify({ mode: 'informational', review_threshold: threshold, scanned_files: rows.length,
  review_candidates: rows.filter(row => row.lines > threshold).sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path)),
  guidance: 'Review responsibilities, dependency direction and testability. Line count alone never fails this report; no file exemptions hide large modules.' }, null, 2))
