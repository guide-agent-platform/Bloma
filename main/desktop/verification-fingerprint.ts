import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { isHostPresentationOutput } from './host-verification-outputs'

// Mutable business data/reports are not executable verification inputs.
const EXCLUDED = new Set(['.git', '.venv', '.cache', 'node_modules', '__pycache__', '00_HISTORY'])
const MUTABLE_DIRECTORIES = new Set(['data', '00_VERIFY', '00_UX'])
const EXECUTABLE_FILE = /\.(?:py|js|mjs|cjs|ts|tsx|html|css)$/i
const INPUT_FILE = /\.(?:py|js|mjs|cjs|ts|tsx|html|css|json|txt|toml|yaml|yml|onnx)$/i

/** Same input selection as the fingerprint, for bounded source recovery. Business
 * data, dependencies, Git history and presentation output are not restored. */
export function* verificationSourceFiles(root: string, prefix = '', executableOnly = false): Generator<{ path: string; relative: string }> {
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (EXCLUDED.has(entry.name)) continue
    if (entry.isSymbolicLink()) throw Error('SOURCE_CHECKPOINT_LINK_UNSUPPORTED')
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (isHostPresentationOutput(relative)) continue
    if (entry.isDirectory()) yield* verificationSourceFiles(root, relative, executableOnly || MUTABLE_DIRECTORIES.has(entry.name))
    else if ((executableOnly ? EXECUTABLE_FILE : INPUT_FILE).test(entry.name)) yield { path: join(root, relative), relative }
  }
}

/** Unknown/unreadable/linked inputs disable reuse; they never mean unchanged. */
export function verificationFingerprint(root: string | undefined, context: unknown = null, policy: 'standard' | 'software' = 'standard'): string | undefined {
  if (!root || !existsSync(root)) return undefined
  try {
    const hash = createHash('sha256').update('bloma-verification-v1\n').update(JSON.stringify(context))
    let count = 0
    let bytes = 0
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    const visit = (dir: string, relative = '', executableOnly = false) => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (EXCLUDED.has(entry.name)) continue
        if (entry.isSymbolicLink()) throw new Error('linked verification input')
        const path = join(dir, entry.name)
        const rel = `${relative}${entry.name}`
        if (isHostPresentationOutput(rel)) continue
        if (entry.isDirectory()) { visit(path, `${rel}/`, executableOnly || MUTABLE_DIRECTORIES.has(entry.name)); continue }
        // Report/data names are not authority to hide executable test or product code.
        if (!(executableOnly ? EXECUTABLE_FILE : INPUT_FILE).test(entry.name)) continue
        const before = statSync(path), size = before.size
        if (++count > (policy === 'software' ? 100000 : 5000) || (bytes += size) > (policy === 'software' ? 1024 : 32) * 1024 * 1024) throw new Error('verification input budget')
        hash.update(JSON.stringify(rel)).update('\0')
        const fd = openSync(path, 'r')
        try { let length: number; while ((length = readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, length)) }
        finally { closeSync(fd) }
        const after = statSync(path)
        if (after.size !== size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw Error('verification input changed during read')
        hash.update('\0')
      }
    }
    visit(root)
    return hash.digest('hex')
  } catch {
    return undefined
  }
}
export const softwareVerificationFingerprint = (root: string | undefined, context: unknown = null) => verificationFingerprint(root, context, 'software')
/** V2 normal-entry projects include software probes invoked without a project
 * record. Historical V1 experiments keep their original input budget. */
export function declaredVerificationPolicy(root: string): 'standard' | 'software' {
  try { return JSON.parse(readFileSync(join(root, 'LAUNCH.json'), 'utf8')).schema_version === 2 ? 'software' : 'standard' } catch { return 'standard' }
}
