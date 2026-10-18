import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

interface Model { host: string; model: string }
interface Epoch { version: 1; host: string; model: string; policy_path: string; policy_hash: string; epoch_id: string; at: string }
const canonical = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
function pathFor(model: Model): string {
  const root = process.env.BLOMA_MONETARY_EPOCH_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'Bloma', 'monetary-epochs')
  mkdirSync(root, { recursive: true })
  return join(root, hash(`${model.host}\n${model.model}`) + '.json')
}
function lock(path: string): () => void {
  const deadline = Date.now() + 2000
  let fd: number
  for (;;) {
    try { fd = openSync(path + '.lock', 'wx'); break }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw new Error('MONETARY_EPOCH_LOCKED')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  return () => { closeSync(fd); unlinkSync(path + '.lock') }
}
function read(path: string, model: Model): Epoch | undefined {
  if (!existsSync(path)) return undefined
  const e = JSON.parse(readFileSync(path, 'utf8')) as Epoch
  if (e.version !== 1 || e.host !== model.host || e.model !== model.model || !e.policy_path
    || !/^[a-f0-9]{64}$/.test(e.policy_hash) || !e.epoch_id) throw new Error('MONETARY_EPOCH_INVALID')
  return e
}

/** Read the currently activated policy without changing its accounting window. */
export function activeMonetaryPolicyPath(model: Model): string | undefined {
  const root = process.env.BLOMA_MONETARY_EPOCH_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'Bloma', 'monetary-epochs')
  const epoch = read(join(root, hash(`${model.host}\n${model.model}`) + '.json'), model)
  if (!epoch) return undefined
  if (hash(readFileSync(epoch.policy_path)) !== epoch.policy_hash) throw new Error('MONETARY_EPOCH_POLICY_CHANGED')
  return epoch.policy_path
}
function put(path: string, epoch: Epoch): void {
  const temp = `${path}.${randomUUID()}.tmp`
  try { writeFileSync(temp, JSON.stringify(epoch, null, 2), { flag: 'wx' }); renameSync(temp, path) }
  finally { if (existsSync(temp)) unlinkSync(temp) }
}
/** Held until the reservation is stored, so activation cannot race past admission. */
export function acquireMonetaryEpoch(policyPath: string, model: Model, policyHash: string): () => void {
  const path = pathFor(model), release = lock(path)
  try {
    const active = read(path, model)
    if (active && (canonical(active.policy_path) !== canonical(policyPath) || active.policy_hash !== policyHash)) throw new Error('MONETARY_INACTIVE_EPOCH')
    if (!active) put(path, { version: 1, host: model.host, model: model.model, policy_path: canonical(policyPath), policy_hash: policyHash, epoch_id: randomUUID(), at: new Date().toISOString() })
    return release
  } catch (e) { release(); throw e }
}

/** Host operation only. A new window requires explicit reset_models; otherwise all
 * preceding model liabilities must be carried. No request records are edited. */
export function activateMonetaryPolicy(policyPath: string, options: { reset_models?: string[]; only_models?: string[] } = {}): Epoch[] {
  const bytes = readFileSync(policyPath), policy = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))
  const models = policy.models as Model[]
  if (policy.version !== 1 || !Array.isArray(models) || !models.length || models.some(m => typeof m.host !== 'string' || !m.host || typeof m.model !== 'string' || !m.model)
    || new Set(models.map(m => `${m.host}\n${m.model}`)).size !== models.length
    || options.reset_models?.some(m => !models.some(row => row.model === m))
    || (options.only_models !== undefined && (!Array.isArray(options.only_models) || !options.only_models.length
      || new Set(options.only_models).size !== options.only_models.length || options.only_models.some(m => !models.some(row => row.model === m))
      || options.reset_models?.some(m => !options.only_models!.includes(m))))) throw new Error('MONETARY_EPOCH_POLICY_INVALID')
  const policyHash = hash(bytes), target = existsSync(policyPath + '.state.json') ? JSON.parse(readFileSync(policyPath + '.state.json', 'utf8')) : { entries: [] }
  if (target.policy_hash !== undefined && target.policy_hash !== policyHash || !Array.isArray(target.entries)) throw new Error('MONETARY_EPOCH_STATE_INVALID')
  // A host may restore one settled model without reactivating an unrelated model
  // that still has reserved/unknown historical usage. Selected liabilities retain
  // the same locks, carry checks and in-flight rejection as a full activation.
  const paths = models.filter(m => !options.only_models || options.only_models.includes(m.model))
    .map(m => ({ model: m, path: pathFor(m) })).sort((a, b) => a.path.localeCompare(b.path))
  const releases: Array<() => void> = [], originals = new Map<string, Buffer | undefined>(), epochs: Epoch[] = []
  try {
    for (const item of paths) releases.push(lock(item.path))
    for (const { model, path } of paths) {
      const previous = read(path, model)
      originals.set(path, existsSync(path) ? readFileSync(path) : undefined)
      const relevant = (entries: any[]) => entries.filter(e => e.host === model.host && e.model === model.model)
      const newRows = relevant(target.entries)
      if (newRows.some(e => e.status === 'reserved')) throw new Error('MONETARY_EPOCH_HAS_ACTIVE_REQUESTS')
      if (previous && canonical(previous.policy_path) !== canonical(policyPath)) {
        const old = JSON.parse(readFileSync(previous.policy_path + '.state.json', 'utf8'))
        if (old.policy_hash !== previous.policy_hash || !Array.isArray(old.entries)) throw new Error('MONETARY_EPOCH_STATE_INVALID')
        const rows = relevant(old.entries)
        if (rows.some(e => e.status === 'reserved')) throw new Error('MONETARY_EPOCH_HAS_ACTIVE_REQUESTS')
        if (!options.reset_models?.includes(model.model) && rows.some(e => !newRows.some(n => n.id === e.id
          && Number.isSafeInteger(n.charged_micro_rmb) && n.charged_micro_rmb >= e.charged_micro_rmb))) throw new Error('MONETARY_EPOCH_LIABILITIES_NOT_CARRIED')
      }
      epochs.push({ version: 1, host: model.host, model: model.model, policy_path: canonical(policyPath), policy_hash: policyHash, epoch_id: randomUUID(), at: new Date().toISOString() })
    }
    for (let i = 0; i < paths.length; i++) put(paths[i].path, epochs[i])
    return epochs
  } catch (error) {
    // Locks remain held during rollback; no sender can observe an admitted partial switch.
    for (const [path, original] of originals) {
      if (original) writeFileSync(path, original)
      else if (existsSync(path)) unlinkSync(path)
    }
    throw error
  } finally { for (const release of releases.reverse()) release() }
}
