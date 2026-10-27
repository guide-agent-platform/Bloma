import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertExperimentHome, experimentPath, validateExperiment } from '../main/desktop/dispatch-experiment'
import { reportModelExperiment } from '../main/desktop/dispatch-experiment-report'
import { aggregateModelExperiments } from '../main/desktop/dispatch-experiment-aggregate'

const [command, ...args] = process.argv.slice(2)
const option = (name: string): string => {
  const index = args.indexOf(`--${name}`)
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing --${name}`)
  return args[index + 1]
}
const optional = (name: string) => args.includes(`--${name}`) ? option(name) : undefined
try {
  if(!['inspect','report','aggregate'].includes(command))throw Error('LEGACY_EXPERIMENT_EXECUTION_RETIRED: only inspect, report and aggregate remain available; evidence and ledgers are unchanged')
  const home = resolve(option('home'))
  process.env.PROMA_HOME = home
  if (command === 'aggregate') {
    const report = aggregateModelExperiments(JSON.parse(readFileSync(option('matrices'), 'utf8')))
    if (optional('out')) writeFileSync(option('out'), JSON.stringify(report, null, 2), { flag: 'wx' })
    if (optional('csv')) {
      const columns = ['task_id', 'repeat_id', 'pair_id', 'group', 'mode', 'run_id', 'run_outcome', 'termination_reason', 'product_quality', 'product_success',
        'machine_ms', 'time_to_ready_ms', 'reported_tokens', 'usage_complete', 'input_hash', 'evaluator_hash']
      const quote = (value: unknown) => value === null || value === undefined ? '' : `"${String(value).replaceAll('"', '""')}"`
      const values = report.rows.map(row => [row.sample!.task_id, row.sample!.repeat_id, row.sample!.pair_id, row.sample!.group, row.mode, row.run_id,
        row.run_outcome, row.termination_reason, row.product_quality, row.product_success, row.machine_ms, row.time_to_ready_ms,
        row.project_usage.complete ? row.project_usage.reported_total : null, row.project_usage.complete, row.input_hash, row.evaluator_hash])
      writeFileSync(option('csv'), '\uFEFF' + [columns, ...values].map(row => row.map(quote).join(',')).join('\r\n') + '\r\n', { flag: 'wx' })
    }
    console.log(JSON.stringify(report))
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
  } else throw new Error('Usage: inspect|report|aggregate --home <isolated-home> ...')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1
}
