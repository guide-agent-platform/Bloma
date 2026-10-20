import type { AgentLoopTool, ToolContext, ToolOutcome } from '../agent/loop/agent-loop'
import { findDelegation, getDelegationSummary } from '../agent/delegation/agent-collaboration'
import { experimentLimits, recordExperiment, validateExperimentTasks, writeExperiment, type DispatchExperiment, type ExperimentTask } from './dispatch-experiment'
import { assertExperimentWorkerRecovery } from './dispatch-experiment-recovery'
import { assertDelegationRecovery } from '../agent/delegation/delegation-evidence'
import { readPrdBackplane } from '../project/prd-store'

export function autonomousTaskBook(config: DispatchExperiment): string {
  const limits = experimentLimits(config)
  return '【调度实验运行协议】\n' +
    `需求、初始产物和验收已冻结。自行制定任务分解，用experiment_plan登记目标、接口、依赖、写入范围及相关feature_ids（F编号）；平台按功能编号给执行者交接完整规则与验收。不规定任务数量或具体拆分答案。\n` +
    'writes只接受具体文件路径或以 / 结尾的目录前缀，不支持 *、**、? 通配符；不合法范围会在锁定计划前拒绝。\n' +
    (config.required_writes?.length ? `宿主必需交付文件（项目根相对路径）：${config.required_writes.join('、')}。计划写入范围必须覆盖这些文件；首次派遣前缺失会明确拒绝，可重新提交你自己的计划。测试脚本名称与业务分解仍由你决定。\n` : '') +
    `实现者最多 ${limits.max_workers} 名，任务登记最多 ${limits.max_tasks} 项。delegate_agent 用 task_ids 分配任务；continue_delegation 可分配尚未执行的已登记任务或发送修复反馈。\n` +
    '一次委派或续接分配的一批任务，须等该实现者整轮成功结束后才释放给其他实现者的依赖；运行中不会提前发布其中单个任务已完成的事件。请据此安排你自己的依赖与并行派发。\n' +
    '任务正文只在experiment_plan登记一次，派工仅传task_ids，不在task或feedback中复制正文。任务写目标、接口、验收引用和写入边界即可，不预写完整实现。已有名额用完后以continue_delegation复用已结束实现者；先用experiment_status读取实际状态、loop结果、交接证据和依赖，不把等待、进程结束或摘要自述当作验收。续接feedback仅传新增事实、失败证据或接口变更。\n' +
    'CORE_CHECK.json 的 scenarios 最多 64 条，场景名须唯一；合并重复场景时仍须覆盖全部已确认需求。\n' +
    '角色、模型由宿主实验配置绑定，不自行修改。规划登记只定义执行协议，不表示任务或产物已验收；是否启动、分配、等待、集成和修复由你决定。历史证据不是当前版本已通过证明。'
}
export function wrapAutonomousDispatcherTools(tools: AgentLoopTool[], config: DispatchExperiment,
  create: (slot: string, ids: string[], action: () => Promise<ToolOutcome>) => Promise<ToolOutcome>,
  modelArgs: () => { channelId?: string; modelId?: string }, bindWorkers: () => void): AgentLoopTool[] {
  const cache = new Map<string, ToolOutcome>()
  const plan: AgentLoopTool = { name: 'experiment_plan', description: '登记你自行产生的任务分解。第一次派遣后计划锁定，修复沿已登记任务进行。',
    input_schema: { type: 'object', properties: { tasks: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, instruction: { type: 'string' }, depends_on: { type: 'array', items: { type: 'string' } }, writes: { type: 'array', description: '具体文件相对路径或以 / 结尾的目录前缀；不支持 *、**、? 通配符', items: { type: 'string' } },
      feature_ids: { type: 'array', items: { type: 'string' }, description: '本任务关联的已确认F编号；按职责提供完整规则与场景，不改变全局范围。' },
    }, required: ['id', 'instruction', 'depends_on', 'writes'] } } }, required: ['tasks'] },
    execute: async (input, ctx) => {
      try {
        if (ctx.projectId !== config.project_id || ctx.sessionId !== config.parent_session_id) throw new Error('EXPERIMENT_CONTEXT_MISMATCH')
        if (config.plan_locked) throw new Error('EXPERIMENT_PLAN_ALREADY_DISPATCHED')
        const tasks = input.tasks as ExperimentTask[]
        validateExperimentTasks(tasks, experimentLimits(config).max_tasks)
        const requestedFeatures = tasks.flatMap(task => task.feature_ids ?? [])
        if (requestedFeatures.length) {
          const known = new Set(readPrdBackplane(config.project_id).requirements.map(item => item.id))
          if (requestedFeatures.some(id => !known.has(id))) throw new Error('EXPERIMENT_UNKNOWN_FEATURE')
        }
        if (!tasks.length) throw new Error('EXPERIMENT_EMPTY_PLAN')
        // Validate new plans only: historical configs with unsupported scopes remain readable.
        const unsupported = tasks.flatMap(task => task.writes).filter(path => /[*?]/.test(path))
        if (unsupported.length) throw new Error(`EXPERIMENT_PLAN_UNSUPPORTED_WRITE_SCOPE: ${unsupported.join(', ')}。writes使用具体文件路径或以 / 结尾的目录前缀，不支持通配符；尚未派遣，可修正后重新登记。`)
        const scopes = tasks.flatMap(task => task.writes).map(path => path.toLowerCase())
        const missing = (config.required_writes ?? []).filter(path => !scopes.some(scope => path.toLowerCase() === scope
          || (scope.endsWith('/') && path.toLowerCase().startsWith(scope))))
        if (missing.length) throw new Error(`EXPERIMENT_PLAN_MISSING_REQUIRED_WRITES: ${missing.join(', ')}。尚未派遣，可重新登记完整计划；宿主不会替你补任务。`)
        config.tasks = structuredClone(tasks); writeExperiment(config)
        recordExperiment(config, 'plan_declared', { request_id: ctx.requestId, tasks: config.tasks })
        return { output: `计划已登记，共 ${tasks.length} 项。登记不代表已执行或已验收。` }
      } catch (error) { return rejected(config, error, ctx) }
    } }
  const status: AgentLoopTool = { name: 'experiment_status', parallelSafe: true, description: '只读查询登记任务、实现者实际生命周期/loop结果、交接证据与可续接状态。',
    input_schema: { type: 'object', properties: {} }, execute: async (_input, ctx) => {
      if (ctx.projectId !== config.project_id || ctx.sessionId !== config.parent_session_id) return { isError: true, output: 'EXPERIMENT_CONTEXT_MISMATCH' }
      return { output: JSON.stringify({ plan_locked: Boolean(config.plan_locked), worker_limit: experimentLimits(config).max_workers,
        tasks: config.tasks.map(({ id, depends_on, writes, feature_ids }) => ({ id, depends_on, writes, feature_ids })),
        workers: Object.entries(config.workers).map(([slot, worker]) => { const record = findDelegation(ctx.sessionId, worker.delegation_id)
          if (record) getDelegationSummary(record) // Refresh receipts exactly as actual continuation does.
          let continuationBlocked = record ? record.status === 'running' ? 'WORKER_STILL_RUNNING' : record.status === 'cancelled' ? 'CANCELLED_WORKER_REQUIRES_NEW_RUN' : null : 'WORKER_MISSING'
          if (record && !continuationBlocked) try { assertDelegationRecovery(record) } catch (error) {
            continuationBlocked = error instanceof Error ? error.message : String(error)
          }
          return { slot, delegation_id: worker.delegation_id, task_ids: worker.task_ids, status: record?.status ?? 'missing',
            loop_status: record?.loopStatus ?? null, task_handoff: record?.taskHandoff ?? null,
            can_continue: !continuationBlocked, continuation_blocked_reason: continuationBlocked } }),
      }) }
    } }
  return [...tools.map(tool => {
    if (!['delegate_agent', 'continue_delegation'].includes(tool.name)) return tool
    const initial = tool.name === 'delegate_agent'
    return { ...tool, parallelSafe: false,
      description: initial ? '仅用task_ids把已登记正文交给实现者，宿主自动附正文；不重复填写任务说明。' : '续接已结束实现者；新增任务传task_ids，feedback只写增量事实/失败证据；同一任务不重复正文。',
      input_schema: { type: 'object', properties: { task_ids: { type: 'array', items: { type: 'string' } },
        ...(initial ? {} : { feedback: { type: 'string', description: '仅本轮新增事实、接口变化或失败证据；不要重复已登记任务正文。' } }),
        ...(initial ? {} : { delegation_id: { type: 'string' } }) }, required: initial ? ['task_ids'] : ['delegation_id'] },
      execute: async (input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> => {
        const key = ctx.toolCallId && `${tool.name}:${ctx.toolCallId}`
        if (key && cache.has(key)) return cache.get(key)!
        const previousPlanLocked = config.plan_locked
        const rollbackUnusedLock = () => {
          if (!previousPlanLocked && config.plan_locked && !Object.values(config.workers).some(worker => worker.has_executed)) {
            config.plan_locked = previousPlanLocked; writeExperiment(config)
          }
        }
        try {
          if (ctx.projectId !== config.project_id || ctx.sessionId !== config.parent_session_id) throw new Error('EXPERIMENT_CONTEXT_MISMATCH')
          if (input.channelId || input.modelId || (input.role && input.role !== 'implement')) throw new Error('EXPERIMENT_MODEL_OR_ROLE_OVERRIDE')
          bindWorkers()
          const slot = initial ? Object.keys(config.workers).find(id => !config.workers[id].has_executed)
            : Object.keys(config.workers).find(id => config.workers[id].delegation_id === input.delegation_id)
          const existing = slot ? config.workers[slot] : undefined
          if (existing) assertExperimentWorkerRecovery(config, findDelegation(ctx.sessionId, existing.delegation_id))
          const ids = input.task_ids === undefined && existing ? existing.task_ids : input.task_ids as string[]
          if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !config.tasks.some(task => task.id === id))) throw new Error('EXPERIMENT_TASK_NOT_ASSIGNED')
          const selected = config.tasks.filter(task => ids.includes(task.id))
          const old = existing?.task_ids ?? []
          const inside = new Set(ids)
          for (const task of selected) for (const dependency of task.depends_on) {
            if (inside.has(dependency)) continue
            const owner = Object.values(config.workers).find(worker => worker.task_ids.includes(dependency))
            const record = owner && findDelegation(ctx.sessionId, owner.delegation_id)
            assertExperimentWorkerRecovery(config, record)
            if (!owner?.has_executed || record?.status !== 'completed' || record.loopStatus !== 'completed') throw new Error('EXPERIMENT_DEPENDENCY_WAIT')
            if (getDelegationSummary(record).task_handoff?.completion === 'incomplete') throw new Error('EXPERIMENT_DEPENDENCY_UNRESOLVED: 负责人已结束，但宿主交接仍含失败或阻塞；先修复该依赖。')
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
          const fresh = existing?.has_executed ? selected.filter(task => !old.includes(task.id)) : selected
          const feedback = typeof input.feedback === 'string' ? input.feedback : !initial && typeof input.task === 'string' ? input.task : ''
          const instruction = (fresh.length ? fresh.map(task => `[${task.id}] ${task.instruction}\n功能引用：${task.feature_ids?.join(',') || '按任务核对权威需求'}\n依赖：${task.depends_on.join(',')}\n写入范围：${task.writes.join(',')}`).join('\n\n')
            : `继续已登记任务：${ids.join(',')}。沿用历史任务正文、写入范围和已读事实，不扩大职责。`)
            + (feedback.trim() ? `\n本轮增量反馈（保持已确认需求）：${feedback}` : '')
          if (existing) {
            const record = findDelegation(ctx.sessionId, existing.delegation_id)
            const status = record?.status
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
          if (result.isError) rollbackUnusedLock()
          recordExperiment(config, 'dispatch', { request_id: ctx.requestId, task_ids: ids, workers: Object.values(config.workers), error: Boolean(result.isError) })
          if (key) cache.set(key, result)
          return result
        } catch (error) { rollbackUnusedLock(); return rejected(config, error, ctx) }
      } }
  }), plan, status]
}
function rejected(config: DispatchExperiment, error: unknown, ctx: ToolContext): ToolOutcome {
  const reason = error instanceof Error ? error.message : String(error)
  recordExperiment(config, 'dispatch_rejected', { request_id: ctx.requestId, reason })
  return { output: reason, isError: true }
}
