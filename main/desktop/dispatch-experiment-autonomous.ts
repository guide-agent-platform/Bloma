import type { AgentLoopTool, ToolContext, ToolOutcome } from '../agent/loop/agent-loop'
import { findDelegation } from '../agent/delegation/agent-collaboration'
import { experimentLimits, recordExperiment, validateExperimentTasks, writeExperiment, type DispatchExperiment, type ExperimentTask } from './dispatch-experiment'

export function autonomousTaskBook(config: DispatchExperiment): string {
  const limits = experimentLimits(config)
  return '【调度实验运行协议】\n' +
    `需求、初始产物和验收已冻结。自行制定任务分解，使用 experiment_plan 登记任务、依赖与写入范围；不规定任务数量或具体拆分答案。\n` +
    `实现者最多 ${limits.max_workers} 名，任务登记最多 ${limits.max_tasks} 项。delegate_agent 用 task_ids 分配任务；continue_delegation 可分配尚未执行的已登记任务或发送修复反馈。\n` +
    '角色、模型由宿主实验配置绑定，不自行修改。规划登记只定义执行协议，不表示任务或产物已验收；是否启动、分配、等待、集成和修复由你决定。历史证据不是当前版本已通过证明。'
}
export function wrapAutonomousDispatcherTools(tools: AgentLoopTool[], config: DispatchExperiment,
  create: (slot: string, ids: string[], action: () => Promise<ToolOutcome>) => Promise<ToolOutcome>,
  modelArgs: () => { channelId?: string; modelId?: string }, bindWorkers: () => void): AgentLoopTool[] {
  const cache = new Map<string, ToolOutcome>()
  const plan: AgentLoopTool = { name: 'experiment_plan', description: '登记你自行产生的任务分解。第一次派遣后计划锁定，修复沿已登记任务进行。',
    input_schema: { type: 'object', properties: { tasks: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, instruction: { type: 'string' }, depends_on: { type: 'array', items: { type: 'string' } }, writes: { type: 'array', items: { type: 'string' } },
    }, required: ['id', 'instruction', 'depends_on', 'writes'] } } }, required: ['tasks'] },
    execute: async (input, ctx) => {
      try {
        if (ctx.projectId !== config.project_id || ctx.sessionId !== config.parent_session_id) throw new Error('EXPERIMENT_CONTEXT_MISMATCH')
        if (config.plan_locked) throw new Error('EXPERIMENT_PLAN_ALREADY_DISPATCHED')
        const tasks = input.tasks as ExperimentTask[]
        validateExperimentTasks(tasks, experimentLimits(config).max_tasks)
        if (!tasks.length) throw new Error('EXPERIMENT_EMPTY_PLAN')
        config.tasks = structuredClone(tasks); writeExperiment(config)
        recordExperiment(config, 'plan_declared', { request_id: ctx.requestId, tasks: config.tasks })
        return { output: `计划已登记，共 ${tasks.length} 项。登记不代表已执行或已验收。` }
      } catch (error) { return rejected(config, error, ctx) }
    } }
  return [...tools.map(tool => {
    if (!['delegate_agent', 'continue_delegation'].includes(tool.name)) return tool
    const initial = tool.name === 'delegate_agent'
    return { ...tool, parallelSafe: false,
      description: initial ? '把已登记的任务分配给一名实现者；人数、角色和模型由宿主限定。' : '续接已有实现者，分配已登记任务或给出修复反馈。',
      input_schema: { type: 'object', properties: { task_ids: { type: 'array', items: { type: 'string' } }, task: { type: 'string' },
        ...(initial ? {} : { delegation_id: { type: 'string' } }) }, required: initial ? ['task_ids'] : ['delegation_id'] },
      execute: async (input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> => {
        const key = ctx.toolCallId && `${tool.name}:${ctx.toolCallId}`
        if (key && cache.has(key)) return cache.get(key)!
        try {
          if (ctx.projectId !== config.project_id || ctx.sessionId !== config.parent_session_id) throw new Error('EXPERIMENT_CONTEXT_MISMATCH')
          if (input.channelId || input.modelId || (input.role && input.role !== 'implement')) throw new Error('EXPERIMENT_MODEL_OR_ROLE_OVERRIDE')
          bindWorkers()
          const slot = initial ? Object.keys(config.workers).find(id => !config.workers[id].has_executed)
            : Object.keys(config.workers).find(id => config.workers[id].delegation_id === input.delegation_id)
          const existing = slot ? config.workers[slot] : undefined
          const ids = input.task_ids === undefined && existing ? existing.task_ids : input.task_ids as string[]
          if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !config.tasks.some(task => task.id === id))) throw new Error('EXPERIMENT_TASK_NOT_ASSIGNED')
          const selected = config.tasks.filter(task => ids.includes(task.id))
          const old = existing?.task_ids ?? []
          const inside = new Set(ids)
          for (const task of selected) for (const dependency of task.depends_on) {
            if (inside.has(dependency)) continue
            const owner = Object.values(config.workers).find(worker => worker.task_ids.includes(dependency))
            const record = owner && findDelegation(ctx.sessionId, owner.delegation_id)
            if (!owner?.has_executed || record?.status !== 'completed' || record.loopStatus !== 'completed') throw new Error('EXPERIMENT_DEPENDENCY_WAIT')
          }
          const scopes = selected.flatMap(task => task.writes).map(path => path.toLowerCase())
          for (const worker of Object.values(config.workers)) {
            if (worker === existing) continue
            if (ids.some(id => worker.task_ids.includes(id))) throw new Error('EXPERIMENT_TASK_HAS_OWNER')
            if (findDelegation(ctx.sessionId, worker.delegation_id)?.status === 'running') {
              const other = config.tasks.filter(task => worker.task_ids.includes(task.id)).flatMap(task => task.writes).map(path => path.toLowerCase())
              if (scopes.some(a => other.some(b => a === b || (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b))))) throw new Error('EXPERIMENT_WRITE_CONFLICT_WAIT')
            }
          }
          config.plan_locked = true
          let result: ToolOutcome
          const instruction = selected.map(task => `[${task.id}] ${task.instruction}\n依赖：${task.depends_on.join(',')}\n写入范围：${task.writes.join(',')}`).join('\n\n')
            + (typeof input.task === 'string' ? `\n调度反馈（保持已确认需求）：${input.task}` : '')
          if (existing) {
            const status = findDelegation(ctx.sessionId, existing.delegation_id)?.status
            if (status === 'running') throw new Error('EXPERIMENT_WORKER_STILL_RUNNING')
            if (status === 'cancelled') throw new Error('EXPERIMENT_CANCELLED_WORKER_REQUIRES_NEW_RUN')
            const previous = existing.has_executed
            existing.task_ids = [...new Set([...old, ...ids])]; existing.has_executed = true; writeExperiment(config)
            try { result = await tools.find(item => item.name === 'continue_delegation')!.execute({ delegation_id: existing.delegation_id, task: instruction }, ctx) }
            catch (error) { existing.task_ids = old; existing.has_executed = previous; writeExperiment(config); throw error }
            if (result.isError) { existing.task_ids = old; existing.has_executed = previous; writeExperiment(config) }
          } else {
            if (!initial || Object.keys(config.workers).length >= experimentLimits(config).max_workers) throw new Error('EXPERIMENT_TOTAL_WORKER_LIMIT')
            const newSlot = `worker-${Object.keys(config.workers).length + 1}`
            result = await create(newSlot, ids, () => tool.execute({ task: instruction, role: 'implement', ...modelArgs() }, ctx))
          }
          recordExperiment(config, 'dispatch', { request_id: ctx.requestId, task_ids: ids, workers: Object.values(config.workers), error: Boolean(result.isError) })
          if (key) cache.set(key, result)
          return result
        } catch (error) { return rejected(config, error, ctx) }
      } }
  }), plan]
}
function rejected(config: DispatchExperiment, error: unknown, ctx: ToolContext): ToolOutcome {
  const reason = error instanceof Error ? error.message : String(error)
  recordExperiment(config, 'dispatch_rejected', { request_id: ctx.requestId, reason })
  return { output: reason, isError: true }
}
