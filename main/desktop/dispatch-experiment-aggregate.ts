import { readFileSync } from 'node:fs'
import { reportModelExperiment } from './dispatch-experiment-report'
import { DEFAULT_EXPERIMENT_SETTINGS } from './dispatch-experiment'

const groups = ['G11', 'G12', 'G21', 'G22', 'S1', 'S2'] as const
type Report = ReturnType<typeof reportModelExperiment>
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const mean = (values: Array<number | null>) => values.length && values.every(value => value !== null) ? values.reduce<number>((sum, value) => sum + value!, 0) / values.length : null

/** Keep all rows, including failures and pending scores. Only genuinely matched, complete pairs enter metrics. */
export function aggregateModelExperiments(matrixPaths: string[]) {
  const rows: Report[] = [], seenRuns = new Set<string>()
  for (const path of matrixPaths) {
    const matrix = JSON.parse(readFileSync(path, 'utf8')) as Array<{ home: string; project_id: string; run_id: string; group: string; input_hash: string; condition_hash: string }>
    if (!Array.isArray(matrix) || matrix.length !== 6 || new Set(matrix.map(row => row.group)).size !== 6) throw new Error('EXPERIMENT_INVALID_MATRIX')
    for (const entry of matrix) {
      const row = reportModelExperiment(entry.project_id, entry.home)
      if (!row.sample || row.run_id !== entry.run_id || row.sample.group !== entry.group || row.input_hash !== entry.input_hash
        || row.condition_hash !== entry.condition_hash || seenRuns.has(row.run_id)) throw new Error('EXPERIMENT_MATRIX_RECEIPT_MISMATCH')
      seenRuns.add(row.run_id); rows.push(row)
    }
  }
  const paired = new Map<string, Report[]>()
  for (const row of rows) {
    const key = JSON.stringify([row.mode, row.sample!.task_id, row.sample!.repeat_id, row.sample!.pair_id])
    const pair = paired.get(key) ?? []; pair.push(row); paired.set(key, pair)
  }
  const complete: Report[][] = [], pending: Array<{ pair: string; reason: string }> = []
  const conditions = new Map<string, unknown>(), tasks = new Map<string, unknown>(), repetitions = new Set<string>()
  for (const [key, pair] of paired) {
    if (pair.length !== 6 || groups.some(group => pair.filter(row => row.sample!.group === group).length !== 1)) throw new Error('EXPERIMENT_PAIR_GROUP_MISMATCH')
    const get = (group: string) => pair.find(row => row.sample!.group === group)!
    const first = get('G11'), second = get('G22')
    const common = (row: Report) => [row.mode, row.input_hash, row.evaluator_hash, row.runtime_hash, row.limits, row.settings ?? DEFAULT_EXPERIMENT_SETTINGS, row.models?.verifier, row.required_writes]
    if (!first.evaluator_hash || pair.some(row => !equal(common(row), common(first)))) throw new Error('EXPERIMENT_PAIR_CONDITIONS_MISMATCH')
    const one = first.models!.executor, two = second.models!.executor
    for (const row of pair) {
      const group = row.sample!.group
      const d = ['G11', 'G12', 'S1'].includes(group) ? one : two
      const e = ['G11', 'G21', 'S1'].includes(group) ? one : two
      if (!equal(row.models!.dispatcher, d) || !equal(row.models!.executor, e)) throw new Error('EXPERIMENT_PAIR_MODEL_MISMATCH')
    }
    const experimentConditions = [first.runtime_hash, first.limits, first.settings ?? DEFAULT_EXPERIMENT_SETTINGS, one, two, first.models!.verifier, first.required_writes]
    if (conditions.has(first.mode) && !equal(conditions.get(first.mode), experimentConditions)) throw new Error('EXPERIMENT_STRATUM_CONDITIONS_MISMATCH')
    conditions.set(first.mode, experimentConditions)
    const taskKey = JSON.stringify([first.mode, first.sample!.task_id]), inputs = [first.input_hash, first.evaluator_hash]
    if (tasks.has(taskKey) && !equal(tasks.get(taskKey), inputs)) throw new Error('EXPERIMENT_REPEATED_TASK_CHANGED')
    tasks.set(taskKey, inputs)
    const repeatKey = JSON.stringify([taskKey, first.sample!.repeat_id])
    if (repetitions.has(repeatKey)) throw new Error('EXPERIMENT_DUPLICATE_REPETITION')
    repetitions.add(repeatKey)
    if (pair.some(row => !row.run_outcome || row.product_quality === null || row.product_success === null || row.malformed_events)) {
      pending.push({ pair: key, reason: 'unfinished_run_or_incomplete_evaluation_or_event_integrity' }); continue
    }
    complete.push(pair)
  }
  const strata = [...new Set(rows.map(row => row.mode))].map(mode => {
    const pairs = complete.filter(pair => pair[0].mode === mode)
    const byGroup = Object.fromEntries(groups.map(group => {
      const sample = pairs.map(pair => pair.find(row => row.sample!.group === group)!)
      return [group, { n: sample.length, success_rate: mean(sample.map(row => Number(row.product_success))),
        quality_mean: mean(sample.map(row => row.product_quality)), machine_ms_mean: mean(sample.map(row => row.machine_ms)),
        reported_tokens_mean: mean(sample.map(row => row.project_usage.complete ? row.project_usage.reported_total : null)),
        complete_usage_runs: sample.filter(row => row.project_usage.complete).length }]
    }))
    const solo = pairs.map(pair => [pair.find(row => row.sample!.group === 'S1')!, pair.find(row => row.sample!.group === 'S2')!])
    const failedOne = solo.filter(([one]) => !one.product_success), failedTwo = solo.filter(([, two]) => !two.product_success)
    const q = (group: string) => byGroup[group].quality_mean
    const diff = (a: string, b: string) => q(a) === null || q(b) === null ? null : q(a)! - q(b)!
    const best = q('G11') === null || q('G22') === null ? null : Math.max(q('G11')!, q('G22')!)
    return { mode, matched_pairs: pairs.length, groups: byGroup,
      capability_gap_signed: byGroup.S1.success_rate === null || byGroup.S2.success_rate === null ? null : byGroup.S1.success_rate - byGroup.S2.success_rate,
      rescue_S2_given_S1_failed: { denominator: failedOne.length, value: failedOne.length ? failedOne.filter(([, two]) => two.product_success).length / failedOne.length : null },
      rescue_S1_given_S2_failed: { denominator: failedTwo.length, value: failedTwo.length ? failedTwo.filter(([one]) => one.product_success).length / failedTwo.length : null },
      gain_G12_vs_G11: diff('G12', 'G11'), gain_G21_vs_G22: diff('G21', 'G22'),
      gain_G12_vs_best_homogeneous: best === null ? null : q('G12')! - best,
      gain_G21_vs_best_homogeneous: best === null ? null : q('G21')! - best }
  })
  return { version: 1, rows, pending_pairs: pending, strata,
    scope: 'Descriptive paired metrics; all failures retained. Known reported tokens are not fees. quick and longterm are separate strata.' }
}
