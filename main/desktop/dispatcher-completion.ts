import { listDelegations, waitForDelegations, getDelegationSummary } from '../agent/delegation/agent-collaboration'
import type { ToolContext } from '../agent/loop/agent-loop'

interface Dependencies {
  list: typeof listDelegations
  wait: typeof waitForDelegations
  summary: typeof getDelegationSummary
}
/** No completion/advance is manufactured. Await active work without spending parent
 * model calls, then return the actual handoffs so the parent can decide its next step. */
export async function guardDispatcherCompletion(ctx: ToolContext, limitMs = 1_800_000,
  deps: Dependencies = { list: listDelegations, wait: waitForDelegations, summary: getDelegationSummary }): Promise<string | undefined> {
  let running = deps.list(ctx.sessionId).filter(r => r.status === 'running')
  if (!running.length) return undefined
  const deadline = Date.now() + limitMs
  while (running.length && !running.some(r => r.pendingQuestion)) {
    ctx.signal.throwIfAborted()
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('DISPATCHER_CHILD_COMPLETION_TIMEOUT')
    await deps.wait(ctx, { delegationIds: running.map(r => r.delegationId), strategy: 'all', timeout_ms: Math.min(60_000, remaining) })
    running = deps.list(ctx.sessionId).filter(r => r.status === 'running')
  }
  ctx.signal.throwIfAborted()
  const summaries = deps.list(ctx.sessionId).map(r => deps.summary(r))
  return '【宿主完成条件】上一条无工具回复时仍有子任务在运行，不能据此结束阶段。宿主已等待完成或待回答问题，没有取消执行器。以下是实际状态与交接；请只处理缺口、必要代答或完成收口，不无变化重复验证。执行结束不等于产品验收通过，推进标记必须由你依据事实给出。\n'
    + JSON.stringify(summaries.map(s => ({ ...s, result_summary: s.result_summary?.slice(0, 3000) })))
}
