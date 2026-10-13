import { relative, resolve } from 'node:path'
import type { AgentLoopTool, ToolContext, ToolOutcome } from '../agent/loop/agent-loop'
import { findDelegation, restoreCompletedDelegation, stopDelegation } from '../agent/delegation/agent-collaboration'
import { recordExperiment, writeExperiment, type DispatchExperiment, type ExperimentTask } from './dispatch-experiment'
import type { PhaseNode } from './dispatcher-phases'

const pendingSlots = new WeakMap<DispatchExperiment, string>()
export function experimentChildCreated(config: DispatchExperiment, child: { delegationId: string; childSessionId: string }): void {
  const slot = pendingSlots.get(config)
  if (!slot || config.workers[slot]) throw new Error('EXPERIMENT_WORKER_REGISTRATION_MISSING')
  config.workers[slot] = { delegation_id: child.delegationId, child_session_id: child.childSessionId,
    task_ids: slot === 'all' ? config.tasks.map(task => task.id) : [slot], has_executed: true }
  try { writeExperiment(config) } catch (error) { delete config.workers[slot]; throw error }
}
export function experimentPhase(node: PhaseNode, config: DispatchExperiment): PhaseNode {
  const adapt = (text: string) => text.replaceAll('一次性委派 implement 子会话完成实现', '按冻结实验任务图委派实现子会话完成实现')
    .replace(/同一委派线(?:续接)?/g, '按实验快照恢复的委派线')
  return { ...node, taskTemplate: adapt(node.taskTemplate) + '\n' + experimentTaskBook(config),
    quickTaskTemplate: node.quickTaskTemplate ? adapt(node.quickTaskTemplate) + '\n' + experimentTaskBook(config) : undefined,
    constraints: node.constraints.map(adapt), quickConstraints: node.quickConstraints?.map(adapt) }
}

const matches = (path: string, scope: string) => path === scope || (scope.endsWith('/') && path.startsWith(scope))
function scopesOverlap(a: string[], b: string[]): boolean {
  return a.some(left => b.some(right => matches(left, right) || matches(right, left)))
}
export function experimentTaskBook(config: DispatchExperiment): string {
  return '【内部冻结调度实验】\n' +
    `run_id=${config.run_id}；策略=${config.policy}。业务要求与原生验证保持不变。\n` +
    (config.policy === 'single_worker'
      ? '只使用一名实现者；delegate_agent 的 task_id=all，一次交给它全部冻结任务，按依赖顺序实现。修复续接它。\n'
      : '最多两名实现者；delegate_agent 的 task_id 使用下列任务编号，每名固定负责一个任务。依赖未结束或写入范围重叠时不得同时启动。修复续接对应实现者。\n') +
    '角色固定 implement，模型继承父上下文，不改渠道。历史证据属于冻结来源，不能当作当前版本已通过；历史绝对路径不能继续使用，当前产物均按相对项目根操作。\n' +
    JSON.stringify(config.tasks, null, 2)
}
export function wrapExperimentDispatcherTools(tools: AgentLoopTool[], config: DispatchExperiment): AgentLoopTool[] {
  const cache = new Map<string, ToolOutcome>()
  const taskFor = (id: string): ExperimentTask[] => {
    if (config.policy === 'single_worker' && id === 'all') return config.tasks
    if (config.policy === 'parallel_workers') {
      const task = config.tasks.find(item => item.id === id)
      if (task) return [task]
    }
    throw new Error('EXPERIMENT_TASK_NOT_ASSIGNED')
  }
  const ready = (tasks: ExperimentTask[], ctx: ToolContext, own?: string): void => {
    for (const [slot, worker] of Object.entries(config.workers)) {
      if (slot === own) continue
      const record = findDelegation(ctx.sessionId, worker.delegation_id)
      if (record?.status === 'running') {
        const other = config.tasks.filter(item => worker.task_ids.includes(item.id))
        if (scopesOverlap(tasks.flatMap(item => item.writes), other.flatMap(item => item.writes))) throw new Error('EXPERIMENT_WRITE_CONFLICT_WAIT')
      }
    }
    const within = new Set(tasks.map(task => task.id))
    for (const task of tasks) for (const dependency of task.depends_on) {
      if (within.has(dependency)) continue // one worker executes its internal graph sequentially
      const worker = Object.values(config.workers).find(item => item.task_ids.includes(dependency))
      const record = worker && findDelegation(ctx.sessionId, worker.delegation_id)
      if (!worker?.has_executed || record?.status !== 'completed' || record.loopStatus !== 'completed') throw new Error('EXPERIMENT_DEPENDENCY_WAIT')
    }
  }
  return tools.map(tool => {
    if (!['delegate_agent', 'continue_delegation'].includes(tool.name)) return tool
    return { ...tool, parallelSafe: false,
      description: tool.name === 'delegate_agent' ? '执行一个冻结实验任务；task_id=all 或指定任务编号。宿主固定实现角色与模型，并复用已登记的实现者。' : tool.description,
      input_schema: tool.name === 'delegate_agent' ? { type: 'object',
        properties: { task_id: { type: 'string', enum: config.policy === 'single_worker' ? ['all'] : config.tasks.map(task => task.id) },
          role: { type: 'string', enum: ['implement'] }, task: { type: 'string', description: '已登记任务的修复反馈；首次任务由宿主提供' } },
        required: ['task_id'],
      } : tool.input_schema,
      execute: async (input, ctx) => {
        const key = ctx.toolCallId && `${tool.name}:${ctx.toolCallId}`
        if (key && cache.has(key)) return cache.get(key)!
        try {
          if (ctx.projectId !== config.project_id || ctx.sessionId !== config.parent_session_id) throw new Error('EXPERIMENT_CONTEXT_MISMATCH')
          if (input.channelId || input.modelId || (input.role && input.role !== 'implement')) throw new Error('EXPERIMENT_MODEL_OR_ROLE_OVERRIDE')
          const slot = tool.name === 'delegate_agent' ? String(input.task_id ?? '')
            : Object.keys(config.workers).find(id => config.workers[id].delegation_id === input.delegation_id)
          if (!slot) throw new Error('EXPERIMENT_WORKER_NOT_ASSIGNED')
          const tasks = taskFor(slot), existing = config.workers[slot]
          ready(tasks, ctx, slot)
          const task = tasks.map(item => `[${item.id}] ${item.instruction}\n依赖：${item.depends_on.join(',') || '无'}\n写入范围：${item.writes.join(',')}`).join('\n\n')
            + '\n公共集成与原生验证必须如实完成，执行结束不等于验收通过。'
            + (existing && typeof input.task === 'string' ? `\n本轮调度补充（不得改变冻结范围）：${input.task}` : '')
          let result: ToolOutcome
          if (existing) {
            if (!findDelegation(ctx.sessionId, existing.delegation_id)) restoreCompletedDelegation(ctx, existing.delegation_id)
            if (findDelegation(ctx.sessionId, existing.delegation_id)?.status === 'cancelled') throw new Error('EXPERIMENT_CANCELLED_WORKER_REQUIRES_NEW_RUN')
            const follow = tools.find(item => item.name === 'continue_delegation')!
            const previous = existing.has_executed
            existing.has_executed = true; writeExperiment(config)
            try { result = await follow.execute({ delegation_id: existing.delegation_id, task }, ctx) }
            catch (error) { existing.has_executed = previous; writeExperiment(config); throw error }
          } else {
            if (tool.name !== 'delegate_agent') throw new Error('EXPERIMENT_WORKER_MISSING')
            const maximum = config.policy === 'single_worker' ? 1 : 2
            if (Object.keys(config.workers).length >= maximum) throw new Error('EXPERIMENT_TOTAL_WORKER_LIMIT')
            pendingSlots.set(config, slot)
            try { result = await tool.execute({ ...input, task, role: 'implement', channelId: undefined, modelId: undefined }, ctx) }
            finally { pendingSlots.delete(config) }
            if (!result.isError) {
              const detail = result.detail
              if (typeof detail?.delegation_id !== 'string' || typeof detail.child_session_id !== 'string') throw new Error('EXPERIMENT_DELEGATION_NOT_RECORDED')
              if (!config.workers[slot]) config.workers[slot] = { delegation_id: detail.delegation_id, child_session_id: detail.child_session_id, task_ids: tasks.map(item => item.id), has_executed: true }
              try { writeExperiment(config) } catch (error) { stopDelegation(ctx.sessionId, detail.delegation_id); delete config.workers[slot]; throw error }
            }
          }
          recordExperiment(config, 'dispatch', { request_id: ctx.requestId, task_ids: tasks.map(item => item.id), slot,
            delegation_id: config.workers[slot]?.delegation_id, error: Boolean(result.isError) })
          if (key) cache.set(key, result)
          return result
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          recordExperiment(config, 'dispatch_rejected', { request_id: ctx.requestId, reason })
          return { output: reason, isError: true }
        }
      },
    }
  })
}
export function experimentTasksFinished(config: DispatchExperiment): boolean {
  return config.tasks.every(task => Object.values(config.workers).some(worker => {
    const record = findDelegation(config.parent_session_id!, worker.delegation_id)
    return worker.has_executed && worker.task_ids.includes(task.id) && record?.status === 'completed' && record.loopStatus === 'completed'
  }))
}
export function wrapExperimentWorkerTools(tools: AgentLoopTool[], config: DispatchExperiment, root: string): AgentLoopTool[] {
  return tools.map(tool => ({ ...tool, execute: async (input, ctx) => {
    const worker = Object.values(config.workers).find(item => item.child_session_id === ctx.sessionId)
    // A newly started child may ask the model before its registration reaches this wrapper;
    // tool execution happens after the parent has synchronously registered its result.
    const writes = config.tasks.filter(task => worker?.task_ids.includes(task.id)).flatMap(task => task.writes)
    if (['write_file', 'edit_file'].includes(tool.name)) {
      const raw = String(input.path ?? ''), path = relative(resolve(root), resolve(root, raw)).replaceAll('\\', '/')
      if (!worker || path.startsWith('../') || !writes.some(scope => matches(path.toLowerCase(), scope.toLowerCase()))) {
        recordExperiment(config, 'write_rejected', { session_id: ctx.sessionId, tool: tool.name, path })
        return { output: 'EXPERIMENT_WRITE_OUTSIDE_ASSIGNMENT', isError: true }
      }
    }
    return tool.execute(input, ctx)
  } }))
}
