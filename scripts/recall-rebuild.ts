// Compile into run-artifacts and invoke with an explicit home. No message contents printed.
import { buildSessionIndex } from '../main/agent/loop/session-recall'
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
const root = process.argv[2]
if (!root || !existsSync(join(root, 'agent-sessions'))) throw new Error('Explicit existing Bloma home required')
process.env.PROMA_HOME = resolve(root)
function sourceDigest() {
  const hash = createHash('sha256')
  for (const name of readdirSync(join(root, 'agent-sessions')).filter(name => name.endsWith('.jsonl')).sort()) {
    hash.update(name).update('\0').update(readFileSync(join(root, 'agent-sessions', name))).update('\0')
  }
  return hash.digest('hex')
}
const sourceBefore = sourceDigest()
const beforePath = join(root, '.session-recall-index.json')
let before = 0
try { before = JSON.parse(readFileSync(beforePath, 'utf8')).files.reduce((n: number, f: { msgs: { text: string }[] }) => n + f.msgs.filter(m => /^<session-recall>/.test(m.text)).length, 0) } catch { /* optional prior cache */ }
const { index, totalMessages } = await buildSessionIndex(true)
const sourceAfter = sourceDigest()
const report = { schema_version: index.schema_version, files: index.files.length, messages: totalMessages, injected_before: before,
  injected_after: index.files.reduce((n, f) => n + f.msgs.filter(m => /^<session-recall>/.test(m.text)).length, 0),
  source_files_modified: sourceBefore !== sourceAfter, source_sha256_before: sourceBefore, source_sha256_after: sourceAfter,
  backup_exists: existsSync(`${beforePath}.v1.bak`) }
writeFileSync('run-artifacts/robustness-recall-rebuild.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))
