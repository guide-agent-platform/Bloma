import { join } from 'node:path'
import type { AgentMessage, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { AgentSession, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { getPromaHome } from '../../../storage/config-paths'
import { appendSessionMessage } from '../../platform/sessions/session-tree'
import { findProject } from '../../project/project-service'
import { prepareTaskWithSkills } from '../../platform/mcp/skill-loader'
import { renderLearningsSection } from '../../project/learnings-log'
import { prepareRecallBlock } from './session-recall'
import { createToolState, executeToolCall, candidateFingerprintOf, type AgentLoopInput, type AgentLoopResult,
  type AgentLoopToolCallRecord, type ToolContext, type LoopCheckpointDecision } from './agent-loop'
import { feedbackForTool } from './tool-feedback'
import { persistentBudgetBlocked, retainedToolFeedback } from '../../../shared/tool-feedback-policy'
import { formatToolFeedback, type ToolFeedback } from '../../../shared/tool-feedback'
import { isDegenerateText } from '../../coding/output-integrity'
import { createWorkProgress, pruneDuplicateReads } from './work-progress'
import { createDsmlDisplayFilter } from './dsml-display-filter'
import { drainSteerQueue, markSteerMerged, pendingSteerCount, settleSteerEntry, steerConfirmEnabled, wrapSteerContent, type SteerEntry } from './steer-queue'
import { estimateTokenCount } from './usage-guard'
import { auditBlocks, importLegacyTurns, piImage, toTransportTurns } from './pi-messages'
import { createPiTransport } from './pi-transport'
import { openPiSession, recoverInterruptedTools } from './pi-session-store'

/** Proma bf3e98c / Pi 0.85.1: the SDK owns model/tool turns, retry,
 * persistence, queue draining and compaction. Bloma owns permissions, budgets,
 * evidence and delivery gates. There is no fallback to the legacy executor. */
export async function runPiSession(input: AgentLoopInput): Promise<AgentLoopResult> {
  let cwd: string
  try { cwd = findProject(input.projectId).root_path || process.cwd() } catch { cwd = process.cwd() }
  const scope = input.runtimeScope === 'lean-build' ? 'lean-build' : `${input.runtimeScope ?? 'default'}:${input.executionScope ?? ''}`
  const opened = await openPiSession(input.projectId, input.sessionId, scope, cwd)
  let session: AgentSession | undefined
  let unsubscribe: (() => void) | undefined
  const cancel = () => { void session?.abort(); session?.abortCompaction(); session?.abortRetry() }
  input.signal.addEventListener('abort', cancel, { once: true })
  const ctx: ToolContext = { projectId: input.projectId, sessionId: input.sessionId, requestId: input.requestId,
    signal: input.signal, state: createToolState(input.delegationDepth ?? 0) }
  ctx.state.execution_scope = input.executionScope
  if (!input.tools.some(tool => tool.name === 'run_gwt_tests')) ctx.state.gwt_all_passed = true
  const toolByName = new Map(input.tools.map(tool => [tool.name, tool]))
  const budgetUsed: Record<string, number> = {}
  const toolCalls: AgentLoopToolCallRecord[] = []
  const decisions: LoopCheckpointDecision[] = []
  const outcomes = new Map<string, { isError: boolean }>()
  const queuedSteers: Array<{ entry: SteerEntry; text: string }> = []
  const injectedSteerTexts: string[] = []
  const progress = input.workMode === 'implementation' ? createWorkProgress() : undefined
  const turnsUsage: NonNullable<AgentLoopResult['turnsUsage']> = []
  let turns = 0, compactions = 0, auxiliaryCalls = 0, inputTokens = 0, outputTokens = 0, turnsWithUsage = 0
  let compacting = false, finalText = '', status: AgentLoopResult['status'] = 'completed'
  let termination: AgentLoopResult['termination_detail']
  let errorMessage: string | undefined
  let invalidOutputRetries = 0, cutoffRetries = 0, budgetStalls = 0, budgetHitThisTurn = false
  let filter = createDsmlDisplayFilter()
  const validation = () => ({ gwt_runs: ctx.state.gwt_runs ?? 0, api_contract_runs: ctx.state.api_contract_runs ?? 0,
    last_gwt_failures: [...(ctx.state.last_gwt_failures ?? [])], gwt_all_passed: ctx.state.gwt_all_passed,
    api_all_passed: ctx.state.api_all_passed, security_all_passed: ctx.state.security_all_passed,
    ...(ctx.state.preflight_passed !== undefined ? { preflight_passed: ctx.state.preflight_passed } : {}),
    file_revisions: Object.fromEntries(ctx.state.file_revisions ?? []) })
  const checkpoint = (trigger: 'steer' | 'gwt' | 'api' | 'security' | 'compaction' | 'final') => {
    const snapshot = validation()
    input.onCheckpoint?.({ session_id: input.sessionId, at_turn: turns, trigger, decisions: [...decisions],
      progress_files: snapshot.file_revisions,
      validation: { ...snapshot, candidate_fingerprint: candidateFingerprintOf(snapshot.file_revisions) } })
  }
  const appendAudit = (message: AgentMessage, userOrigin: 'user' | 'system' = 'system') => {
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'toolResult') return
    const blocks = auditBlocks(message)
    if (blocks.length) appendSessionMessage(input.sessionId, { role: message.role === 'assistant' ? 'assistant' : 'user',
      origin: message.role === 'assistant' ? 'agent' : userOrigin, content: blocks, timestamp: Date.now() })
  }
  try {
    input.signal.throwIfAborted()
    const { createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager } = await import('@earendil-works/pi-coding-agent')
    const agentDir = join(getPromaHome(), 'bloma-pi-runtime')
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 25600, keepRecentTokens: 20000 },
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000 } })
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noContextFiles: true, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      appendSystemPrompt: [], agentsFilesOverride: () => ({ agentsFiles: [] }),
      systemPromptOverride: () => input.system, appendSystemPromptOverride: () => [] })
    await resourceLoader.reload()
    // The sentinel authenticates the internal bridge only; never store channel
    // credentials in Pi config or permit native provider HTTP requests.
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
    modelRuntime.registerProvider('bloma-transport', { api: 'openai-completions', baseUrl: 'http://127.0.0.1', apiKey: 'bloma-internal-bridge',
      models: [{ id: input.env.ANTHROPIC_MODEL || 'bloma-channel', name: 'Bloma channel', reasoning: true,
        input: ['text', 'image'], contextWindow: 128000, maxTokens: input.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] })
    const model = modelRuntime.getModel('bloma-transport', input.env.ANTHROPIC_MODEL || 'bloma-channel')!
    if (!opened.manager.buildSessionContext().messages.length) {
      for (const message of importLegacyTurns(input.historyTurns ?? [], model)) opened.manager.appendMessage(message)
    }
    recoverInterruptedTools(opened.manager)
    const customTools: ToolDefinition[] = input.tools.map(tool => ({ name: tool.name, label: tool.name, description: tool.description,
      parameters: tool.input_schema as unknown as ToolDefinition['parameters'],
      execute: async (id, args, signal) => {
        const toolSignal = signal ? AbortSignal.any([input.signal, signal]) : input.signal
        toolSignal.throwIfAborted()
        ctx.toolCallId = id
        const outcome = await executeToolCall({ ...input, signal: toolSignal }, toolByName, budgetUsed,
          { name: tool.name, id, input: args as Record<string, unknown> }, { ...ctx, signal: toolSignal })
        let feedback = feedbackForTool(tool.name, outcome)
        if (feedback) {
          try { tool.recordFeedback?.(feedback, ctx) } catch {
            feedback = { ...feedback, verification: 'unverified', category: 'verification_harness', recovery: 'inspect', reason: 'EVIDENCE_RECORD_FAILED',
              ...(feedback.evidence ? { evidence: { ...feedback.evidence, freshness: 'unknown' } } : {}) }
          }
          ;(ctx.state.latest_tool_feedback ??= {})[tool.name] = feedback
          if (persistentBudgetBlocked([feedback])) {
            ;(ctx.state.terminal_budget_feedback ??= {})[tool.name] = feedback
            status = 'budget_exhausted'; termination = { reason: 'persistent_tool_budget' }
          }
        }
        if (['write_file', 'edit_file'].includes(tool.name) && !outcome.isError && !outcome.budgetExhausted && typeof outcome.detail?.path === 'string') {
          ctx.state.successful_file_changes = [...new Set([...(ctx.state.successful_file_changes ?? []), outcome.detail.path])]
        }
        budgetHitThisTurn ||= outcome.budgetExhausted === true
        outcomes.set(id, { isError: outcome.isError === true || outcome.budgetExhausted === true })
        const content = feedback ? formatToolFeedback(feedback, outcome.output) : outcome.output
        const assistantEntry = [...opened.manager.getBranch()].reverse().find(entry => entry.type === 'message' && entry.message.role === 'assistant')
        opened.manager.appendCustomEntry('bloma-tool-receipt', { id, assistantEntryId: assistantEntry?.id, name: tool.name, content,
          isError: outcome.isError === true || outcome.budgetExhausted === true })
        return { content: [{ type: 'text' as const, text: content }, ...(outcome.images ?? []).map(piImage)],
          details: { ...outcome.detail, feedback, budgetExhausted: outcome.budgetExhausted } }
      },
    }))
    ;({ session } = await createAgentSession({ cwd, agentDir, modelRuntime, settingsManager, resourceLoader,
      sessionManager: opened.manager, model, thinkingLevel: input.thinkingLevel ?? 'low', noTools: 'builtin', customTools }))
    const activeSession = session
    activeSession.agent.toolExecution = 'sequential'
    activeSession.agent.beforeToolCall = async () => input.shouldPause?.()
      ? { block: true, reason: '任务范围等待用户确认，后续工具未执行。', terminate: true }
      : status === 'budget_exhausted' || input.signal.aborted
      ? { block: true, reason: '宿主预算已耗尽或运行已取消，后续工具未执行。', terminate: true } : undefined
    activeSession.agent.afterToolCall = async ({ toolCall, isError }) => ({ isError: outcomes.get(toolCall.id)?.isError ?? isError })
    activeSession.agent.streamFunction = createPiTransport(input, {
      isCompacting: () => compacting,
      beforeRequest: auxiliary => {
        input.signal.throwIfAborted()
        if (input.shouldPause?.()) throw new Error('BLOMA_HOST_DECISION_PENDING')
        if (status !== 'completed') throw new Error('BLOMA_RUNTIME_STOPPED')
        if (auxiliary) { auxiliaryCalls += 1; return }
        if (turns >= input.maxTurns) { status = 'turn_limit'; throw new Error('BLOMA_TURN_LIMIT') }
        turns += 1; budgetHitThisTurn = false
      },
      onUsage: (incoming, outgoing, auxiliary) => {
        inputTokens += incoming; outputTokens += outgoing; turnsWithUsage += 1
        if (!auxiliary) turnsUsage.push({ turn: turns, inputTokens: incoming, outputTokens: outgoing })
      },
      onFailure: error => {
        // Preserve the transport's structured permanent-denial decision. Pi's
        // generic text classifier must not retry a fixed quota or account block.
        if (error && typeof error === 'object' && 'nonRetryable' in error && error.nonRetryable === true) settingsManager.setRetryEnabled(false)
      },
    })
    // Pruning only changes provider input; native transcript/audit keep full evidence.
    const convert = activeSession.agent.convertToLlm.bind(activeSession.agent)
    activeSession.agent.convertToLlm = async messages => {
      const converted = await convert(messages)
      if (!progress) return converted
      const transport = toTransportTurns({ messages: converted })
      pruneDuplicateReads(transport)
      return importLegacyTurns(transport, model)
    }
    const queue = (text: string) => activeSession.agent.followUp({ role: 'user', content: text, timestamp: Date.now() })
    activeSession.agent.shouldStopAfterTurn = async ({ message, toolResults }) => {
      if (input.shouldPause?.()) return true
      if (input.signal.aborted) { status = 'cancelled'; return true }
      if (status !== 'completed') return true
      if (ctx.state.compact_requested && turns < input.maxTurns) return true
      const calls = toolCalls.filter(call => call.turn === turns)
      budgetStalls = budgetHitThisTurn ? budgetStalls + 1 : 0
      if (budgetStalls >= 2) { status = 'budget_exhausted'; return true }
      if (message.stopReason === 'length') {
        if (cutoffRetries++ < 2 && turns < input.maxTurns) queue('上一轮达到单次输出上限，响应被截断，不代表完成。请拆成更小步骤继续实现与验证。')
        else { status = 'turn_limit'; termination = { reason: 'output_token_limit', retries: cutoffRetries - 1 }; return true }
      } else if (toolResults.length === 0 && isDegenerateText(finalText)) {
        if (invalidOutputRetries++ < 1 && turns < input.maxTurns) queue('上一轮输出包含工具协议原文或退行重复，未执行其中的指令。请正常调用已装配工具或给出干净的结果总结。')
        else { status = 'turn_limit'; termination = { reason: 'degenerate_output', retries: invalidOutputRetries - 1 }; return true }
      } else if (toolResults.length === 0) {
        const feedback = await input.beforeComplete?.(ctx)
        if (feedback) queue(feedback)
      }
      const observed = toolResults.length ? progress?.observe(calls) : undefined
      if (observed?.stalled) { status = 'budget_exhausted'; termination = { reason: 'no_progress', limit: 24, observed: observed.idleTurns }; return true }
      if (observed?.nudge) activeSession.agent.steer({ role: 'user', content: observed.nudge, timestamp: Date.now() })
      if (turns >= input.maxTurns && (toolResults.length > 0 || activeSession.agent.hasQueuedMessages() || pendingSteerCount(input.sessionId) > 0)) {
        status = 'turn_limit'; return true
      }
      if ((input.delegationDepth ?? 0) === 0) {
        for (const entry of drainSteerQueue(input.sessionId)) {
          const text = wrapSteerContent(entry.content)
          queuedSteers.push({ entry, text })
          activeSession.agent.steer({ role: 'user', content: text, timestamp: Date.now() })
        }
      }
      return false
    }
    let initialUser = true
    unsubscribe = activeSession.subscribe(event => {
      if (event.type === 'message_start' && event.message.role === 'user') {
        const text = typeof event.message.content === 'string' ? event.message.content : event.message.content.filter(b => b.type === 'text').map(b => b.text).join('')
        const index = queuedSteers.findIndex(queued => queued.text === text)
        const queued = index >= 0 ? queuedSteers.splice(index, 1)[0] : undefined
        if (queued) {
          injectedSteerTexts.push(text)
          const { entry } = queued
          if (steerConfirmEnabled() && entry.steerId) markSteerMerged(input.sessionId, entry.steerId)
          const id = `steer-${turns}-${decisions.length}`
          for (const decision of decisions) if (!decision.superseded_by) decision.superseded_by = id
          decisions.push({ id, kind: 'steer', text, at_turn: turns })
          input.publish('steer_injected', { content: entry.content, message: text, at_turn: turns, remaining: pendingSteerCount(input.sessionId),
            ...(entry.steerId ? { steer_id: entry.steerId, status: 'merged_this_run' } : {}) })
          checkpoint('steer')
        }
      } else if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        for (const text of filter.push(event.assistantMessageEvent.delta)) input.publish('message_delta', { text })
      } else if (event.type === 'message_end') {
        if (event.message.role === 'assistant') {
          finalText = event.message.content.filter(b => b.type === 'text').map(b => b.text).join('')
          errorMessage = event.message.stopReason === 'error' ? event.message.errorMessage : undefined
          for (const text of filter.end()) input.publish('message_delta', { text })
          filter = createDsmlDisplayFilter()
        }
        if (event.message.role === 'user' && initialUser) {
          initialUser = false
          if (input.initialMessagePersisted) return
          const blocks = [{ type: 'text' as const, text: input.task }, ...(input.images ?? []).map(ref => ({ type: 'image' as const, imageId: ref.imageId, media_type: ref.media_type }))]
          appendSessionMessage(input.sessionId, { role: 'user', origin: 'user', content: blocks, timestamp: Date.now() })
        } else {
          const text = event.message.role === 'user' ? auditBlocks(event.message).filter(b => b.type === 'text').map(b => b.text).join('') : ''
          const index = injectedSteerTexts.indexOf(text)
          if (index >= 0) injectedSteerTexts.splice(index, 1)
          appendAudit(event.message, index >= 0 ? 'user' : 'system')
        }
      } else if (event.type === 'tool_execution_start') {
        const path = typeof event.args?.path === 'string' ? event.args.path : undefined
        toolCalls.push({ name: event.toolName, turn: turns, ...(path ? { path } : {}) })
        input.publish('tool_call_started', { tool: event.toolName, tool_call_id: event.toolCallId, turn: turns, input_summary: JSON.stringify(event.args).slice(0, 500) })
      } else if (event.type === 'tool_execution_end') {
        const call = [...toolCalls].reverse().find(call => call.name === event.toolName && call.turn === turns && !call.status)
        if (call) call.status = event.isError ? 'error' : 'ok'
        const details = event.result.details as { feedback?: ToolFeedback; budgetExhausted?: boolean } | undefined
        const result = event.result as AgentToolResult<unknown>
        input.publish('tool_call_completed', { tool: event.toolName, tool_call_id: event.toolCallId, turn: turns,
          status: details?.budgetExhausted ? 'budget' : event.isError ? 'error' : 'ok', is_error: event.isError,
          feedback: details?.feedback, output_summary: result.content.filter(b => b.type === 'text').map(b => b.text).join('\n').slice(0, 500),
          detail: Object.fromEntries(Object.entries((result.details ?? {}) as Record<string, unknown>)
            .filter(([key]) => ['delegation_id', 'child_session_id', 'role', 'goal', 'status', 'pending_question', 'error'].includes(key))) })
        if (event.toolName === 'run_gwt_tests') checkpoint('gwt')
        if (event.toolName === 'run_api_contract_tests') checkpoint('api')
        if (event.toolName === 'run_security_scan') checkpoint('security')
      } else if (event.type === 'turn_end') {
        const usage = [...turnsUsage].reverse().find(usage => usage.turn === turns)
        input.onTurn?.({ turn: turns, failed: event.message.role === 'assistant' && ['error', 'aborted', 'length'].includes(event.message.stopReason),
          toolCalls: toolCalls.filter(call => call.turn === turns), inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens })
      } else if (event.type === 'compaction_start') compacting = true
      else if (event.type === 'compaction_end') {
        compacting = false
        if (event.result) {
          compactions += 1
          input.onCompaction?.({ at_turn: turns, segment: compactions, est_tokens_before: event.result.tokensBefore,
            est_tokens_after: event.result.estimatedTokensAfter, retained_turns: activeSession.messages.length,
            removed_turns: 0, handoff_chars: event.result.summary.length, handoff_fallback: false,
            trigger: event.reason === 'manual' ? 'explicit' : 'auto' })
          checkpoint('compaction')
        }
      }
    })
    const [prepared, recall] = await Promise.all([prepareTaskWithSkills(input.task, cwd),
      prepareRecallBlock(input.task, input.delegationDepth ?? 0, `${input.sessionId}.jsonl`, { projectId: input.projectId })])
    const learnings = (input.delegationDepth ?? 0) === 0 ? renderLearningsSection(input.projectId) : ''
    const task = [learnings ? `<untrusted-memory source="learnings" trust="advisory">\n${learnings}\n</untrusted-memory>` : '', recall, prepared.content].filter(Boolean).join('\n')
    input.signal.throwIfAborted()
    await activeSession.prompt(task, { source: 'rpc', expandPromptTemplates: false, images: input.images?.map(piImage) })
    await activeSession.waitForIdle()
    while (ctx.state.compact_requested && status === 'completed' && !input.signal.aborted && turns < input.maxTurns) {
      ctx.state.compact_requested = false
      if ((ctx.state.explicit_compactions ?? 0) >= 4) throw new Error('PI_EXPLICIT_COMPACTION_LIMIT')
      ctx.state.explicit_compactions = (ctx.state.explicit_compactions ?? 0) + 1
      await activeSession.compact()
      await activeSession.agent.continue()
      await activeSession.waitForIdle()
    }
    if (input.signal.aborted) status = 'cancelled'
    else if (errorMessage && status === 'completed') throw new Error(errorMessage)
  } catch (error) {
    if (input.signal.aborted) status = 'cancelled'
    else throw error
  } finally {
    input.signal.removeEventListener('abort', cancel)
    unsubscribe?.()
    if ((input.delegationDepth ?? 0) === 0) {
      queuedSteers.push(...drainSteerQueue(input.sessionId).map(entry => ({ entry, text: wrapSteerContent(entry.content) })))
    }
    try {
      for (const { entry, text } of queuedSteers) {
        if (!input.signal.aborted) {
          const message = { role: 'user' as const, content: text, timestamp: Date.now() }
          opened.manager.appendMessage(message)
          appendAudit(message, 'user')
        }
        if (steerConfirmEnabled() && entry.steerId) settleSteerEntry(input.sessionId, entry.steerId,
          input.signal.aborted ? 'rejected' : 'deferred_next_run')
      }
    } finally {
      try { session?.dispose() } finally { opened.release() }
    }
  }
  checkpoint('final')
  const estContextTokens = estimateTokenCount(JSON.stringify(session?.messages ?? []))
  const toolFeedback = retainedToolFeedback([...Object.values(ctx.state.latest_tool_feedback ?? {}).map(f => f.evidence
    ? { ...f, verification: 'unverified' as const, evidence: { ...f.evidence, freshness: 'unknown' as const } } : f),
  ...input.tools.flatMap(tool => {
    try { return tool.collectFeedback?.(ctx) ?? [] } catch { return [{ schema_version: 1 as const, execution: 'not_run' as const,
      verification: 'unverified' as const, category: 'verification_harness' as const, recovery: 'inspect' as const, reason: 'EVIDENCE_COLLECTION_FAILED' }] }
  }), ...Object.values(ctx.state.terminal_budget_feedback ?? {})])
  input.publish('usage_summary', { session_id: input.sessionId, input_tokens: inputTokens, output_tokens: outputTokens,
    est_context_tokens: estContextTokens, turns_with_usage: turnsWithUsage })
  return { status, turns, finalText, toolCalls, files_changed: ctx.state.successful_file_changes, tool_feedback: toolFeedback,
    validation: validation(), turnsUsage, ...(termination ? { termination_detail: termination } : {}),
    ...(status === 'cancelled' ? { cancel_detail: { phase: 'model_stream' as const, reason: String(input.signal.reason ?? '') } } : {}),
    usage: { inputTokens, outputTokens, estContextTokens, turnsWithUsage, handoffCalls: auxiliaryCalls, graceCalls: 0,
      estTotalTokens: inputTokens + outputTokens } }
}
