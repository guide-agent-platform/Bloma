import { createHash } from 'node:crypto'
import type { ConversationTurn } from '../../orchestration/stages/orchestration-contracts'
import type { AgentLoopToolCallRecord } from './agent-loop'

/** Execution progress is a successful edit or a real verification attempt, not
 * an intention to edit. Read-only research does not opt into this policy. */
export function createWorkProgress() {
  let idleTurns = 0
  return {
    observe(calls: AgentLoopToolCallRecord[]) {
      const waiting = calls.length > 0 && calls.every(call => call.status === 'ok' && ['wait_for_delegations', 'list_delegations'].includes(call.name))
      if (waiting) return { stalled: false, idleTurns, nudge: undefined }
      const acted = calls.some(call => call.status === 'ok' && ['write_file', 'edit_file', 'run_project_script', 'run_project_driver', 'drive_project_app', 'install_packages', 'delegate_agent', 'continue_delegation',
        'run_command', 'start_service', 'stop_process', 'inspect_app', 'verify_app', 'prepare_software_environment', 'register_gui_check', 'register_cli_check'].includes(call.name))
      idleTurns = acted ? 0 : idleTurns + 1
      return { stalled: idleTurns >= 24, idleTurns, nudge: idleTurns > 0 && idleTurns % 6 === 0
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
