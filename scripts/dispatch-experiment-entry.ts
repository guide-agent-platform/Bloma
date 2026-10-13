import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { assertExperimentId, assertExperimentHome, experimentPath, recordExperiment, validateExperiment, writeExperiment, type ExperimentPolicy } from '../main/desktop/dispatch-experiment'
import { freezeExperiment, restoreExperiment } from '../main/desktop/dispatch-experiment-snapshot'
import { createModelMatrix } from '../main/desktop/dispatch-experiment-matrix'
import { reportModelExperiment } from '../main/desktop/dispatch-experiment-report'

const [command, ...args] = process.argv.slice(2)
const option = (name: string): string => {
  const index = args.indexOf(`--${name}`)
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing --${name}`)
  return args[index + 1]
}
const optional = (name: string) => args.includes(`--${name}`) ? option(name) : undefined
try {
  const home = resolve(option('home'))
  process.env.PROMA_HOME = home
  if (command === 'prepare') {
    if (home.toLowerCase() === resolve(join(homedir(), '.proma')).toLowerCase()) throw new Error('EXPERIMENT_REQUIRES_ISOLATED_HOME')
    const projectId = assertExperimentId(option('project'))
    const index = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8'))
    const project = index.projects?.find((item: { project_id: string }) => item.project_id === projectId)
    if (!project || index.projects.length !== 1 || !['quick', 'longterm'].includes(project.mode)) throw new Error('EXPERIMENT_HOME_MUST_CONTAIN_ONE_PROJECT')
    if (existsSync(experimentPath(projectId, home))) throw new Error('EXPERIMENT_CONFIG_EXISTS')
    if (!existsSync(join(home, 'dispatch-experiment-home.json'))) writeFileSync(join(home, 'dispatch-experiment-home.json'), '{"version":1}\n', { flag: 'wx' })
    const experimentId = assertExperimentId(option('experiment'))
    const config = validateExperiment({ version: 1, project_id: projectId, mode: project.mode, experiment_id: experimentId,
      run_id: `${experimentId}-prepare`, state: 'prepare', planning: optional('planning') ?? 'autonomous', tasks: [], workers: {} })
    writeExperiment(config, home); recordExperiment(config, 'prepare_started', {}, home)
    console.log(JSON.stringify({ state: 'prepare', project_id: projectId, mode: project.mode }))
  } else if (command === 'freeze') {
    const tasks = optional('tasks') ? JSON.parse(readFileSync(option('tasks'), 'utf8')) : []
    const manifest = freezeExperiment(home, option('project'), resolve(option('out')), tasks, optional('seed-worker'))
    console.log(JSON.stringify({ snapshot_id: manifest.snapshot_id, input_hash: manifest.input_hash, skipped: manifest.skipped }))
  } else if (command === 'restore') {
    mkdirSync(join(home, '..'), { recursive: true })
    const config = restoreExperiment(resolve(option('snapshot')), home, option('policy') as ExperimentPolicy, option('run'), {
      ...(optional('models') ? { models: JSON.parse(readFileSync(option('models'), 'utf8')) } : {}),
      ...(optional('limits') ? { limits: JSON.parse(readFileSync(option('limits'), 'utf8')) } : {}),
      ...(optional('settings') ? { settings: JSON.parse(readFileSync(option('settings'), 'utf8')) } : {}),
    })
    console.log(JSON.stringify({ state: config.state, run_id: config.run_id, project_id: config.project_id, parent_session_id: config.parent_session_id, policy: config.policy, input_hash: config.input_hash }))
  } else if (command === 'matrix') {
    console.log(JSON.stringify(createModelMatrix(resolve(option('snapshot')), home,
      JSON.parse(readFileSync(option('models'), 'utf8')), option('run-prefix'), Number(optional('worker-limit') ?? '1'))))
  } else if (command === 'report') {
    assertExperimentHome(home)
    const report = reportModelExperiment(option('project'))
    if (optional('out')) writeFileSync(option('out'), JSON.stringify(report, null, 2), { flag: 'wx' })
    console.log(JSON.stringify(report))
  } else if (command === 'inspect') {
    assertExperimentHome(home)
    const config = validateExperiment(JSON.parse(readFileSync(experimentPath(option('project'), home), 'utf8')))
    console.log(JSON.stringify({ state: config.state, mode: config.mode, run_id: config.run_id, policy: config.policy,
      workers: config.workers, parent_session_id: config.parent_session_id, input_hash: config.input_hash, condition_hash: config.condition_hash, models: config.models, limits: config.limits }))
  } else throw new Error('Usage: prepare|freeze|restore|matrix|inspect|report --home <isolated-home> ...')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1
}
