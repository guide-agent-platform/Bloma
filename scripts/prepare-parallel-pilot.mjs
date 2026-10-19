// Offline only. Re-freeze existing business inputs against the current runtime.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const args = process.argv.slice(2)
const option = name => { const i = args.indexOf(`--${name}`); if (i < 0 || !args[i + 1]) throw Error(`Missing --${name}`); return resolve(args[i + 1]) }
const source = option('source-snapshot'), evaluator = option('evaluator'), out = option('out')
const prefixIndex = args.indexOf('--run-prefix')
const prefix = prefixIndex < 0 ? 'parallel-L2-20261018-r1' : args[prefixIndex + 1]
if (!/^[A-Za-z0-9_-]{1,70}$/.test(prefix ?? '')) throw Error('INVALID_RUN_PREFIX')
const taskIndex = args.indexOf('--task-id')
const taskId = taskIndex < 0 ? 'L2-v2-parallel' : args[taskIndex + 1]
if (!/^[A-Za-z0-9_-]{1,80}$/.test(taskId ?? '')) throw Error('INVALID_TASK_ID')
if (existsSync(out)) throw Error('PRESERVE_EXISTING_PILOT')
mkdirSync(out, { recursive: true })
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
const put = (name, value) => writeFileSync(join(out, name), JSON.stringify(value, null, 2), { flag: 'wx' })
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const cli = args => JSON.parse(execFileSync(process.execPath, ['scripts/dispatch-experiment.mjs', ...args], { windowsHide: true, encoding: 'utf8', maxBuffer: 12000000 }))
const prior = read(join(source, 'manifest.json')), project = prior.project_id
const stage = join(out, 'stage')
const pairIndex = args.indexOf('--model-pair-file')
const pair = pairIndex < 0
  ? { m1: { channel_id: 'experiment-ds', model_id: 'deepseek-flash' }, m2: { channel_id: 'experiment-glm', model_id: 'glm-5.3' }, verifier: { channel_id: 'experiment-ds', model_id: 'deepseek-flash' } }
  : read(resolve(args[pairIndex + 1]))
for (const role of ['m1', 'm2', 'verifier']) {
  if (!pair[role] || !/^[A-Za-z0-9._-]+$/.test(pair[role].channel_id ?? '') || !/^[A-Za-z0-9._-]+$/.test(pair[role].model_id ?? '')) throw Error('INVALID_MODEL_PAIR')
}
const limits = { max_workers: 2, max_tasks: 16, dispatcher_turns: 60, executor_turns: 100, max_requests: 256, max_output_tokens: 640000, wall_ms: 3600000 }
const settings = { temperature: 0.1, thinking_level: 'high', response_header_timeout_ms: 120000 }
put('models.json', pair); put('limits.json', limits)
put('stage-models.json', { dispatcher: pair.m1, executor: pair.m1, verifier: pair.verifier })
cli(['restore', '--home', stage, '--snapshot', source, '--policy', 'autonomous', '--run', `${prefix}-stage`, '--models', join(out, 'stage-models.json'), '--limits', join(out, 'limits.json')])
const configPath = join(stage, 'dispatch-experiments', `${project}.json`), config = read(configPath)
Object.assign(config, { state: 'prepared', experiment_id: prefix, run_id: `${prefix}-prepare`, settings })
for (const name of ['policy', 'models', 'limits', 'protected_inputs', 'required_writes', 'condition_hash', 'input_hash', 'snapshot_id', 'started_at', 'request_count', 'observed_models', 'sample', 'evaluator_hash']) delete config[name]
writeFileSync(configPath, JSON.stringify(config, null, 2))
cpSync(evaluator, join(out, 'evaluator'), { recursive: true, errorOnExist: true, force: false })
const frozen = cli(['freeze', '--home', stage, '--project', project, '--out', join(out, 'snapshot')])
const matrix = cli(['matrix', '--home', join(out, 'cohort'), '--snapshot', join(out, 'snapshot'), '--models', join(out, 'models.json'),
  '--run-prefix', prefix, '--worker-limit', '2', '--limits', join(out, 'limits.json'),
  '--evaluator', join(out, 'evaluator'), '--task', taskId, '--repeat', 'r1'])
const manifest = read(join(out, 'snapshot', 'manifest.json'))
const business = Object.entries(prior.files).filter(([path]) => path.includes('/documents/') || path.includes('/generated-projects/'))
if (business.some(([path, hash]) => manifest.files[path] !== hash)) throw Error('BUSINESS_INPUT_CHANGED')
for (const row of matrix) {
  const config = read(join(row.home, 'dispatch-experiments', `${project}.json`))
  if (config.runtime_hash !== sha('dist-main/main/index.js') || config.limits.max_workers !== 2 || JSON.stringify(config.settings) !== JSON.stringify(settings)) throw Error('PILOT_CONDITIONS_MISMATCH')
  const events = readFileSync(join(row.home, 'dispatch-experiments', 'events', `${row.run_id}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse)
  if (events.some(event => event.event === 'model_request')) throw Error('UNEXPECTED_MODEL_REQUEST')
  writeFileSync(join(row.home, 'continuation.txt'), row.group.startsWith('G')
    ? '请继续完成已确认需求。本轮调度预实验要求使用两名实现者并行协作；任务分解、依赖、写入范围、集成与修复由你决定，不改变业务范围。\n'
    : '请继续直接完成已确认需求、真实验证与交付。\n', { flag: 'wx' })
}
const registry = { status: 'prepared-not-started', at: new Date().toISOString(), project_id: project,
  source_snapshot: source, input_hash: frozen.input_hash, runtime_sha256: sha('dist-main/main/index.js'),
  code_base: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), models: pair, settings, limits, matrix,
  actual_model_calls: 0, business_input_unchanged: true, group_concurrency: 1, glm_plan: 'coding', worktree_isolation: false,
  monetary_mode: 'unlimited-explicit-user-authorization-20261018',
  note: 'G groups require two implementers but choose their own decomposition. Verify actual worker/HTTP overlap; capacity alone is insufficient. Old results are historical only. User explicitly removed monetary ceilings; retain usage ledgers and all old liabilities.' }
put('registry.json', registry)
console.log(JSON.stringify({ registry: join(out, 'registry.json'), input_hash: registry.input_hash, groups: matrix.map(row => row.group), actual_model_calls: 0 }))
