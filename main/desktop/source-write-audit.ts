import { existsSync, lstatSync, readFileSync, readdirSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import type { ToolOutcome } from '../agent/loop/agent-loop'

const leases = new Map<string, Promise<void>>()
/** Serializes controlled source writers; another worker's edits cannot be mistaken
 * for a script side effect. This is an experiment audit, not an OS sandbox. */
export async function withProjectWriteLease<T>(root: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root)
  const previous = leases.get(key) ?? Promise.resolve()
  let release!: () => void
  const owned = new Promise<void>(r => { release = r })
  const queued = previous.then(() => owned)
  leases.set(key, queued)
  let abort!: () => void
  try {
    signal.throwIfAborted()
    await Promise.race([previous, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason ?? new Error('SOURCE_WRITE_CANCELLED'))
      signal.addEventListener('abort', abort, { once: true })
    })])
    signal.throwIfAborted()
    return await action()
  } finally {
    if (abort) signal.removeEventListener('abort', abort)
    release()
    void queued.then(() => { if (leases.get(key) === queued) leases.delete(key) })
  }
}
interface File { bytes: Buffer; hash: string }
const excluded = new Set(['.venv', 'venv', '__pycache__', '.git', 'node_modules'])
function snapshot(root: string): Map<string, File> {
  const files = new Map<string, File>(); let total = 0
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      if (excluded.has(name)) continue
      const full = join(directory, name), stat = lstatSync(full)
      if (stat.isSymbolicLink()) throw new Error('EXPERIMENT_SOURCE_AUDIT_SYMLINK')
      if (stat.isDirectory()) visit(full)
      else {
        total += stat.size
        if (files.size >= 4096 || total > 128 * 1024 * 1024) throw new Error('EXPERIMENT_SOURCE_AUDIT_LIMIT')
        const bytes = readFileSync(full)
        files.set(relative(root, full).replaceAll('\\', '/'), { bytes, hash: createHash('sha256').update(bytes).digest('hex') })
      }
    }
  }
  visit(root); return files
}
export async function auditScriptSourceWrites(root: string, scopes: string[] | undefined, protectedPaths: string[],
  action: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
  const before = snapshot(root), result = await action(), after = snapshot(root)
  const protectedSet = new Set(protectedPaths.map(p => p.toLowerCase()))
  const permitted = (path: string) => !protectedSet.has(path.toLowerCase()) && (scopes === undefined || scopes.some(s =>
    path.toLowerCase() === s.toLowerCase() || s.endsWith('/') && path.toLowerCase().startsWith(s.toLowerCase())))
  const refused = [...new Set([...before.keys(), ...after.keys()])].filter(p => before.get(p)?.hash !== after.get(p)?.hash && !permitted(p))
  if (!refused.length) return result
  for (const p of refused) {
    const full = resolve(root, p), rel = relative(resolve(root), full)
    if (rel.startsWith('..') || resolve(full) === resolve(root)) throw new Error('EXPERIMENT_SOURCE_ROLLBACK_OUTSIDE_ROOT')
    const original = before.get(p)
    if (original) { mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, original.bytes) }
    else if (existsSync(full)) unlinkSync(full)
  }
  return { ...result, isError: true, output: `EXPERIMENT_SCRIPT_WRITE_OUTSIDE_ASSIGNMENT: 已回滚越界源文件修改=${refused.join(', ')}；当前可写范围=${scopes?.join(', ') ?? '业务源文件（冻结输入除外）'}。\n${result.output}`,
    feedback: { ...result.feedback, schema_version: 1, execution: result.feedback?.execution ?? (result.isError ? 'failed' : 'completed'), verification: 'unverified', source: 'host', scope: 'source_write_audit', category: 'permission',
      reason: 'SCRIPT_SOURCE_WRITES_ROLLED_BACK', recovery: 'correct_input' } }
}
