import type { AgentLoopInput, AgentLoopTool } from '../agent/loop/agent-loop'
import { loadChildSessionSnapshot, replayTurnsFrom } from '../agent/delegation/delegation-persistence'
import type { DesktopDispatchRunInput } from './dispatcher-loop'
import { buildAdvanceProtocolSection, buildDesktopChildBaseSystem, renderTaskTemplate } from './dispatcher-prompt'
import type { PhaseNode } from './dispatcher-phases'
import { experimentLimits, recordExperiment, type DispatchExperiment } from './dispatch-experiment'
import { bindExperimentWorkers, experimentRunSignal, guardExperimentQuery, lockExperimentModel } from './dispatch-experiment-models'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'

export function experimentInputsIntact(config: DispatchExperiment): boolean {
  return Object.entries(config.protected_inputs ?? {}).every(([relative, hash]) => {
    const path = join(getPromaHome(), relative)
    return existsSync(path) && createHash('sha256').update(readFileSync(path)).digest('hex') === hash
  })
}

export function bindExperimentInput(input: DesktopDispatchRunInput, config: DispatchExperiment, stage: 'implement' | 'verify'): DesktopDispatchRunInput {
  if (!experimentInputsIntact(config)) throw new Error('EXPERIMENT_FROZEN_INPUT_CHANGED')
  if (config.mode !== (input.quickMode ? 'quick' : 'longterm') || config.parent_session_id !== input.sessionId) throw new Error('EXPERIMENT_CONTEXT_MISMATCH')
  const signal = experimentRunSignal(config, input.signal)
  const role = stage === 'verify' ? 'verifier' : config.policy === 'standalone' ? 'executor' : 'dispatcher'
  const binding = lockExperimentModel(config, role)
  const limits = experimentLimits(config)
  if (stage === 'implement' && config.policy !== 'standalone') bindExperimentWorkers(config)
  return { ...input, env: binding.env, query: guardExperimentQuery(input.query, config, stage),
    signal, providerType: binding.providerType,
    maxTokens: Math.min(input.maxTokens, binding.maxTokens ?? input.maxTokens),
    maxTurns: Math.min(input.maxTurns ?? 100, config.policy === 'standalone' && stage === 'implement' ? limits.executor_turns : limits.dispatcher_turns) }
}
export function standaloneSystem(node: PhaseNode, input: DesktopDispatchRunInput): string {
  const template = input.quickMode && node.quickTaskTemplate ? node.quickTaskTemplate : node.taskTemplate
  return buildDesktopChildBaseSystem(node, input) + '\n' + renderTaskTemplate(template, { project_name: input.projectName, shape_brief: input.shapeBrief ?? '' }).text
    + '\n' + buildAdvanceProtocolSection(node)
}
export function standaloneTools(tools: AgentLoopTool[]): AgentLoopTool[] {
  return tools.filter(tool => !['delegate_agent', 'continue_delegation', 'ask_delegation_question', 'wait_for_delegations', 'get_delegation_results'].includes(tool.name))
}
export function standaloneHistory(config: DispatchExperiment): AgentLoopInput['historyTurns'] {
  const seed = config.workers.seed
  if (!seed) return undefined
  const snapshot = loadChildSessionSnapshot(seed.child_session_id)
  if (snapshot.lastSettle?.taskHandoff?.loop_status !== 'completed') throw new Error('EXPERIMENT_HANDOFF_NOT_COMPLETED')
  recordExperiment(config, 'standalone_history', { source_session_id: seed.child_session_id })
  return replayTurnsFrom(snapshot.messages)
}
