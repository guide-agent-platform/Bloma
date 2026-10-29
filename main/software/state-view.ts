import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import type { SoftwareStatusView } from '../../shared/types'
import { findProject } from '../project/project-service'
import { readSoftwareRunState } from './run-state'
import { activeSoftwareCommands, redactSoftwareOutput } from './process-manager'
import { acceptanceScopeNote } from '../desktop/acceptance-evidence'

/** Presentation facts only. A historical PASS is never a fresh delivery
 * credential; launch/promotion keep their existing independent gates. */
export function softwareStatusView(projectId: string, busy: boolean): SoftwareStatusView {
  const project = findProject(projectId)
  let run: ReturnType<typeof readSoftwareRunState>
  try { const value = readSoftwareRunState(projectId); if (value?.operationId === project.lean_operation_id) run = value } catch { /* unreadable state cannot imply success */ }
  const inFlight = run && ['running','repairing','verifying'].includes(run.status)
  const execution = busy ? run?.status === 'verifying' || run?.status === 'repairing' ? run.status : 'running' : inFlight ? 'interrupted' : run?.status === 'verified' ? 'ended' : run?.status ?? (project.desktop_blocked ? 'blocked' : 'idle')
  const labels: Record<string, string> = { idle: '尚未执行', running: '正在执行', verifying: '正在检查', repairing: '正在修复', ended: '本轮已结束', blocked: '本轮需处理', cancelled: '本轮已停止', interrupted: '本轮已中断', waiting_user: '等待你确认', waiting_environment: '等待运行环境' }
  let verification: SoftwareStatusView['verification'] = { status: 'not_run', label: '尚无检查记录' }
  const file = join(getPromaHome(), 'software-verification', projectId + '.json')
  if (existsSync(file)) try {
    if (statSync(file).size > 2 * 1024 * 1024) throw Error('receipt too large')
    const receipt = JSON.parse(readFileSync(file, 'utf8'))
    const at = typeof receipt.at === 'number' && Number.isFinite(receipt.at) ? receipt.at : undefined
    if (receipt.state === 'running') verification = busy && execution === 'verifying' ? { status: 'running', label: '检查进行中', at } : { status: 'last_unverified', label: '上次检查未完成', at }
    else {
      if (receipt.state !== 'complete' || !receipt.result || createHash('sha256').update(JSON.stringify(receipt.result)).digest('hex') !== receipt.result_hash) throw Error('invalid receipt')
      const status = receipt.result.status
      verification = { status: status === 'passed' ? 'last_passed' : status === 'failed' ? 'last_failed' : 'last_unverified',
        label: status === 'passed' ? '最近检查通过（对应记录版本）' : status === 'failed' ? '最近检查未通过' : '最近检查尚未验证', at,
        scope_note:acceptanceScopeNote(receipt.result.core?.acceptance_evidence) }
    }
  } catch { verification = { status: 'unavailable', label: '检查记录需核对' } }
  const goal: SoftwareStatusView['goal'] = project.status === 'archived' || project.status === 'abandoned' ? { status: 'archived', label: '项目已归档或放弃' }
    : project.current_stage === 'completed' && project.desktop_phase === 'delivered' ? { status: 'delivered', label: '已交付' }
    : project.longterm_summary?.status === 'awaiting_confirmation' ? { status: 'waiting_confirmation', label: '本阶段待你核对' } : { status: 'not_delivered', label: '本轮尚未交付' }
  const reason = run?.error ?? project.desktop_blocked?.note
  return { execution: { status: execution, label: labels[execution] ?? '现场需核对', reason: reason ? redactSoftwareOutput(reason).slice(0, 500) : undefined }, verification, goal,
    active_commands: activeSoftwareCommands(projectId, run?.sessionId ?? project.last_session_id ?? '').length }
}
