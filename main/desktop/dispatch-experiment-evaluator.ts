/** Read-only validation of previously sealed evaluator/evidence files. */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { getPromaHome } from '../../storage/config-paths'




interface Check { id: string; description: string; kind: 'command' | 'manual'; command?: string; args?: string[]; timeout_ms?: number }
interface Suite { version: 1; checks: Check[] }
export interface CheckResult { id: string; kind: 'command' | 'manual'; status: 'passed' | 'failed' | 'pending' | 'error'; evidence?: string; evidence_sha256?: string; exit_code?: number | null; duration_ms?: number }
export interface Evaluation { suite_hash: string; product_hash: string; checks: CheckResult[]; complete: boolean; score: number | null; success: boolean | null }
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const suitePath = (home: string) => join(home, 'dispatch-experiments/evaluator')
/** Same hashes on every home; reject links and unsupported files rather than following them. */
function files(root: string, product = false): Record<string, Buffer> {
  const result: Record<string, Buffer> = {}; let size = 0
  const walk = (path: string) => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error('EXPERIMENT_EVALUATOR_LINK')
    if (product && ['.git', '.venv', 'venv', 'node_modules', '__pycache__', '.cache'].includes(path.split(/[\\/]/).at(-1)!.toLowerCase())) return
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name))
    else if (stat.isFile()) {
      size += stat.size
      if (!product && size > 8_388_608) throw new Error('EXPERIMENT_EVALUATOR_TOO_LARGE')
      result[relative(root, path).replaceAll('\\', '/')] = readFileSync(path)
    } else throw new Error('EXPERIMENT_EVALUATOR_UNSUPPORTED_FILE')
  }
  walk(root); return result
}
const fingerprint = (entries: Record<string, Buffer>) => hash(JSON.stringify(Object.entries(entries).map(([path, bytes]) => [path, hash(bytes)])))
function readSuite(entries: Record<string, Buffer>): Suite {
  const suite = JSON.parse(entries['suite.json']?.toString() ?? 'null') as Suite
  if (suite?.version !== 1 || !Array.isArray(suite.checks) || !suite.checks.length || suite.checks.length > 100) throw new Error('EXPERIMENT_INVALID_EVALUATOR')
  const ids = new Set<string>()
  for (const check of suite.checks) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(check.id) || ids.has(check.id) || !check.description?.trim()
      || !['command', 'manual'].includes(check.kind)) throw new Error('EXPERIMENT_INVALID_EVALUATOR_CHECK')
    ids.add(check.id)
    if (check.kind === 'command' && (!check.command?.trim() || !Array.isArray(check.args) || check.args.some(arg => typeof arg !== 'string')
      || !Number.isSafeInteger(check.timeout_ms) || check.timeout_ms! < 1 || check.timeout_ms! > 60_000)) throw new Error('EXPERIMENT_INVALID_EVALUATOR_COMMAND')
  }
  return suite
}

export function assertExperimentEvaluator(home: string, expected?: string): void {
  if (expected && fingerprint(files(suitePath(home))) !== expected) throw new Error('EXPERIMENT_EVALUATOR_CHANGED')
}
export function evaluationEvidenceValid(home: string, projectId: string, expected: string | undefined, evaluation: Evaluation): boolean {
  try {
    if (!expected || evaluation.suite_hash !== expected) return false
    assertExperimentEvaluator(home, expected)
    const project = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8')).projects.find((row: { project_id: string }) => row.project_id === projectId)
    if (fingerprint(files(project.root_path, true)) !== evaluation.product_hash) return false
    return evaluation.checks.every(check => check.status === 'pending' || (check.evidence && hash(readFileSync(check.evidence)) === check.evidence_sha256))
  } catch { return false }
}
