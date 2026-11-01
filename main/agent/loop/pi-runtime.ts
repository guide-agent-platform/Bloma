import { join } from 'node:path'
import type { AgentMessage, AgentToolResult, AgentTurnContext } from '@earendil-works/pi-agent-core'
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
import { commandProgressKey, createWorkProgress, isPendingToolExecution, pruneDuplicateReads, toolFailureKey } from './work-progress'
import { createDsmlDisplayFilter } from './dsml-display-filter'
import { drainSteerQueue, markSteerMerged, pendingSteerCount, settleSteerEntry, steerConfirmEnabled, wrapSteerContent, type SteerEntry } from './steer-queue'
import { estimateTokenCount } from './usage-guard'
import { auditBlocks, importLegacyTurns, piImage, toTransportTurns } from './pi-messages'
import { createPiTransport } from './pi-transport'
import { openPiSession, recoverInterruptedTools } from './pi-session-store'
import { observePiRuntime, PI_RETRY_POLICY } from './runtime-observation'
import { resolveModelContext } from '../../platform/llm/model-context'
import { buildActiveSkills } from '../tools/active-skills'

/** Proma bf3e98c adapted to Pi 1.4.0: the SDK owns model/tool turns, retry,
 * persistence, queue draining and compaction. Bloma owns permissions, budgets,
 * evidence and delivery gates. There is no fallback to the legacy executor. */
export async function runPiSession(input: AgentLoopInput): Promise<AgentLoopResult> {
  const contextPolicy = await resolveModelContext(input.env, input.maxTokens)
  input = {...input,maxTokens:Math.min(input.maxTokens,contextPolicy.maxOutputTokens)}
  let cwd: string
  try { cwd = findProject(input.projectId).root_path || process.cwd() } catch { cwd = process.cwd() }
  // C/V receive only their independently scoped materials, never maker skills.
  const activeSkills=await buildActiveSkills(cwd,input.accountingRole==='review',input.runtimeScope==='lean-build')
  input={...input,system:[input.system,activeSkills.prompt].filter(Boolean).join('\n\n'),tools:[...input.tools,...activeSkills.tools.filter(tool=>!input.tools.some(existing=>existing.name===tool.name))]}
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
  const recoveryContext = () => {
    if (!input.recoveryContext) return ''
    try { return input.recoveryContext().slice(0, 8000) }
    catch { return '【宿主工作状态摘要】当前索引不可读；先读公开working-state/resume上下文，不能据历史记录推断当前成功或重放副作用。' }
  }
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
    const { getCurrentSystemMessage } = await import('@earendil-works/pi-ai')
    const agentDir = join(getPromaHome(), 'bloma-pi-runtime')
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: contextPolicy.reserveTokens, keepRecentTokens: contextPolicy.keepRecentTokens },
      retry: PI_RETRY_POLICY, images: { autoResize: false, blockImages: false } })
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noContextFiles: true, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      disabledBuiltinExtensions: ['mcp', 'codemode'],
      appendSystemPrompt: [], agentsFilesOverride: () => ({ agentsFiles: [] }),
      systemPromptOverride: () => input.system, appendSystemPromptOverride: () => [] })
    await resourceLoader.reload()
    // The sentinel authenticates the internal bridge only; never store channel
    // credentials in Pi config or permit native provider HTTP requests.
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false })
    modelRuntime.registerProvider('bloma-transport', { api: 'openai-completions', baseUrl: 'http://127.0.0.1', apiKey: 'bloma-internal-bridge',
      models: [{ id: input.env.ANTHROPIC_MODEL || 'bloma-channel', name: 'Bloma channel', reasoning: true,
        input: ['text', 'image'], contextWindow: contextPolicy.contextWindow, maxTokens: input.maxTokens,
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
      sessionManager: opened.manager, model, thinkingLevel: input.thinkingLevel ?? 'low', noTools: 'all',
      tools: customTools.map(tool => tool.name), excludeTools: ['mcp__*', 'codemode', 'tool_search'], customTools }))
    const activeSession = session
    const expectedTools = input.tools.map(tool => tool.name).sort()
    if (JSON.stringify(activeSession.getActiveToolNames().sort()) !== JSON.stringify(expectedTools)) throw new Error('PI_TOOL_ALLOWLIST_MISMATCH')
    activeSession.agent.toolExecution = 'sequential'
    activeSession.agent.beforeToolCall = async ({toolCall,args}) => {
      if(input.shouldPause?.())return {block:true,reason:'任务范围等待用户确认，后续工具未执行。',terminate:true}
      if(status==='budget_exhausted'||input.signal.aborted)return {block:true,reason:'宿主预算已耗尽或运行已取消，后续工具未执行。',terminate:true}
      // Pi owns schema validation. Host tools require the caller's exact types:
      // never turn path:42 into a write to "42", or silently drop null fields.
      if(JSON.stringify(args)!==JSON.stringify(toolCall.arguments))return {block:true,reason:'TOOL_ARGUMENT_COERCION_REJECTED: 参数类型不符合声明，请按工具schema修正；本次未执行、不消耗工具预算。'}
      return undefined
    }
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
      const systemMessage = getCurrentSystemMessage(converted)
      return [...(systemMessage ? [systemMessage] : []), ...importLegacyTurns(transport, model)]
    }
    const queue = (text: string) => activeSession.agent.followUp({ role: 'user', content: text, timestamp: Date.now() })
    const sdkFinishTurn = activeSession.agent.finishTurn?.bind(activeSession.agent)
    const shouldEndHostTurn = async ({ message, toolResults }: AgentTurnContext) => {
      // Pi 1.x invokes finishTurn for errors too. A failed request is not a
      // completion proposal: let Pi settle/retry it, never start C/V here.
      if (message.stopReason === 'error' || message.stopReason === 'aborted') return true
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
      if (observed?.stalled) { status = 'budget_exhausted'; termination = { reason: 'no_progress',
        limit: observed.repeatedFailures >= 8 ? 8 : 24, observed: observed.repeatedFailures >= 8 ? observed.repeatedFailures : observed.idleTurns }; return true }
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
    // Preserve Pi's own boundary dispatch; host completion/budget/steering still
    // owns whether another turn is allowed. Do not replace the SDK hook outright.
    activeSession.agent.finishTurn = async (turn, signal) => {
      const decision = await sdkFinishTurn?.(turn, signal)
      if (await shouldEndHostTurn(turn)) return { action: 'end' }
      return decision ?? undefined
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
        const progressKey = commandProgressKey(event.toolName, event.args ?? {})
        toolCalls.push({ name: event.toolName, turn: turns, ...(progressKey ? { progressKey } : {}), ...(path ? { path } : {}) })
        input.publish('tool_call_started', { tool: event.toolName, tool_call_id: event.toolCallId, turn: turns, input_summary: JSON.stringify(event.args).slice(0, 500) })
      } else if (event.type === 'tool_execution_end') {
        const call = [...toolCalls].reverse().find(call => call.name === event.toolName && call.turn === turns && !call.status)
        if (call) call.status = event.isError ? 'error' : 'ok'
        const details = event.result.details as { feedback?: ToolFeedback; budgetExhausted?: boolean } | undefined
        const result = event.result as AgentToolResult<unknown>
        if (call?.status === 'ok' && isPendingToolExecution(call.name, result.content.filter(b => b.type === 'text').map(b => b.text).join('\n'))) call.pending = true
        if (call?.status === 'error') {
          const failureKey = toolFailureKey(call.name, result.content.filter(b => b.type === 'text').map(b => b.text).join('\n'))
          if (failureKey) call.failureKey = failureKey
        }
        input.publish('tool_call_completed', { tool: event.toolName, tool_call_id: event.toolCallId, turn: turns,
          status: details?.budgetExhausted ? 'budget' : event.isError ? 'error' : 'ok', is_error: event.isError,
          ...(event.durationMs!==undefined?{duration_ms:event.durationMs}:{}),
          feedback: details?.feedback, output_summary: result.content.filter(b => b.type === 'text').map(b => b.text).join('\n').slice(0, 500),
          ...(() => {const detail=Object.fromEntries(Object.entries((result.details ?? {}) as Record<string, unknown>)
            .filter(([key,value]) => value!==undefined&&['delegation_id', 'child_session_id', 'role', 'goal', 'status', 'pending_question', 'error'].includes(key)))
            return Object.keys(detail).length?{detail}:{} })() })
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
          const restored = recoveryContext()
          if (restored) activeSession.agent.steer({ role: 'user', content: restored, timestamp: Date.now() })
        }
      }
    })
    const [prepared, recall] = await Promise.all([prepareTaskWithSkills(input.task, cwd),
      prepareRecallBlock(input.task, input.delegationDepth ?? 0, `${input.sessionId}.jsonl`, { projectId: input.projectId })])
    const learnings = (input.delegationDepth ?? 0) === 0 ? renderLearningsSection(input.projectId) : ''
    input.onRuntimeObservation?.(observePiRuntime(input, { names: prepared.activatedSkills,
      content: prepared.activatedSkills.length ? prepared.content.slice(0, prepared.content.length - input.task.length) : '',available:activeSkills.available,catalogHash:activeSkills.catalogHash }, learnings + recall, contextPolicy))
    const task = [learnings ? `<untrusted-memory source="learnings" trust="advisory">\n${learnings}\n</untrusted-memory>` : '', recall, prepared.content, recoveryContext()].filter(Boolean).join('\n')
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
    ...(status === 'cancelled' ? { cancel_detail: { phase: 'model_stream' as const, ...(() => {
      const reason=input.signal.reason instanceof Error?input.signal.reason.message:String(input.signal.reason??'')
      return {source:reason.match(/^AGENT_CANCELLED:\s*(.+)$/)?.[1]??'unattributed',reason:reason.slice(0,200)}
    })() } } : {}),
    usage: { inputTokens, outputTokens, estContextTokens, turnsWithUsage, handoffCalls: auxiliaryCalls, graceCalls: 0,
      estTotalTokens: inputTokens + outputTokens } }
}
