import { createHash } from 'node:crypto'
import type { ConversationTurn } from '../../orchestration/stages/orchestration-contracts'
import type { AgentLoopToolCallRecord } from './agent-loop'

/** Only stable public failure identities are used; no tool output or secrets
 * are retained in progress records. Distinct assertion failures stay distinct. */
export function toolFailureKey(name: string, output: string): string | undefined {
  if (!['verify_app', 'inspect_app', 'register_gui_check', 'register_cli_check', 'run_command', 'start_service'].includes(name)) return
  let body: { code?: string; summary?: string; input_version?: string; failure?: { code?: string; step?: string; actual?: unknown } } = {}
  try { body = JSON.parse(output.replace(/^<tool-feedback>[\s\S]*?<\/tool-feedback>\s*/, '')) } catch { /* text errors still carry public codes */ }
  const code = body?.failure?.code ?? body?.code ?? output.match(/\b[A-Z][A-Z_]{5,}\b/)?.[0]
  if (typeof code !== 'string' || !/^[A-Z][A-Z_]{4,100}$/.test(code)) return
  const identity = typeof body?.input_version === 'string' ? body.input_version
    : body?.failure ? JSON.stringify([body.failure.step, body.failure.actual, code === 'PRODUCT_CHECK_FAILED' ? body.summary : undefined]) : ''
  return `${code}:${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`
}

export function commandProgressKey(name: string, input: Record<string, unknown>): string | undefined {
  return name === 'run_command' ? createHash('sha256').update(JSON.stringify([input.command, input.cwd ?? '.'])).digest('hex').slice(0, 16) : undefined
}
export function isPendingToolExecution(name: string, output: string): boolean {
  if (!['run_command','read_process','verify_app'].includes(name)) return false
  try {
    const body = JSON.parse(output.replace(/^<tool-feedback>[\s\S]*?<\/tool-feedback>\s*/, ''))
    return body?.execution_status === 'running' && (body.kind === 'command' || body.code === 'COMMANDS_STILL_RUNNING')
  } catch { return false }
}

/** Execution progress is a successful edit or a real verification attempt, not
 * an intention to edit. Read-only research does not opt into this policy. */
export function createWorkProgress() {
  let idleTurns = 0
  const failures = new Map<string, number>()
  return {
    observe(calls: AgentLoopToolCallRecord[]) {
      let repeated = 0
      const observedFailures = new Set<string>()
      for (const call of calls) {
        const scope = `${call.name}:${call.progressKey ?? ''}:`
        if (call.status === 'ok' && !call.pending) {
          for (const key of failures.keys()) if (key.startsWith(scope)) failures.delete(key)
        } else if (call.status === 'error' && call.failureKey) {
          const key = scope + call.failureKey, count = (failures.get(key) ?? 0) + 1
          failures.set(key, count); observedFailures.add(key)
          if (failures.size > 32) failures.delete(failures.keys().next().value!)
        }
      }
      repeated = Math.max(0, ...[...observedFailures].map(key => failures.get(key) ?? 0))
      const waiting = calls.length > 0 && calls.every(call => call.status === 'ok' && (call.pending || ['wait_for_delegations', 'list_delegations'].includes(call.name)))
      if (waiting) return { stalled: false, idleTurns, repeatedFailures: 0, nudge: undefined }
      const acted = calls.some(call => call.status === 'ok' && !call.pending && ['write_file', 'edit_file', 'run_project_script', 'run_project_driver', 'drive_project_app', 'install_packages', 'delegate_agent', 'continue_delegation',
        'run_command', 'start_service', 'stop_process', 'inspect_app', 'verify_app', 'prepare_software_environment', 'register_gui_check', 'register_cli_check'].includes(call.name))
      idleTurns = acted ? 0 : idleTurns + 1
      return { stalled: idleTurns >= 24 || repeated >= 8, idleTurns, repeatedFailures: repeated,
        nudge: repeated >= 3 ? `同一工具错误已重复${repeated}次，期间的写文件或命令成功不代表该阻塞解除。按具体错误和已有日志修复；不要原样重试、换探针或降低验收预期。仍无法恢复时报告宿主阻塞。`
        : idleTurns > 0 && idleTurns % 6 === 0
        ? calls.some(call => call.status === 'error' && ['inspect_app', 'register_gui_check', 'register_cli_check'].includes(call.name))
          ? `已连续${idleTurns}轮没有有效工程进展。验证工具调用失败时先区分参数/登记错误与业务断言失败：读取返回的字段路径及read_production_context(topic="verification-gui")，按schema修正，不猜action/expected等字段，也不因参数拒绝修改产品业务代码；仍无法调用时明确报告宿主阻塞。`
          : `已连续${idleTurns}轮没有成功修改或执行验证。停止重复通读：按已知失败做一个最小修改并运行相关验证；若缺少权限或事实，明确报告阻塞。` : undefined }
    },
  }
}

/** Keep the audit log intact, but do not resend identical read output repeatedly.
 * Match tool + exact arguments + exact response, retaining the newest full result
 * and every tool-use/result pair. Changed file versions remain fully available. */
export function pruneDuplicateReads(messages: ConversationTurn[]): number {
  const calls = new Map<string, string>()
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'tool_use' && typeof block.id === 'string' && ['read_file', 'list_files', 'grep', 'find', 'read_production_context'].includes(block.name ?? '')) {
        calls.set(block.id, `${block.name}:${JSON.stringify(block.input)}`)
      }
    }
  }
  const seen = new Set<string>()
  let removed = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!Array.isArray(message.content)) continue
    message.content = message.content.map(block => {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string' || typeof block.content !== 'string' || block.is_error || block.content.length < 256) return block
      const call = calls.get(block.tool_use_id)
      if (!call) return block
      const key = `${call}:${createHash('sha256').update(block.content).digest('hex')}`
      if (!seen.has(key)) { seen.add(key); return block }
      removed += block.content.length
      return { ...block, content: '[相同版本的重复读取已省略；本会话后续同参数调用保留完整结果，原始输出仍在会话记录。]' }
    })
  }
  return removed
}
