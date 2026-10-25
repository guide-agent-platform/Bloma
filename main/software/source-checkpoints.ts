import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { writeTextFileAtomic } from '../../storage/json-store'
import { softwareVerificationFingerprint, verificationSourceFiles } from '../desktop/verification-fingerprint'
import { debugWorkspace } from './debug-workspace'

interface File { path: string; hash: string; size: number }
interface Checkpoint { version: 1; projectId: string; sessionId: string; root: string; source: string; at: string; files: File[] }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const hex = /^[a-f0-9]{64}$/
function directory(projectId: string, sessionId: string) {
  const root = join(debugWorkspace(projectId, sessionId), 'source-checkpoints')
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw Error('SOURCE_CHECKPOINT_LINK_UNSUPPORTED')
  mkdirSync(root, { recursive: true }); return root
}
function target(root: string, path: string) {
  if (!path || path.includes('\\') || isAbsolute(path) || /^[A-Za-z]:/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(part))) throw Error('SOURCE_RESTORE_PATH_INVALID')
  let full = resolve(root)
  for (const part of path.split('/')) {
    full = join(full, part)
    if (existsSync(full) && lstatSync(full).isSymbolicLink()) throw Error('SOURCE_RESTORE_LINK_UNSUPPORTED')
  }
  const rel = relative(resolve(root), full)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw Error('SOURCE_RESTORE_PATH_INVALID')
  return full
}
function read(projectId: string, sessionId: string, root: string, source: string): Checkpoint {
  if (!hex.test(source)) throw Error('SOURCE_CHECKPOINT_ID_INVALID')
  const file = join(directory(projectId, sessionId), `${source}.json`)
  if (lstatSync(file).isSymbolicLink()) throw Error('SOURCE_CHECKPOINT_LINK_UNSUPPORTED')
  const value = JSON.parse(readFileSync(file, 'utf8')) as Checkpoint
  if (value.version !== 1 || value.projectId !== projectId || value.sessionId !== sessionId || value.root !== resolve(root) || value.source !== source
    || !Array.isArray(value.files) || value.files.length > 3000 || new Set(value.files.map(f => f.path)).size !== value.files.length) throw Error('SOURCE_CHECKPOINT_IDENTITY_INVALID')
  for (const f of value.files) {
    target(root, f.path)
    if (!hex.test(f.hash) || !Number.isSafeInteger(f.size) || f.size < 0 || f.size > 8 * 1024 * 1024) throw Error('SOURCE_CHECKPOINT_FILE_INVALID')
  }
  if (value.files.reduce((bytes, file) => bytes + file.size, 0) > 32 * 1024 * 1024) throw Error('SOURCE_CHECKPOINT_SIZE_LIMIT')
  return value
}
export function saveSourceCheckpoint(projectId: string, sessionId: string, root: string, source: string) {
  if (!hex.test(source) || softwareVerificationFingerprint(root) !== source) throw Error('SOURCE_CHECKPOINT_STALE')
  const base = directory(projectId, sessionId), manifest = join(base, `${source}.json`)
  if (existsSync(manifest)) { read(projectId, sessionId, root, source); return { id: source, files: undefined } }
  const files: File[] = []; let bytes = 0
  for (const entry of verificationSourceFiles(root)) {
    if (lstatSync(entry.path).size > 8 * 1024 * 1024) throw Error('SOURCE_CHECKPOINT_SIZE_LIMIT')
    const buffer = readFileSync(entry.path)
    if (buffer.length > 8 * 1024 * 1024 || (bytes += buffer.length) > 32 * 1024 * 1024 || files.length >= 3000) throw Error('SOURCE_CHECKPOINT_SIZE_LIMIT')
    const digest = hash(buffer), blob = join(base, `${digest}.blob`)
    if (existsSync(blob)) { if (lstatSync(blob).isSymbolicLink() || hash(readFileSync(blob)) !== digest) throw Error('SOURCE_CHECKPOINT_BLOB_CHANGED') }
    else writeFileSync(blob, buffer, { flag: 'wx', mode: 0o600 })
    files.push({ path: entry.relative, hash: digest, size: buffer.length })
  }
  if (softwareVerificationFingerprint(root) !== source) throw Error('SOURCE_CHECKPOINT_STALE')
  writeTextFileAtomic(manifest, JSON.stringify({ version: 1, projectId, sessionId, root: resolve(root), source, at: new Date().toISOString(), files } satisfies Checkpoint))
  return { id: source, files: files.length }
}
export function sourceCheckpointChanges(projectId: string, sessionId: string, root: string, source: string) {
  const snapshot = read(projectId, sessionId, root, source), old = new Map(snapshot.files.map(file => [file.path, file]))
  const changed: Array<{ path: string; kind: string }> = []
  for (const entry of verificationSourceFiles(root)) {
    const before = old.get(entry.relative); old.delete(entry.relative)
    if (!before || hash(readFileSync(entry.path)) !== before.hash) changed.push({ path: entry.relative, kind: before ? 'modified' : 'added' })
  }
  for (const path of old.keys()) changed.push({ path, kind: 'missing' })
  return { checkpoint_id: source, current_source: softwareVerificationFingerprint(root), changes: changed }
}
function replace(file: string, bytes: Buffer) {
  mkdirSync(dirname(file), { recursive: true }); const temp = join(dirname(file), `.bloma-restore-${randomUUID()}`)
  try { writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 }); renameSync(temp, file) }
  finally { if (existsSync(temp)) unlinkSync(temp) }
}
/** Explicit selected-file recovery. Back up every overwritten byte before the
 * first write; don't delete added files, touch data/dependencies, or bless PASS. */
export function restoreSourceFiles(projectId: string, sessionId: string, root: string, source: string, expected: string, paths: string[], io: { replace?: typeof replace } = {}) {
  const snapshot = read(projectId, sessionId, root, source), base = directory(projectId, sessionId)
  if (!hex.test(expected) || softwareVerificationFingerprint(root) !== expected) throw Error('SOURCE_RESTORE_CURRENT_CHANGED')
  if (!Array.isArray(paths) || !paths.length || paths.length > 100 || new Set(paths).size !== paths.length) throw Error('SOURCE_RESTORE_SELECTION_INVALID')
  const plan = paths.map(path => {
    const file = snapshot.files.find(file => file.path === path); if (!file) throw Error('SOURCE_RESTORE_FILE_NOT_IN_CHECKPOINT')
    const destination = target(root, path), blob = join(base, `${file.hash}.blob`)
    if (lstatSync(blob).isSymbolicLink() || lstatSync(blob).size !== file.size) throw Error('SOURCE_CHECKPOINT_BLOB_CHANGED')
    const bytes = readFileSync(blob); if (bytes.length !== file.size || hash(bytes) !== file.hash) throw Error('SOURCE_CHECKPOINT_BLOB_CHANGED')
    if (existsSync(destination) && (!lstatSync(destination).isFile() || lstatSync(destination).size > 8 * 1024 * 1024)) throw Error('SOURCE_RESTORE_TARGET_INVALID')
    const before = existsSync(destination) ? readFileSync(destination) : undefined
    return { path, destination, bytes, before, oldHash: before && hash(before) }
  })
  const backup = join(base, `restore-${randomUUID()}`); mkdirSync(backup)
  plan.forEach((item, i) => { if (item.before) writeFileSync(join(backup, `${i}.blob`), item.before, { flag: 'wx', mode: 0o600 }) })
  const journal = { state: 'prepared', source, expected, paths: plan.map((item, index) => ({ path: item.path, oldHash: item.oldHash, backup: item.before ? `${index}.blob` : null })) }
  const save = () => writeTextFileAtomic(join(backup, 'restore.json'), JSON.stringify(journal))
  save(); const applied: typeof plan = []
  try {
    if (softwareVerificationFingerprint(root) !== expected) throw Error('SOURCE_RESTORE_CURRENT_CHANGED')
    journal.state = 'applying'; save()
    for (const item of plan) {
      target(root, item.path)
      const now = existsSync(item.destination) ? hash(readFileSync(item.destination)) : undefined
      if (now !== item.oldHash) throw Error('SOURCE_RESTORE_CURRENT_CHANGED')
      ;(io.replace ?? replace)(item.destination, item.bytes); applied.push(item)
    }
    journal.state = 'complete'; save()
    return { restored: paths, backup, current_source: softwareVerificationFingerprint(root), complete_source_match: softwareVerificationFingerprint(root) === source,
      verification: 'not_run', note: '仅所选文件已还原；新增文件保留，正式验收仍需执行。' }
  } catch (error) {
    journal.state = 'failed'; try { save() } catch { /* failed journal writes cannot prevent restoring prior bytes */ }
    for (const item of applied.reverse()) {
      target(root, item.path)
      if (hash(readFileSync(item.destination)) !== hash(item.bytes)) throw Error(`SOURCE_RESTORE_CONCURRENT_EDIT: 原始备份保留在${backup}`)
      if (item.before) replace(item.destination, item.before); else unlinkSync(item.destination)
    }
    journal.state = 'rolled_back'; try { save() } catch { /* durable original backups remain available */ }
    throw Error(`SOURCE_RESTORE_FAILED: ${String(error)}；原始备份保留在${backup}`)
  }
}
