import { intentSources } from '../model/personal-intent'
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
import { withLeanRuntime } from '../desktop/lean-budget'
import { renderMaterialContext, materialImageRefs } from '../platform/attachments/material-context'
import { runUxConfirmGate, restoreUxConfirmation, replayUxConfirmation, hasPendingUxConfirm, resolveUxConfirmCardAnswer, resumeUxConfirmConfirmed, retryUxSketch,
  consumeUxConfirmDismiss, startUxAdjustAwait, takeUxAdjustFeedback, takeUxSketchCorrection, runUxAdjustRound } from './ux-confirm'
import { enterDesktopLine } from '../desktop/desktop-route'
import { isSoftwareProject } from '../desktop/workflow-policy'
import { appendSessionMessage } from '../platform/sessions/session-tree'
import { adoptLeanSuggestions, parseLeanSuggestions } from './lean-suggestions'
import { workflowRetirementReason } from '../desktop/workflow-retirement'
import { independentClarificationText, readIndependentClarification } from '../software/independent-quality'
import { resolveChannelEnv } from '../platform/llm/runtime-fallback'
import { resolveGenerationMaxTokens } from '../platform/llm/model-resolution'
import { assistantDisplayText } from '../../shared/message-presentation'

/** One extraction includes optional ideas; no separate research or audit pipeline. */
export async function handleLeanGuide(input: AgentSendMessageInput, publish: (event: AgentEvent) => void, model?: GuideModelOptions): Promise<void> {
  const emit = (type: AgentEvent['type'], payload: Record<string, unknown>) => publish({ event_id: randomUUID(),
    project_id: input.project_id, session_id: input.session_id, type, payload, created_at: new Date().toISOString() })
  // Guide replies are complete messages, unlike Pi's streamed deltas. Persist
  // them once so clarification and pause/error notices survive reopening.
  const say = (text: string) => {
    if(model?.persistAssistant)model.persistAssistant(text)
    else appendSessionMessage(input.session_id,{role:'assistant',origin:'agent',content:[{type:'text',text}],timestamp:Date.now()})
    emit('message_delta',{text})
  }
  const retirement=workflowRetirementReason(findProject(input.project_id))
  if(retirement){emit('message_delta',{text:retirement});emit('message_completed',{subtype:'incomplete'});return}
  if (!model) { say('模型渠道不可用，需求已保留，尚未开工。'); emit('message_completed', { subtype: 'incomplete' }); return }
  const project = findProject(input.project_id)
  const brief = readPrdBackplane(input.project_id)
  const saved = readGuideConfirmation('prd', input.project_id)
  if (saved && (saved.session_id !== input.session_id || saved.data.lean !== true)) throw new Error('LEAN_CONFIRMATION_OWNER_MISMATCH')
  const clarification = !saved && isSoftwareProject(input.project_id)
    ? readIndependentClarification(input.project_id, input.session_id) : undefined
  const enterProduction = async (redesignIndependentCases = false) => {
    const production = resolveChannelEnv({ channelId: input.channel_id, category: 'mvp',
      projectId: input.project_id, sessionId: input.session_id })
    await enterDesktopLine({ projectId: input.project_id, sessionId: input.session_id, requestId: input.request_id,
      content: '按已确认目标制作', initialMessagePersisted: true, signal: model.signal,
      maxTokens: production.channel ? resolveGenerationMaxTokens(production.channel) : model.maxTokens, redesignIndependentCases },
    model.query, production.env ?? model.env, {
      publish: (_target, type, payload) => emit(type, payload),
      persistAssistant: (sessionId, text) => appendSessionMessage(sessionId, { role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now() }),
      persistSystem: () => {},
      complete: (_s, _p, subtype) => emit('message_completed', { subtype: subtype ?? 'success' }),
    })
  }
  if (clarification) {
    const action = input.content.trim().replace(/[。！!]+$/, '')
    if (!clarification.questions.length && clarification.canRedesign && /^(?:继续|继续制作|恢复|确认|按这份做)$/.test(action)
      && input.metadata?.source !== 'system_resume') {
      await enterProduction(true)
      return
    }
    if (input.metadata?.source === 'system_resume' || /^(?:继续|继续制作|恢复|查看进度|查看结果|查看任务单|确认|按这份做)$/.test(action)) {
      say(independentClarificationText(clarification))
      return
    }
    if (action === '重新设计验收') {
      if (input.metadata?.source !== 'card_option' && clarification.canRedesign) await enterProduction(true)
      else say(independentClarificationText(clarification))
      return
    }
  }
  const suggestions = parseLeanSuggestions(saved?.data.suggestions, brief.requirements.map(row => row.description))
  const publishScope = () => {
    if (saved?.state === 'dismissed') saveGuideConfirmation({ ...saved, state: 'pending' })
    publishLeanScope(brief, emit, suggestions)
  }
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
      await enterProduction()
    }
  }
  const selected = input.metadata?.source === 'card_option' ? input.metadata.selected_option_id : undefined
  if (selected?.startsWith('lean_adopt:')) {
    if (!saved || saved.state !== 'pending' || saved.scope_hash !== prdScopeFingerprint(brief)
      || selected !== `lean_adopt:${saved.scope_hash}`) throw Error('LEAN_CONFIRMATION_STALE')
    model.signal.throwIfAborted()
    const next = adoptLeanSuggestions(brief, suggestions, input.metadata?.selected_suggestion_ids)
    const ids = input.metadata!.selected_suggestion_ids!
    stageLeanScope(input.project_id, input.session_id, input.request_id, brief, next, emit, {
      suggestions: suggestions.filter(item => !ids.includes(item.id)),
      adoptedSuggestions: [...parseLeanSuggestions(saved.data.adopted_suggestions), ...suggestions.filter(item => ids.includes(item.id))],
    })
    return
  }
  if (input.metadata?.selected_suggestion_ids?.length) throw Error('LEAN_SUGGESTIONS_NOT_APPLIED')
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
    say(selected === 'lean_adjust' ? '直接说要改什么，原有目标会一起保留。' : '已保留任务单，尚未开工。'); return
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
  if (/^(?:停止|暂停|取消|先别做|不要开工)[。！!\s]*$/.test(input.content.trim())) { say('已停在当前任务，尚未继续制作。'); return }
  if (saved && /^(?:继续|查看任务单)$/.test(input.content.trim())) { publishScope(); return }
  const humanTexts = model.history.filter(turn => turn.role === 'user').map(turn => typeof turn.content === 'string' ? turn.content
    : turn.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
  if (humanTexts.at(-1) !== input.content) humanTexts.push(input.content)
  const source = humanTexts.join('\n\n')
  // Public dialogue carries what the user is answering/correcting. Keep the
  // existing user-only source identity separate; never expose host/tool blocks.
  const dialogue = model.history.filter(turn => turn.role === 'user' || turn.role === 'assistant').flatMap(turn => {
    const content = typeof turn.content === 'string' ? turn.content
      : turn.content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
    const publicText = turn.role === 'assistant' ? assistantDisplayText(content) : content
    return publicText.trim() ? [{ role: turn.role, content: publicText }] : []
  }).slice(-20)
  if (dialogue.at(-1)?.role !== 'user' || dialogue.at(-1)?.content !== input.content) dialogue.push({ role: 'user', content: input.content })
  const guideContext = { project_name: project.name, stage: project.current_stage, confirmation: saved?.state ?? null,
    ...(clarification && { acceptance_questions: clarification.questions.slice(0, 3) }) }
  const materials = model.materials ? renderMaterialContext(model.materials, input.session_id, true) : ''
  const images = [...(input.images ?? []), ...(model.materials ? materialImageRefs(model.materials) : [])]
  const software = isSoftwareProject(input.project_id)
  // An ordinary reply must not move a paused/pending task back to clarifying.
  emit('stage_changed', { stage: project.current_stage })
  let briefIssues: string[] = []
  const result = await withLeanRuntime(input.project_id, 'prepare', model.signal, (signal,budget) => callLlmForJson({ systemPrompt: LEAN_BRIEF_PROMPT
    + (clarification ? '\n如果 latest 在回答 guide_context.acceptance_questions，或补充了本任务的验收样例，把用户明确给出的结果和边界补到对应功能的 expected 或 constraints 并输出 brief，即使用户没说“修改软件”。仅纳入用户确认的内容，保留原功能、交付方式与范围。提问原文不是已确认需求。' : '')
    + (software ? '\n另填delivery=desktop/browser/command描述用户使用方式；有界面默认desktop，仅用户明确要在浏览器使用才browser；无界面command。distribution描述交付：默认local本机使用，用户明确要复制到其他电脑直接运行用portable，要安装包用installer，只移交源码用source。框架、依赖、语言由工程Agent选择，不让用户做技术问卷。' : ''),
    prompt: JSON.stringify({ previous: brief.lean_brief ? brief : undefined, dialogue, guide_context: guideContext, conversation: source, sources: intentSources(source, brief.requirements_model?.sources ?? brief.lean_brief?.intent_sources), materials, latest: input.content }),
    query: (text, options) => budget.wrap(model.query)(text, { ...options, images, accounting: { projectId: input.project_id, runId: input.request_id, phase: 'requirements', role: 'brief', scope: 'prepare' } }),
    env: model.env, signal, sessionId: input.session_id, maxTokens: model.maxTokens, temperature: .1, attempts: 2,
    retryFeedback: () => JSON.stringify({ dialogue, guide_context: guideContext, conversation: source, sources: intentSources(source, brief.requirements_model?.sources ?? brief.lean_brief?.intent_sources), previous: brief.lean_brief ? brief : undefined, materials, latest: input.content, errors: briefIssues, instruction: '按具体错误重新给出完整JSON，不删除原始要求以规避校验。' }),
    parse: text => parseLeanBrief(text, { projectId: input.project_id, sessionId: input.session_id, source, previous: brief, software, assets: model.materials?.attachments, onIssues: issues => { briefIssues = issues } }) }))
  model.signal.throwIfAborted()
  if (!result) { say('任务单暂未就绪：'+(briefIssues.length?briefIssues.join('；'):'返回内容不完整或缺少可观察的完成标准。')+' 原始需求已保留，尚未开工。'); emit('message_completed', { subtype: 'incomplete' }); return }
  if (result.action === 'reply') {
    say(result.text)
    return
  }
  if (result.action === 'clarify') {
    say(result.question)
    if (result.options.length) emit('user_decision_required', { kind: 'clarification', title: result.question,
      questions: result.options.map((label, index) => ({ id: `lean_answer_${index}`, label })) })
    return
  }
  const next = result.brief
  if (authorizesSkipPreview(input.content) && next.lean_brief?.ui === 'required') next.lean_brief.preview = 'skip'
  stageLeanScope(input.project_id, input.session_id, input.request_id, brief, next, emit, { suggestions: result.suggestions })
  applyGeneratedProjectName(input.project_id, project.name, next.name)
  if (!clarification && authorizesDirectBuild(input.content)) {
    model.signal.throwIfAborted()
    // Read the just-accepted sheet, rather than the prior closure snapshot.
    await handleLeanGuide({ ...input, content: '按这份做', metadata: { source: 'chat' } }, publish, model)
  }
}
