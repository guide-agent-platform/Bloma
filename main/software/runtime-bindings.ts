import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'

export type RuntimeKind = 'node' | 'python'
export interface ManagedRuntime { kind: RuntimeKind; version: string; executable: string; sha256: string; platform: string; arch: string;
  abi?: string; request: string; source: string; archive_sha256?: string; license: string; at: string }
function bindingsFile(projectId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw Error('RUNTIME_PROJECT_INVALID')
  return join(getPromaHome(), 'software-environments', projectId, 'runtimes.json')
}
function digest(file: string) {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024), fd = openSync(file, 'r')
  try { let length: number; while ((length = readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, length)); return hash.digest('hex') }
  finally { closeSync(fd) }
}
export function validateManagedRuntime(value: ManagedRuntime): ManagedRuntime {
  const root = realpathSync(join(getPromaHome(), 'software-runtimes')), file = realpathSync(value.executable), rel = relative(root, file)
  if (!['node', 'python'].includes(value.kind) || value.platform !== process.platform || value.arch !== process.arch
    || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !/^[a-f0-9]{64}$/.test(value.sha256) || digest(file) !== value.sha256) throw Error('MANAGED_RUNTIME_CHANGED_OR_OUTSIDE_STORE')
  return value
}
export function managedRuntime(projectId: string, kind: RuntimeKind): ManagedRuntime | undefined {
  const file = bindingsFile(projectId); if (!existsSync(file)) return
  const values = JSON.parse(readFileSync(file, 'utf8')) as Partial<Record<RuntimeKind, ManagedRuntime>>
  return values[kind] ? validateManagedRuntime(values[kind]!) : undefined
}
export function bindManagedRuntime(projectId: string, value: ManagedRuntime) {
  validateManagedRuntime(value)
  const file = bindingsFile(projectId), values = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  writeTextFileAtomic(file, JSON.stringify({ ...values, [value.kind]: value }))
}
export function managedRuntimeDirectories(projectId: string): string[] {
  return [...new Set((['node', 'python'] as const).map(kind => managedRuntime(projectId, kind)).filter(Boolean).map(value => dirname(value!.executable)))]
}
export function runtimeBindingVersion(projectId: string) {
  const file = bindingsFile(projectId)
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'none'
}
