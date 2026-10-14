import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { getPromaHome } from '../../storage/config-paths'
import { experimentPath, recordExperiment, validateExperiment } from './dispatch-experiment'
import { readExperimentEvents } from './dispatch-experiment-records'
import { pythonEncodingEnv } from './python-process-env'

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
export function installExperimentEvaluator(source: string, home: string): string {
  const entries = files(resolve(source)); readSuite(entries)
  for (const [path, bytes] of Object.entries(entries)) {
    const target = join(suitePath(home), path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes, { flag: 'wx' })
  }
  return fingerprint(entries)
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
function summarize(suiteHash: string, productHash: string, checks: CheckResult[]): Evaluation {
  const complete = checks.every(check => check.status === 'passed' || check.status === 'failed')
  return { suite_hash: suiteHash, product_hash: productHash, checks, complete,
    score: complete ? checks.filter(check => check.status === 'passed').length / checks.length : null,
    success: complete ? checks.every(check => check.status === 'passed') : null }
}
/** Host-only evaluator. Rules were sealed before execution; agent-generated tests are not the scorer. */
export function evaluateExperiment(projectId: string, manual?: Array<{ id: string; passed: boolean; evidence: string }>) {
  const home = getPromaHome(), config = validateExperiment(JSON.parse(readFileSync(experimentPath(projectId), 'utf8')))
  if (!config.evaluator_hash) throw new Error('EXPERIMENT_NO_FROZEN_EVALUATOR')
  assertExperimentEvaluator(home, config.evaluator_hash)
  const { events, malformed } = readExperimentEvents(config)
  if (malformed || !events.some(event => event.event === 'run_finished')) throw new Error('EXPERIMENT_MUST_BE_FINISHED_BEFORE_EVALUATION')
  const suite = readSuite(files(suitePath(home)))
  const index = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8'))
  const project = index.projects?.find((item: { project_id: string }) => item.project_id === projectId)
  if (!project?.root_path || !existsSync(project.root_path)) throw new Error('EXPERIMENT_PRODUCT_MISSING')
  const previous = events.filter(event => event.event === 'product_evaluated').at(-1)?.evaluation as Evaluation | undefined
  if (previous?.complete || (previous && !manual)) throw new Error('EXPERIMENT_ALREADY_EVALUATED')
  const productHash = fingerprint(files(project.root_path, true))
  if (previous && previous.product_hash !== productHash) throw new Error('EXPERIMENT_PRODUCT_CHANGED_AFTER_EVALUATION')
  const supplied = new Map<string, CheckResult>()
  for (const row of manual ?? []) {
    if (!suite.checks.some(check => check.id === row.id && check.kind === 'manual') || supplied.has(row.id)
      || typeof row.passed !== 'boolean' || typeof row.evidence !== 'string' || !row.evidence.trim()) throw new Error('EXPERIMENT_INVALID_MANUAL_EVIDENCE')
    supplied.set(row.id, { id: row.id, kind: 'manual', status: row.passed ? 'passed' : 'failed', evidence: resolve(row.evidence), evidence_sha256: hash(readFileSync(row.evidence)) })
  }
  const output = join(home, 'dispatch-experiments/evaluations', config.run_id); mkdirSync(output, { recursive: true })
  const checks: CheckResult[] = suite.checks.map(check => {
    const prior = previous?.checks.find(row => row.id === check.id)
    if (prior && prior.status !== 'pending') {
      if (supplied.has(check.id)) throw new Error('EXPERIMENT_MANUAL_RESULT_LOCKED')
      return prior
    }
    if (check.kind === 'manual') return supplied.get(check.id) ?? { id: check.id, kind: check.kind, status: 'pending' }
    const expand = (arg: string) => arg.replaceAll('{product}', project.root_path).replaceAll('{suite}', suitePath(home))
    const start = Date.now()
    const result = spawnSync(expand(check.command!), check.args!.map(expand), { cwd: project.root_path, shell: false, windowsHide: true,
      timeout: check.timeout_ms, maxBuffer: 1_048_576, encoding: 'utf8', env: { ...process.env, ...pythonEncodingEnv(process.env), PYTHONDONTWRITEBYTECODE: '1', APP_DATA_DIR: join(output, 'app-data') } })
    const log = join(output, `${check.id}.json`)
    const bytes = JSON.stringify({ stdout: result.stdout, stderr: result.stderr, error_code: result.error && (result.error as NodeJS.ErrnoException).code, signal: result.signal, exit_code: result.status })
    writeFileSync(log, bytes, { flag: 'wx' })
    return { id: check.id, kind: check.kind, status: result.error || result.signal ? 'error' : result.status === 0 ? 'passed' : 'failed',
      exit_code: result.status, duration_ms: Date.now() - start, evidence: log, evidence_sha256: hash(bytes) }
  })
  assertExperimentEvaluator(home, config.evaluator_hash)
  if (fingerprint(files(project.root_path, true)) !== productHash) throw new Error('EXPERIMENT_PRODUCT_CHANGED_DURING_EVALUATION')
  const evaluation = summarize(config.evaluator_hash, productHash, checks)
  recordExperiment(config, 'product_evaluated', { evaluation })
  return evaluation
}
