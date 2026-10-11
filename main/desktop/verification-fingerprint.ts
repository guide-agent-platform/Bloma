import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Mutable business data/reports are not executable verification inputs.
const EXCLUDED = new Set(['.git', '.venv', 'node_modules', '__pycache__', 'data', '00_VERIFY', '00_UX', '00_HISTORY'])
const INPUT_FILE = /\.(?:py|js|mjs|cjs|ts|tsx|html|css|json|txt|toml|yaml|yml|onnx)$/i

/** Unknown/unreadable/linked inputs disable reuse; they never mean unchanged. */
export function verificationFingerprint(root: string | undefined, context: unknown = null): string | undefined {
  if (!root || !existsSync(root)) return undefined
  try {
    const hash = createHash('sha256').update('bloma-verification-v1\n').update(JSON.stringify(context))
    let count = 0
    let bytes = 0
    const visit = (dir: string, relative = '') => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (EXCLUDED.has(entry.name) || entry.name.startsWith('.')) continue
        if (entry.isSymbolicLink()) throw new Error('linked verification input')
        const path = join(dir, entry.name)
        const rel = `${relative}${entry.name}`
        if (entry.isDirectory()) { visit(path, `${rel}/`); continue }
        if (!INPUT_FILE.test(entry.name)) continue
        const size = statSync(path).size
        if (++count > 5000 || (bytes += size) > 32 * 1024 * 1024) throw new Error('verification input budget')
        hash.update(JSON.stringify(rel)).update('\0').update(readFileSync(path)).update('\0')
      }
    }
    visit(root)
    return hash.digest('hex')
  } catch {
    return undefined
  }
}
