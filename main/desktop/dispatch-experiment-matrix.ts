import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_EXPERIMENT_LIMITS, type ExperimentModel, type ExperimentLimits } from './dispatch-experiment'
import { restoreExperiment } from './dispatch-experiment-snapshot'

export function createModelMatrix(snapshot: string, destination: string,
  pair: { m1: ExperimentModel; m2: ExperimentModel; verifier: ExperimentModel }, prefix: string, workerLimit = 1,
  collection?: { task_id: string; repeat_id: string; evaluator: string }, limits?: Partial<ExperimentLimits>) {
  if (existsSync(destination) || ![1, 2, 3, 4].includes(workerLimit)) throw new Error('EXPERIMENT_MATRIX_TARGET_OR_LIMIT_INVALID')
  mkdirSync(destination, { recursive: true })
  const conditions = [
    { group: 'G11', dispatcher: pair.m1, executor: pair.m1 }, { group: 'G12', dispatcher: pair.m1, executor: pair.m2 },
    { group: 'G21', dispatcher: pair.m2, executor: pair.m1 }, { group: 'G22', dispatcher: pair.m2, executor: pair.m2 },
    { group: 'S1', dispatcher: pair.m1, executor: pair.m1 }, { group: 'S2', dispatcher: pair.m2, executor: pair.m2 },
  ]
  const result = conditions.map(condition => {
    const home = join(destination, condition.group)
    const config = restoreExperiment(snapshot, home, condition.group.startsWith('S') ? 'standalone' : 'autonomous', `${prefix}-${condition.group}`, {
      models: { dispatcher: condition.dispatcher, executor: condition.executor, verifier: pair.verifier },
      limits: { ...DEFAULT_EXPERIMENT_LIMITS, ...limits, max_workers: workerLimit },
      ...(collection ? { evaluator: collection.evaluator, sample: { task_id: collection.task_id, repeat_id: collection.repeat_id,
        pair_id: prefix, group: condition.group as 'G11' | 'G12' | 'G21' | 'G22' | 'S1' | 'S2' } } : {}),
    })
    return { group: condition.group, home, run_id: config.run_id, policy: config.policy, mode: config.mode,
      project_id: config.project_id, sample: config.sample, evaluator_hash: config.evaluator_hash,
      models: config.models, input_hash: config.input_hash, condition_hash: config.condition_hash }
  })
  writeFileSync(join(destination, 'matrix.json'), JSON.stringify(result, null, 2), { flag: 'wx' })
  return result
}
