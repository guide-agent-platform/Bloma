import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { readProjectAttempts } from '../platform/execution/project-attempts'
import { safeToolFeedback, type ToolFeedback } from '../../shared/tool-feedback'
import { isHostPresentationOutput } from './host-verification-outputs'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const excluded = new Set(['.venv', 'venv', '__pycache__', '.git', 'node_modules', '.cache'])
// Registration and delivery prose are checked separately by the host delivery gate.
const declarations = new Set(['CORE_CHECK.json', 'LAUNCH.json', 'DELIVERY.md'])
function treeFingerprint(root: string): string {
  const files: Array<[string, string]> = []; let size = 0
  const visit = (directory: string, executableOnly = false) => {
    for (const name of readdirSync(directory).sort()) {
      if (excluded.has(name)) continue
      const full = join(directory, name), rel = relative(root, full).replaceAll('\\', '/')
      if (declarations.has(rel) || isHostPresentationOutput(rel)) continue
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) throw new Error('VERIFICATION_SOURCE_LINK')
      if (stat.isDirectory()) visit(full, executableOnly || name === '00_VERIFY')
      else if (stat.isFile()) {
        if (executableOnly && !/\.(?:py|js|mjs|cjs|ts|tsx|html|css)$/i.test(name)) continue
        size += stat.size
        if (files.length >= 4096 || size > 128 * 1024 * 1024) throw new Error('VERIFICATION_SOURCE_LIMIT')
        files.push([rel, hash(readFileSync(full))])
      } else throw new Error('VERIFICATION_SOURCE_UNSUPPORTED')
    }
  }
  if (existsSync(root)) visit(root)
  return hash(JSON.stringify(files))
}
export interface VerificationVersion { source_fingerprint: string; environment_fingerprint: string }
function dependencyVersions(root: string): string {
  const rows: Array<[string, number, number]> = []
  const visit = (directory: string) => {
    if (!existsSync(directory)) return
    for (const name of readdirSync(directory).sort()) {
      if (['__pycache__', '.cache'].includes(name)) continue
      const full = join(directory, name), stat = lstatSync(full)
      if (stat.isSymbolicLink()) throw new Error('VERIFICATION_DEPENDENCY_LINK')
      if (stat.isDirectory()) visit(full)
      else if (stat.isFile()) {
        if (rows.length >= 20000) throw new Error('VERIFICATION_DEPENDENCY_LIMIT')
        rows.push([relative(root, full).replaceAll('\\', '/'), stat.size, stat.mtimeMs])
      }
    }
  }
  visit(join(root, '.venv')); return hash(JSON.stringify(rows))
}
export function captureVerificationVersion(root: string, python: string, env: Record<string, string>, projectId: string): VerificationVersion {
  const stat = existsSync(python) ? lstatSync(python) : undefined
  const config = join(root, '.venv', 'pyvenv.cfg')
  return { source_fingerprint: treeFingerprint(root), environment_fingerprint: hash(JSON.stringify({
    python, executable: stat ? [stat.size, stat.mtimeMs] : null, venv: existsSync(config) ? hash(readFileSync(config)) : null,
    dependencies: dependencyVersions(root),
    environment: Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
    data: env.APP_DATA_DIR ? treeFingerprint(env.APP_DATA_DIR) : null,
    installs: Object.entries(readProjectAttempts(projectId).total).filter(([scope]) => scope.startsWith('install:')),
  })) }
}
export function receiptEvidence(entry: string, command: string[], timeoutMs: number, version: VerificationVersion,
  after: VerificationVersion, scenarios: Array<{ outcome: string }>): NonNullable<ToolFeedback['evidence']> {
  return { key: hash(JSON.stringify([command, timeoutMs])), entry, ...version,
    freshness: version.source_fingerprint === after.source_fingerprint && version.environment_fingerprint === after.environment_fingerprint ? 'current' : 'unknown',
    passed: scenarios.filter(s => s.outcome === 'pass').length, failed: scenarios.filter(s => s.outcome === 'fail').length,
    blocked: scenarios.filter(s => s.outcome === 'blocked').length }
}
function receiptPath(projectId: string, sessionId: string): string {
  if (![projectId, sessionId].every(s => /^[A-Za-z0-9_-]+$/.test(s))) throw new Error('VERIFICATION_CONTEXT_INVALID')
  return join(getPromaHome(), 'verification-receipts', projectId, sessionId + '.json')
}
function readReceipts(projectId: string, sessionId: string): ToolFeedback[] {
  const file = receiptPath(projectId, sessionId)
  if (!existsSync(file)) return []
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  if (raw.schema_version !== 1 || !Array.isArray(raw.facts) || raw.facts.length > 16) throw new Error('VERIFICATION_RECEIPTS_INVALID')
  return raw.facts.map(safeToolFeedback).filter((f: ToolFeedback | undefined): f is ToolFeedback => Boolean(f?.evidence))
}
export function hasVerificationReceipt(projectId: string, sessionId: string, key: string): boolean {
  return readReceipts(projectId, sessionId).some(f => f.evidence!.key === key)
}
/** Called after permission/write-audit wrappers; never saves their rejected run as a pass. */
export function receiptPython(projectId: string, sessionId: string): string | undefined {
  const file = receiptPath(projectId, sessionId)
  if (!existsSync(file)) return undefined
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  return typeof raw.python === 'string' && raw.python.length < 512 ? raw.python : undefined
}
export function recordVerificationReceipt(projectId: string, sessionId: string, feedback: ToolFeedback, python: string): void {
  const fact = safeToolFeedback(feedback)
  if (!fact?.evidence) return
  const facts = readReceipts(projectId, sessionId).filter(f => f.evidence!.key !== fact.evidence!.key)
  facts.push(fact)
  writeTextFileAtomic(receiptPath(projectId, sessionId), JSON.stringify({ schema_version: 1, python, facts: facts.slice(-16) }))
}
export function collectVerificationReceipts(projectId: string, sessionId: string, version?: VerificationVersion): ToolFeedback[] {
  return readReceipts(projectId, sessionId).map(f => {
    const e = f.evidence!
    const freshness = !version || e.freshness === 'unknown' ? 'unknown' : e.source_fingerprint === version.source_fingerprint
      && e.environment_fingerprint === version.environment_fingerprint ? 'current' : 'stale'
    return { ...f, verification: freshness === 'current' ? f.verification : 'unverified', evidence: { ...e, freshness } }
  })
}
