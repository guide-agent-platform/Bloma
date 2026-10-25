import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { getDocumentsDir } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { findProject, updateProject } from '../project/project-service'
import { syncDocuments } from '../project/document-sync'
import { prdScopeFingerprint } from '../project/requirement-contract'
import type { PrdBackplane } from '../model/prd-backplane'
import { saveGuideConfirmation } from './confirmation-journal'
import { renderLeanBrief } from './lean-brief'
import { readConfirmedUxBinding } from '../project/ux-binding'

type Emit = (type: 'message_delta' | 'user_decision_required' | 'stage_changed', payload: Record<string, unknown>) => void

/** One authoritative task sheet, including revisions proposed during production. */
export function stageLeanScope(projectId: string, sessionId: string, requestId: string, previous: PrdBackplane, next: PrdBackplane, emit: Emit): void {
  const project = findProject(projectId)
  if (previous.user_confirmed_at && previous.lean_brief && next.lean_brief?.ui === 'required' && !next.lean_brief.preview) {
    try {
      const reference = readConfirmedUxBinding(projectId, previous)
      if (reference?.html_path && project.ux_confirmation?.html_hash) {
        next.lean_brief.preview = 'reuse'; next.lean_brief.reference_html_hash = project.ux_confirmation.html_hash
      } else if (previous.lean_brief.preview === 'skip') next.lean_brief.preview = 'skip'
    } catch { /* an invalid old preview cannot authorize a new one */ }
  }
  if (previous.requirements.length) writeTextFileAtomic(join(getDocumentsDir(project.workspace_slug, projectId), 'history',
    `brief-${prdScopeFingerprint(previous)}.json`), JSON.stringify(previous, null, 2))
  syncDocuments({ request_id: requestId, project_id: projectId, session_id: sessionId, checkpoint: 'requirement_confirmed' }, next)
  saveGuideConfirmation({ version: 1, kind: 'prd', id: randomUUID(), project_id: projectId, session_id: sessionId,
    scope_hash: prdScopeFingerprint(next), state: 'pending', data: { lean: true } })
  const removed = previous.requirements.filter(old => !next.requirements.some(row => row.id === old.id))
  const changed = next.requirements.filter(row => previous.requirements.some(old => old.id === row.id
    && (old.description !== row.description || previous.acceptance[old.id] !== next.acceptance[row.id])))
  const added = next.requirements.filter(row => !previous.requirements.some(old => old.id === row.id))
  const removedConstraints = [...(previous.constraints ?? []), ...previous.out_of_scope].filter(text => ![...(next.constraints ?? []), ...next.out_of_scope].includes(text))
  if (previous.lean_brief) emit('message_delta', { text: [
    ...added.map(row => `新增：${row.description}`), ...changed.map(row => `调整：${row.description}`),
    ...removed.map(row => `移除：${row.description}`), ...removedConstraints.map(text => `取消限制：${text}`),
  ].join('\n') || '任务说明已更新，请核对。' })
  publishLeanScope(next, emit)
  updateProject(projectId, { status: 'active', desktop_phase: undefined, current_stage: 'blocked_for_user_decision', desktop_blocked: undefined })
}

export function publishLeanScope(brief: PrdBackplane, emit: Emit): void {
  emit('user_decision_required', leanScopeDecision(brief))
  updateProject(brief.project_id, { current_stage: 'blocked_for_user_decision' })
  emit('stage_changed', { stage: 'blocked_for_user_decision' })
}

export function leanScopeDecision(brief: PrdBackplane): Record<string, unknown> {
  return { kind: 'lean_scope', title: '确认这次要做的内容', summary: renderLeanBrief(brief),
    scope: { goal: brief.positioning, features: brief.requirements.map(row => ({ id: row.id, description: row.description, expected: brief.acceptance[row.id] ?? '' })),
      constraints: brief.constraints ?? [], out_of_scope: brief.out_of_scope,
      usage: brief.lean_brief?.delivery === 'browser' ? '在本机浏览器使用' : brief.lean_brief?.delivery === 'command' ? '通过命令行使用' : '在桌面窗口使用' },
    questions: [{ id: `lean_confirm:${prdScopeFingerprint(brief)}`, label: '按这份做', description: '确认目标和范围' },
      { id: 'lean_adjust', label: '补充或修改', description: '告诉我需要改哪里' }, { id: 'lean_pause', label: '稍后再说', description: '先保留，暂不开工' }] }
}

/** Explicit delegation of appearance; negatives and quoted instructions do not approve. */
export function authorizesDirectBuild(text: string): boolean {
  return !/[“”「」"'`]|(?:不|别|不要|不能|无需|无须)\s*(?:现在)?\s*直接(?:做|实现|开发|制作)/.test(text)
    && !/先(?:确认|讨论|整理)|只(?:做)?(?:计划|整理)|暂不(?:制作|开工)/.test(text)
    && /直接(?:做|实现|开发|制作)/.test(text)
}

export function authorizesSkipPreview(text: string): boolean {
  return authorizesDirectBuild(text) || !/[“”「」"'`]/.test(text)
    && /(?:不需要|不用|无需|跳过)(?:先)?(?:看)?草图/.test(text) && !/(?:不要|别|不能)跳过草图/.test(text)
}
