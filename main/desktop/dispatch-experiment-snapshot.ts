/** Frozen isolated homes retain entity IDs; runtime requests are new and scoped by run_id. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { installExperimentEvaluator } from './dispatch-experiment-evaluator'
import { assertExperimentHome, assertExperimentId, experimentConditionHash, EXPERIMENT_POLICIES, experimentPath, recordExperiment, validateExperiment, writeExperiment, type DispatchExperiment, type ExperimentLimits, type ExperimentModels, type ExperimentPolicy, type ExperimentSettings, type ExperimentTask } from './dispatch-experiment'

interface FrozenManifest { version: 1; snapshot_id: string; source_home: string; project_id: string; parent_session_id: string;
  mode: 'quick' | 'longterm'; input_hash: string; files: Record<string, string>; skipped: string[]; config: DispatchExperiment }
// Adapted from Proma agent-fork-workspace-copy.ts; never copy environments or build caches.
const excluded = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__', '.cache', 'dist', 'build'])
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const manifestHash = (value: Pick<FrozenManifest, 'files' | 'config' | 'project_id' | 'parent_session_id' | 'mode'>) =>
  sha(JSON.stringify({ files: value.files, config: value.config, project_id: value.project_id, parent_session_id: value.parent_session_id, mode: value.mode }))
const inside = (parent: string, child: string) => { const rel = relative(resolve(parent), resolve(child)); return rel === '' || (!rel.startsWith('..') && !resolve(child).startsWith('\\\\') && !/^[A-Za-z]:/.test(rel)) }
function copyTree(source: string, target: string, files: Record<string, string>, prefix: string, skipped: string[]): void {
  const stat = lstatSync(source)
  if (stat.isSymbolicLink()) throw new Error('EXPERIMENT_LINK_NOT_PORTABLE')
  if (excluded.has(source.split(/[\\/]/).pop()!.toLowerCase())) { skipped.push(prefix); return }
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true })
    for (const name of readdirSync(source).sort()) copyTree(join(source, name), join(target, name), files, `${prefix}/${name}`, skipped)
  } else if (stat.isFile()) {
    const bytes = readFileSync(source); files[prefix] = sha(bytes)
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes, { flag: 'wx' })
  } else throw new Error('EXPERIMENT_UNSUPPORTED_FILE')
}
function assertNativeProject(home: string, projectId: string): Record<string, unknown> {
  const index = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8'))
  const project = index.projects?.find((item: { project_id: string }) => item.project_id === projectId)
  if (!project || index.projects.length !== 1) throw new Error('EXPERIMENT_HOME_MUST_CONTAIN_ONE_PROJECT')
  const expected = join(home, 'agent-workspaces', project.workspace_slug, 'generated-projects', projectId)
  if (resolve(project.root_path).toLowerCase() !== resolve(expected).toLowerCase()) throw new Error('EXPERIMENT_PROJECT_ROOT_MISMATCH')
  return project
}
export function freezeExperiment(home: string, projectId: string, destination: string, tasks: ExperimentTask[], seedDelegationId?: string): FrozenManifest {
  assertExperimentHome(home); assertExperimentId(projectId)
  if (inside(home, destination) || inside(destination, home) || existsSync(destination)) throw new Error('EXPERIMENT_SNAPSHOT_TARGET_NOT_FRESH')
  const config = validateExperiment(JSON.parse(readFileSync(experimentPath(projectId, home), 'utf8')))
  const project = assertNativeProject(home, projectId)
  if (config.state !== 'prepared' || !config.prepared || !config.parent_session_id || project.desktop_phase !== 'desktop-implement'
    || config.mode !== project.mode) throw new Error('EXPERIMENT_NOT_PREPARED')
  const sessions = JSON.parse(readFileSync(join(home, 'bloma-agent-sessions.json'), 'utf8'))
  if (!Array.isArray(sessions.sessions) || sessions.sessions.some((s: { project_id: string }) => s.project_id !== projectId)) throw new Error('EXPERIMENT_FOREIGN_SESSION')
  if (!sessions.sessions?.some((s: { session_id: string; project_id: string }) => s.session_id === config.parent_session_id && s.project_id === projectId)) throw new Error('EXPERIMENT_PARENT_HISTORY_MISSING')
  config.tasks = tasks; config.workers = {}
  const bundle = resolve('dist-main/main/index.js')
  if (existsSync(bundle)) config.runtime_hash = sha(readFileSync(bundle))
  if (config.mode === 'longterm' && !seedDelegationId) throw new Error('EXPERIMENT_SCAFFOLD_HANDOFF_REQUIRED')
  if (seedDelegationId) {
    const seed = sessions.sessions.find((s: { source_delegation_id: string; parent_session_id: string; project_id: string }) => s.source_delegation_id === seedDelegationId && s.parent_session_id === config.parent_session_id && s.project_id === projectId)
    if (!seed) throw new Error('EXPERIMENT_HANDOFF_OWNERSHIP_MISMATCH')
    const rows = readFileSync(join(home, 'agent-sessions', `${seed.session_id}.jsonl`), 'utf8').trim().split('\n').map(row => JSON.parse(row))
    if (rows.at(-1)?.delegation_settle !== 'completed' || rows.at(-1)?.loop_status !== 'completed') throw new Error('EXPERIMENT_HANDOFF_UNFINISHED')
    config.workers.seed = { delegation_id: seedDelegationId, child_session_id: seed.session_id, task_ids: [] }
  }
  validateExperiment(config)
  if (config.planning === 'autonomous' ? tasks.length !== 0 : tasks.length !== 2) throw new Error('EXPERIMENT_FROZEN_PLANNING_MISMATCH')
  const workspace = join('agent-workspaces', String(project.workspace_slug))
  const roots = [join(workspace, 'generated-projects', projectId), join(workspace, 'documents', projectId), 'agent-sessions', 'prompts', 'templates', 'bloma-composer', 'pasted-images']
  const files: Record<string, string> = {}, skipped: string[] = []
  mkdirSync(destination, { recursive: false })
  for (const root of roots) if (existsSync(join(home, root))) copyTree(join(home, root), join(destination, 'home', root), files, root.replaceAll('\\', '/'), skipped)
  for (const name of ['projects.json', 'bloma-agent-sessions.json', 'category-routing.json']) if (existsSync(join(home, name))) copyTree(join(home, name), join(destination, 'home', name), files, name, skipped)
  const snapshotId = randomUUID()
  const manifest: FrozenManifest = { version: 1, snapshot_id: snapshotId, source_home: resolve(home), project_id: projectId,
    parent_session_id: config.parent_session_id, mode: config.mode, files, skipped, config,
    input_hash: '' }
  manifest.input_hash = manifestHash(manifest)
  writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' })
  recordExperiment(config, 'frozen', { snapshot_id: snapshotId, input_hash: manifest.input_hash, skipped }, home)
  return manifest
}
export function restoreExperiment(snapshot: string, home: string, policy: ExperimentPolicy, runId: string,
  options: { models?: ExperimentModels; limits?: ExperimentLimits; settings?: ExperimentSettings; evaluator?: string; sample?: DispatchExperiment['sample'] } = {}): DispatchExperiment {
  assertExperimentId(runId)
  if (!(EXPERIMENT_POLICIES as readonly string[]).includes(policy) || existsSync(home) || inside(snapshot, home) || inside(home, snapshot)) throw new Error('EXPERIMENT_RESTORE_TARGET_NOT_FRESH')
  const manifest = JSON.parse(readFileSync(join(snapshot, 'manifest.json'), 'utf8')) as FrozenManifest
  if (manifest.version !== 1 || manifest.input_hash !== manifestHash(manifest)) throw new Error('EXPERIMENT_SNAPSHOT_CHANGED')
  validateExperiment(manifest.config)
  assertExperimentId(manifest.snapshot_id)
  if (manifest.project_id !== manifest.config.project_id || manifest.parent_session_id !== manifest.config.parent_session_id || manifest.mode !== manifest.config.mode) throw new Error('EXPERIMENT_MANIFEST_MISMATCH')
  const modern = policy === 'autonomous' || policy === 'standalone'
  if (modern !== (manifest.config.planning === 'autonomous')) throw new Error('EXPERIMENT_RESTORE_PLANNING_MISMATCH')
  const workers = structuredClone(manifest.config.workers)
  if (workers.seed && policy !== 'standalone') {
    const seed = workers.seed; delete workers.seed
    seed.task_ids = policy === 'autonomous' ? [] : policy === 'single_worker' ? manifest.config.tasks.map(task => task.id) : [manifest.config.tasks[0].id]
    workers[policy === 'autonomous' ? 'worker-1' : policy === 'single_worker' ? 'all' : manifest.config.tasks[0].id] = seed
  }
  const { evaluator, ...conditions } = options
  const config: DispatchExperiment = { ...manifest.config, workers, state: 'running', policy, run_id: runId,
    snapshot_id: manifest.snapshot_id, input_hash: manifest.input_hash, ...structuredClone(conditions) }
  config.protected_inputs = Object.fromEntries(Object.entries(manifest.files).filter(([path]) =>
    path.endsWith(`/documents/${manifest.project_id}/prd.json`) || path.endsWith(`/documents/${manifest.project_id}/prd.md`)
    || path.includes(`/documents/${manifest.project_id}/features/`) || /\/00_UX\/confirmed\.(html|json)$/.test(path)
    || /\/00_ARCH\/architecture\.(md|json)$/.test(path) || path.endsWith('/00_SCAFFOLD/contract.json') || path.startsWith('prompts/')))
  delete config.started_at; delete config.request_count; delete config.observed_models; delete config.plan_locked
  config.condition_hash = experimentConditionHash(config)
  validateExperiment(config)
  for (const [path, hash] of Object.entries(manifest.files)) {
    const parts = path.split(/[\\/]/)
    if (parts.some(part => !part || part === '.' || part === '..') || !inside(join(snapshot, 'home'), join(snapshot, 'home', path))
      || parts.some((_, index) => lstatSync(join(snapshot, 'home', ...parts.slice(0, index + 1))).isSymbolicLink())
      || sha(readFileSync(join(snapshot, 'home', path))) !== hash) throw new Error('EXPERIMENT_SNAPSHOT_CHANGED')
  }
  mkdirSync(home, { recursive: false })
  // Copy the manifest whitelist only. Unlisted files, credentials and old usage are never restored.
  for (const path of Object.keys(manifest.files)) {
    const target = join(home, path); mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(join(snapshot, 'home', path)), { flag: 'wx' })
  }
  writeFileSync(join(home, 'dispatch-experiment-home.json'), '{"version":1}\n', { flag: 'wx' })
  const index = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8'))
  const project = index.projects[0]
  project.root_path = join(resolve(home), 'agent-workspaces', project.workspace_slug, 'generated-projects', manifest.project_id)
  project.status = 'active'; project.current_stage = 'generating_mvp'; project.desktop_phase = 'desktop-implement'
  delete project.desktop_checkpoint; delete project.desktop_blocked; delete project.delivery_status
  writeFileSync(join(home, 'projects.json'), JSON.stringify(index, null, 2))
  const sessions = JSON.parse(readFileSync(join(home, 'bloma-agent-sessions.json'), 'utf8'))
  for (const session of sessions.sessions) session.jsonl_path = join(resolve(home), 'agent-sessions', `${session.session_id}.jsonl`)
  writeFileSync(join(home, 'bloma-agent-sessions.json'), JSON.stringify(sessions, null, 2))
  if (evaluator) {
    config.evaluator_hash = installExperimentEvaluator(evaluator, home)
    config.condition_hash = experimentConditionHash(config)
  }
  writeExperiment(config, home)
  recordExperiment(config, 'restored', { input_hash: config.input_hash, parent_session_id: config.parent_session_id, environment_rebuild_required: true }, home)
  return config
}
