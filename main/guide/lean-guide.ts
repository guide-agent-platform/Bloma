import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { writeTextFileAtomic } from '../../storage/json-store'
import type { AgentEvent, AgentSendMessageInput } from '../../shared/types'
import type { GuideModelOptions } from '../orchestration/stages/orchestration-contracts'
import { callLlmForJson } from '../kernel/llm-call'
import { readPrdBackplane, markPrdUserConfirmed } from '../project/prd-store'
import { syncDocuments } from '../project/document-sync'
import { applyGeneratedProjectName, findProject, updateProject } from '../project/project-service'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { readGuideConfirmation, saveGuideConfirmation } from './confirmation-journal'
import { LEAN_BRIEF_PROMPT, parseLeanBrief } from './lean-brief'
import { authorizesDirectBuild, authorizesSkipPreview, publishLeanScope, stageLeanScope } from './lean-scope'
import { leanBudget, withLeanRuntime } from '../desktop/lean-budget'
import { renderMaterialContext, materialImageRefs } from '../platform/attachments/material-context'
import { runUxConfirmGate, restoreUxConfirmation, replayUxConfirmation, hasPendingUxConfirm, resolveUxConfirmCardAnswer, resumeUxConfirmConfirmed, retryUxSketch,
  consumeUxConfirmDismiss, startUxAdjustAwait, takeUxAdjustFeedback, takeUxSketchCorrection, runUxAdjustRound } from './ux-confirm'
import { enterDesktopLine } from '../desktop/desktop-route'
import { isSoftwareProject } from '../desktop/workflow-policy'

/** One extraction and one scope confirmation. No legacy PRD/audit/ideas pipeline. */
export async function handleLeanGuide(input: AgentSendMessageInput, publish: (event: AgentEvent) => void, model?: GuideModelOptions): Promise<void> {
  const emit = (type: AgentEvent['type'], payload: Record<string, unknown>) => publish({ event_id: randomUUID(),
    project_id: input.project_id, session_id: input.session_id, type, payload, created_at: new Date().toISOString() })
  if (!model) { emit('message_delta', { text: '模型渠道不可用，需求已保留，尚未开工。' }); emit('message_completed', { subtype: 'incomplete' }); return }
  const project = findProject(input.project_id)
  const brief = readPrdBackplane(input.project_id)
  const saved = readGuideConfirmation('prd', input.project_id)
  if (saved && (saved.session_id !== input.session_id || saved.data.lean !== true)) throw new Error('LEAN_CONFIRMATION_OWNER_MISMATCH')
  const publishScope = () => publishLeanScope(brief, emit)
  const begin = async () => {
    if (brief.lean_brief?.ui !== 'none' && !brief.lean_brief?.preview) {
      await runUxConfirmGate({ ...input, mode: project.mode, query: model.query, env: model.env, publish, signal: model.signal,
        round: 1, positioning: brief.positioning, requirements: brief.requirements })
    } else {
      if (brief.lean_brief?.preview === 'skip') updateProject(input.project_id, { ux_confirmation: {
        prd_fingerprint: prdScopeFingerprint(brief), design_hash: prdScopeFingerprint(brief), html_hash: null } })
      if (brief.lean_brief?.preview === 'reuse') {
        const hash = createHash('sha256').update(readFileSync(join(project.root_path, '00_UX/confirmed.html'))).digest('hex')
        if (hash !== brief.lean_brief.reference_html_hash || hash !== project.ux_confirmation?.html_hash) throw new Error('UX_REFERENCE_CHANGED')
        writeTextFileAtomic(join(project.root_path, '00_UX/confirmed.json'), JSON.stringify({ version: 2, mode: 'lean', scope_hash: prdScopeFingerprint(brief), html_hash: hash }))
        updateProject(input.project_id, { ux_confirmation: { prd_fingerprint: prdScopeFingerprint(brief), design_hash: hash, html_hash: hash } })
      }
      await enterDesktopLine({ projectId: input.project_id, sessionId: input.session_id, requestId: input.request_id,
        content: '按已确认目标制作', signal: model.signal, maxTokens: model.maxTokens }, model.query, model.env, {
        publish: (_target, type, payload) => emit(type, payload), persistAssistant: () => {}, persistSystem: () => {},
        complete: (_s, _p, subtype) => emit('message_completed', { subtype: subtype ?? 'success' }),
      })
    }
  }
  const selected = input.metadata?.source === 'card_option' ? input.metadata.selected_option_id : undefined
  const confirm = saved?.state !== 'adjust' && /^(?:确认|按这份做|按这个做|直接做|开始开发|开始实现)[。！!\s]*$/.test(input.content.trim())
  if (selected?.startsWith('lean_confirm:') || confirm && saved) {
    if (!saved || saved.scope_hash !== prdScopeFingerprint(brief) || selected && selected !== `lean_confirm:${saved.scope_hash}`) throw new Error('LEAN_CONFIRMATION_STALE')
    model.signal.throwIfAborted()
    if (authorizesDirectBuild(input.content) && brief.lean_brief?.ui === 'required') {
      brief.lean_brief.preview = 'skip'
      syncDocuments({ ...input, checkpoint: 'requirement_confirmed' }, brief)
    }
    if (!markPrdUserConfirmed(input.project_id, saved.scope_hash)) throw new Error('LEAN_CONFIRMATION_NOT_SAVED')
    saveGuideConfirmation({ ...saved, state: 'consumed' })
    await begin(); return
  }
  if (selected === 'lean_adjust' || selected === 'lean_pause') {
    if (!saved) throw new Error('LEAN_CONFIRMATION_MISSING')
    saveGuideConfirmation({ ...saved, state: selected === 'lean_adjust' ? 'adjust' : 'dismissed' })
    emit('message_delta', { text: selected === 'lean_adjust' ? '直接说要改什么，原有目标会一起保留。' : '已保留任务单，尚未开工。' }); return
  }
  if (brief.user_confirmed_at && brief.lean_brief?.ui !== 'none') {
    restoreUxConfirmation(input, publish, { query: model.query, env: model.env, signal: model.signal })
    const decision = resolveUxConfirmCardAnswer(input)
    if (!decision && confirm && hasPendingUxConfirm(input.project_id)) { await resumeUxConfirmConfirmed(input); return }
    if (!decision && /^(?:继续|查看草图|看看草图)$/.test(input.content.trim()) && hasPendingUxConfirm(input.project_id)) { replayUxConfirmation(input.project_id); return }
    if (decision === 'confirm') { await resumeUxConfirmConfirmed(input); return }
    if (decision === 'retry') { await retryUxSketch(input); return }
    if (decision === 'dismiss') { consumeUxConfirmDismiss(input); return }
    if (decision === 'adjust') { startUxAdjustAwait(input); return }
    const adjustment = takeUxSketchCorrection(input) ?? takeUxAdjustFeedback(input)
    if (adjustment) { await runUxAdjustRound(input, adjustment); return }
  }
  if (/^(?:停止|暂停|取消|先别做|不要开工)[。！!\s]*$/.test(input.content.trim())) { emit('message_delta', { text: '已停在当前任务，尚未继续制作。' }); return }
  if (saved && /^(?:继续|查看任务单)$/.test(input.content.trim())) { publishScope(); return }
  const humanTexts = model.history.filter(turn => turn.role === 'user').map(turn => typeof turn.content === 'string' ? turn.content
    : turn.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
  if (humanTexts.at(-1) !== input.content) humanTexts.push(input.content)
  const source = humanTexts.join('\n\n')
  const materials = model.materials ? renderMaterialContext(model.materials, input.session_id, true) : ''
  const images = [...(input.images ?? []), ...(model.materials ? materialImageRefs(model.materials) : [])]
  const budget = leanBudget(input.project_id, 'prepare')
  const query = budget.wrap(model.query)
  const software = isSoftwareProject(input.project_id)
  const result = await withLeanRuntime(input.project_id, 'prepare', model.signal, signal => callLlmForJson({ systemPrompt: LEAN_BRIEF_PROMPT + (software ? '\n另填delivery=desktop/browser/command描述用户使用方式；有界面默认desktop，仅用户明确要在浏览器使用才browser；无界面command。框架、依赖、语言由工程Agent选择，不让用户做技术问卷。' : ''),
    prompt: JSON.stringify({ previous: brief.lean_brief ? brief : undefined, conversation: source, materials, latest: input.content }),
    query: (text, options) => query(text, { ...options, images, accounting: { projectId: input.project_id, runId: input.request_id, role: 'brief', scope: 'prepare' } }),
    env: model.env, signal, sessionId: input.session_id, maxTokens: Math.min(model.maxTokens, 8192), temperature: .1, attempts: 2,
    parse: text => parseLeanBrief(text, { projectId: input.project_id, sessionId: input.session_id, source, previous: brief, software }) }))
  model.signal.throwIfAborted()
  if (!result) { emit('message_delta', { text: '任务整理未完成，原始需求已保留；可重试，不会自动开工。' }); emit('message_completed', { subtype: 'incomplete' }); return }
  if (result.action === 'clarify') {
    emit('message_delta', { text: result.question })
    if (result.options.length) emit('user_decision_required', { kind: 'clarification', title: result.question,
      questions: result.options.map((label, index) => ({ id: `lean_answer_${index}`, label })) })
    return
  }
  const next = result.brief
  if (authorizesSkipPreview(input.content) && next.lean_brief?.ui === 'required') next.lean_brief.preview = 'skip'
  stageLeanScope(input.project_id, input.session_id, input.request_id, brief, next, emit)
  applyGeneratedProjectName(input.project_id, project.name, next.name)
  if (authorizesDirectBuild(input.content)) {
    model.signal.throwIfAborted()
    // Read the just-accepted sheet, rather than the prior closure snapshot.
    await handleLeanGuide({ ...input, content: '按这份做', metadata: { source: 'chat' } }, publish, model)
  }
}
