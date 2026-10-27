import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SDKQuery } from '../orchestration/stages/orchestration-contracts'
import { runAgentLoop } from '../agent/loop/agent-loop'
import { registerParentLoopContext, disposeParentDelegationState, stopDelegations, settleParentDelegationRuns } from '../agent/delegation/agent-collaboration'
import { findProject, updateProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { readConfirmedUxBinding } from '../project/ux-binding'
import { prdScopeFingerprint, requirementEvidenceHash } from '../project/requirement-contract'
import { buildDesktopChildTools, buildDesktopEnvProbeTool } from './dispatcher-loop'
import { productionAgentTools } from './production-agent'
import { leanBudget, leanBudgetStopMessage, withLeanRuntime } from './lean-budget'
import { guardDispatcherCompletion } from './dispatcher-completion'
import { provisionDesktopSkeletonV2 } from './skeleton-provision'
import { runCoreVerification, type CoreVerificationResult } from './core-verification'
import { verificationFingerprint, softwareVerificationFingerprint } from './verification-fingerprint'
import { consumeProjectAttempt, resetProjectAttemptScope } from '../platform/execution/project-attempts'
import { commitDesktopDelivery } from './delivery-state'
import { defaultLaunchSmokeGate, defaultQuickSecurityGate, type DesktopRouteDeps, type DesktopRouteInput } from './desktop-route'
import { sessionMaterials } from '../platform/attachments/material-context'
import { buildLeanGuiTool } from './lean-gui-tool'
import { buildLeanCliTool, cliSuitePath } from './lean-cli-check'
import { guiSuitePath } from './gui-acceptance'
import { readLaunchDeclaration, runLaunchSmoke } from './launch-smoke'
import { createHash, randomUUID } from 'node:crypto'
import { finishCorrectionSession, hasActiveCorrectionSession, settleCorrectionTeardown } from './correction-session'
import { readCorrectionSubmission, clearCorrectionSubmission } from './correction-outbox'
import { appendSessionMessage } from '../platform/sessions/session-tree'
import { buildLeanScopeTool } from './lean-scope-tool'
import { writeTextFileAtomic } from '../../storage/json-store'
import { isSoftwareProject } from './workflow-policy'
import { createSoftwareCollaborationPolicy } from '../software/collaboration-policy'
import { buildSoftwareAgentTools, SOFTWARE_ENGINEERING_INSTRUCTIONS } from '../software/agent-tools'
import { stopSoftwareSession } from '../software/process-manager'
import { closeDebugSessions, retainedDebugVersion } from '../software/debug-sessions'
import { prepareSoftwareRelease, promoteSoftwareRelease, verifyReleaseSource } from '../software/release-store'
import { saveSoftwareRegressionBaseline } from '../software/regression-baseline'
import { verifySoftwareCandidate, recentSoftwareVerification } from '../software/verification'
import { importedProjectContext } from '../software/import-project'
import { saveSoftwareRunState, readSoftwareRunState, recordSoftwareRepair, type SoftwareRunStatus } from '../software/run-state'
import { monetaryStopMessage, monetaryInputBlocked } from '../platform/llm/monetary-budget'
import { trialFeedbackText } from '../software/trial'
import { prepareIndependentDesign } from '../software/independent-design'
import { recordEvaluationEvent } from '../software/harness-evaluation'

// Dissatisfaction is a repair request, not cancellation of the new workflow.
const isStop = (text: string) => text.split(/[，。；！？,;!?\n]+/).some(part => /^(?:(?:请|先|现在|马上|暂时)\s*)*(?:停止|取消|暂停|停下|先停|别推进|暂缓|先别做|不要开工|stop|cancel|pause)(?:(?:当前|本次|这个)?(?:任务|流程|运行|执行|制作)|一下|吧|了|\s)*$/i.test(part.trim()))

/** A continuous Pi executor followed by one host verification boundary. No
 * dispatcher dialogue, PHASE_ADVANCE markers or synthetic architecture stages. */
export async function runLeanProduction(input: DesktopRouteInput, deps: DesktopRouteDeps): Promise<void> {
  recordEvaluationEvent(input.projectId,'operation_started',{session_id:input.sessionId,request_id:input.requestId})
  const project = findProject(input.projectId)
  if (isSoftwareProject(input.projectId) && /^(?:继续|恢复|查看进度|查看结果)[。！!\s]*$/.test(input.content.trim())) {
    const saved = readSoftwareRunState(input.projectId)
    if (saved?.status === 'waiting_environment' && saved.operationId === project.lean_operation_id && saved.source
      && saved.source === softwareVerificationFingerprint(project.root_path)) {
      deps.publish(input, 'message_delta', { text: saved.error ?? '本机试用版本已保留，独立环境验收仍待完成；当前没有新的环境证据。' })
      deps.complete(input.sessionId, input.projectId, 'incomplete'); return
    }
  }
  if (/^(?:谢谢|谢谢你|好的|收到|查看进度|查看结果)[。！!\s]*$/.test(input.content.trim()) || project.status === 'completed' && /^(?:继续|恢复)[。！!\s]*$/.test(input.content.trim())
    && !readCorrectionSubmission(input.projectId) && !hasActiveCorrectionSession(input.projectId)) {
    deps.publish(input, 'message_delta', { text: project.status === 'completed' ? '产物和验证记录已保留，可启动试用或继续提出修改。' : '当前现场已保留，可继续制作或提出具体修改。' })
    deps.complete(input.sessionId, input.projectId, project.status === 'completed' ? undefined : 'incomplete'); return
  }
  if (project.status === 'completed' && !isStop(input.content)) {
    // A new explicit user task, never a repair/resume/requirement revision.
    updateProject(input.projectId, { lean_operation_id: randomUUID(), status: 'active' })
  }
  if (!isStop(input.content)) {
    if (hasActiveCorrectionSession(input.projectId)) finishCorrectionSession({ projectId: input.projectId })
    if (isSoftwareProject(input.projectId)) await settleCorrectionTeardown(input.projectId)
    const correction = readCorrectionSubmission(input.projectId)
    if (correction) {
      const content = input.content.includes(correction.content) ? input.content : `${correction.content}\n用户补充：${input.content}`
      appendSessionMessage(input.sessionId, { role: 'user', origin: 'user', client_message_id: correction.id,
        content: [{ type: 'text', text: content }], timestamp: Date.now() })
      const query = input.query
      // Admission failure leaves the outbox pending. Once a model request starts,
      // Pi already owns the durable task; later continuation reads its transcript.
      input = { ...input, content, initialMessagePersisted: true, query: async function* (prompt, options) {
        clearCorrectionSubmission(correction.projectId, correction.id)
        yield* query(prompt, options)
      } }
    }
  }
  try {
    const finish = await withLeanRuntime(input.projectId, 'desktop-implement', input.signal,
      signal => runLeanProductionInner({ ...input, signal }, deps))
    await finish?.()
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error)
    const monetaryNotice = monetaryStopMessage(error)
    const reason = monetaryNotice ? `${code}：${monetaryNotice}` : code
    if (!input.signal?.aborted && !/LEASE_ACTIVE|ALREADY_ACTIVE/.test(reason)) updateProject(input.projectId, { status: 'active', current_stage: 'generating_mvp', desktop_phase: 'desktop-implement',
      desktop_blocked: { reason: 'verification-incomplete', note: reason, at: new Date().toISOString() } })
    const text = `本次执行未完成，现场与用量保留：${reason}`
    deps.persistAssistant(input.sessionId, text); deps.publish(input, 'message_delta', { text })
    deps.complete(input.sessionId, input.projectId, 'incomplete')
  }
}

async function runLeanProductionInner(input: DesktopRouteInput, deps: DesktopRouteDeps): Promise<(() => Promise<void>) | undefined> {
  const project = findProject(input.projectId)
  const signal = input.signal ?? new AbortController().signal
  if (signal.aborted) return
  if (isStop(input.content)) {
    if (project.status !== 'completed') updateProject(input.projectId, { desktop_blocked: { reason: 'user-stop', note: input.content.slice(0, 200), at: new Date().toISOString() } })
    if (isSoftwareProject(input.projectId)) saveSoftwareRunState({ projectId: input.projectId, sessionId: input.sessionId, runId: randomUUID(), status: 'cancelled', error: input.content.slice(0, 200) })
    deps.publish(input, 'message_delta', { text: '已停止，已有文件和修改意见已保留。' }); deps.complete(input.sessionId, input.projectId, 'incomplete'); return
  }
  const brief = readPrdBackplane(input.projectId), scope = prdScopeFingerprint(brief)
  const software = isSoftwareProject(input.projectId)
  const continuation=/^(?:继续|恢复|验收|重新验收|运行验收|按已确认目标制作|开始桌面交付流程)[。！!\s]*$/.test(input.content.trim())
  const originalSource=software?softwareVerificationFingerprint(project.root_path):undefined
  const runId = randomUUID()
  const checkpoint = (status: SoftwareRunStatus, patch: { error?: string; candidateId?: string; source?: string; check?: { path: string; sha256: string } } = {}) => {
    if (software) saveSoftwareRunState({ projectId: input.projectId, sessionId: input.sessionId, runId, status, ...patch })
  }
  const collaboration = software ? createSoftwareCollaborationPolicy(input.projectId, project.root_path, input.sessionId) : undefined
  const versionOf = () => {
    const current = readPrdBackplane(input.projectId)
    const rules = [guiSuitePath(input.projectId), cliSuitePath(input.projectId)].map(file =>
      existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null)
    return verificationFingerprint(project.root_path, { scope: prdScopeFingerprint(current), confirmed: Boolean(current.user_confirmed_at),
      ux: findProject(input.projectId).ux_confirmation ?? null, rules }, software ? 'software' : 'standard')
  }
  const emit = (type: Parameters<DesktopRouteDeps['publish']>[1], payload: Record<string, unknown>) => deps.publish(input, type, payload)
  const blocked = (reason: string, confirmation = false, state: SoftwareRunStatus = 'blocked') => {
    if (software && /\b(?:MONETARY_(?:BUDGET|OPERATION)_EXHAUSTED|HARNESS_(?:REQUEST|OUTPUT)_BUDGET_EXHAUSTED|REQUEST_BUDGET_EXHAUSTED)\b/.test(reason)) {
      try {
        const observed = retainedDebugVersion(input.projectId, input.sessionId)
        const current = observed && softwareVerificationFingerprint(project.root_path)
        if (current && current !== observed.source) reason += '\n当前文件还包含上次宿主观察之后的修改，尚未确认这些修改能正常运行；不能把上次可用画面当作当前版本。修改与旧观察已保留，恢复时应先核对这部分差异。'
      } catch { reason += '\n无法核对上次观察版本，当前修改仍未验收；恢复时先核对文件和运行结果。' }
    }
    updateProject(input.projectId, { status: 'active', current_stage: confirmation ? 'blocked_for_user_decision' : 'generating_mvp', desktop_phase: confirmation ? undefined : 'desktop-implement',
      desktop_blocked: { reason: 'verification-incomplete', note: reason, at: new Date().toISOString() } })
    checkpoint(confirmation ? 'waiting_user' : state, { error: reason })
    deps.persistAssistant(input.sessionId, reason)
    emit('message_delta', { text: reason }); deps.complete(input.sessionId, input.projectId, 'incomplete')
  }
  if (!brief.user_confirmed_at || !brief.lean_brief) { blocked('目标尚未确认，本次没有开始制作。', true); return }
  let ux: ReturnType<typeof readConfirmedUxBinding>
  try { ux = readConfirmedUxBinding(input.projectId, brief) } catch (error) { blocked(String(error), true); return }
  if (!software && brief.lean_brief.ui === 'required') provisionDesktopSkeletonV2(project.root_path, project.name, { includeScaffold: false })
  const budget = leanBudget(input.projectId, 'desktop-implement')
  let initialBudgetStop: string | undefined
  if (software) {
    const admission = budget.admission()
    if (!admission.allowed) {
      const registered = brief.lean_brief.ui === 'required' ? guiSuitePath(input.projectId) : cliSuitePath(input.projectId)
      if (!existsSync(registered)) { blocked(leanBudgetStopMessage(input.projectId, 'desktop-implement', admission.reason!)); return }
      if(!continuation&&!(await recentSoftwareVerification(input.projectId,input.requestId,signal))){blocked('本轮新请求尚未由模型处理，现有测试只覆盖此前确认的目标，不能据此宣称新请求已完成。进度和预算已保留。');return}
      initialBudgetStop = admission.reason
    }
    if(!initialBudgetStop&&monetaryInputBlocked(input.env.ANTHROPIC_BASE_URL,input.env.ANTHROPIC_MODEL)){
      const registered=brief.lean_brief.ui==='required'?guiSuitePath(input.projectId):cliSuitePath(input.projectId)
      if(!existsSync(registered)){blocked('当前金额保护连保守输入预留都无法放行，尚未发出模型请求。现有验收规则缺失，程序和账本已保留；不能跳过检查交付。');return}
      if(!continuation&&!(await recentSoftwareVerification(input.projectId,input.requestId,signal))){blocked('当前金额保护未放行模型，本轮新请求尚未处理；不能用旧版测试替代新增或修改目标的验收。已有程序和账本已保留。');return}
      initialBudgetStop='MONETARY_BUDGET_EXHAUSTED'
      emit('message_delta',{text:'当前金额保护无法放行新的模型请求；已有冻结测试，我先停止模型调用，执行免费的宿主验收。只有实际通过才交付。'})
    }
  }
  if (software && !initialBudgetStop) {
    const design = await prepareIndependentDesign({projectId:input.projectId,sessionId:input.sessionId,query:input.query,primaryEnv:input.env,signal})
    if(design.status==='blocked'){blocked(`独立验收设计尚未就绪：${design.reason}`);return}
  }
  checkpoint('running', { source: software ? softwareVerificationFingerprint(project.root_path) : undefined })
  const runSignal = signal
  const budgetedQuery = budget.wrap(input.query)
  let monetaryFailure: unknown
  // Pi persists an error string. Retain this run's typed refusal at the query
  // boundary so its cost breakdown survives the native session adapter.
  const query: SDKQuery = async function* (prompt, options) {
    try { yield* budgetedQuery(prompt, options) }
    catch (error) { if (monetaryStopMessage(error)) monetaryFailure = error; throw error }
  }
  const baseTools = collaboration ? buildSoftwareAgentTools(input.projectId, 'parent', collaboration,
    url => emit('software_preview_changed', { preview_url: url ?? null }), () => emit('software_suggestions_changed', {})) : buildDesktopChildTools(input.projectId, 'implement', 'diff')
  let scopePending = false
  const tools = productionAgentTools(baseTools, [...(software ? [] : [buildDesktopEnvProbeTool()]),
    buildLeanScopeTool(input.projectId, input.content, emit, () => { scopePending = true }),
    brief.lean_brief.ui === 'required' ? buildLeanGuiTool(input.projectId) : buildLeanCliTool(input.projectId)])
  const system = [
    software ? SOFTWARE_ENGINEERING_INSTRUCTIONS : '根据已确认目标直接制作、集成和修复程序，中文简短报告实际结果。你持有项目文件和受控执行工具；先完成真实主使用路径，再补全本次承诺。仅独立且能减少总工作的任务才委派。',
    `项目根：${project.root_path}。已有平台组件和骨架优先复用，当前未有的环境先探测；不重做已证明的环境研究。不要求架构文档、阶段任务书或推进标记。`,
    ...(software && project.imported_source ? [JSON.stringify(importedProjectContext(input.projectId))] : []),
    ux?.html_path ? `已确认外观：${ux.html_path}，先读后沿用；用户后续修改仅改相关部分。` : brief.lean_brief.ui === 'required' ? '用户明确授权直接制作界面，无需先画草图。' : '本任务无需额外外观设计。',
    '局部外观和缺陷直接修改。用户新增、删除业务能力或改变业务预期时，先用propose_scope_change保留原功能及新增预期并等待确认，不能在旧任务单下宣称新增功能已验收。',
    JSON.stringify({ goal: brief.positioning, requirements: brief.requirements.map(row => ({ id: row.id, description: row.description,
      expected: brief.acceptance[row.id], requirement_hash: requirementEvidenceHash(brief, row) })), constraints: brief.constraints,
      out_of_scope: brief.out_of_scope, assumptions: brief.assumptions, delivery: brief.lean_brief.delivery, distribution: brief.lean_brief.distribution ?? 'local' }),
    '保留真实用户数据与配置；测试使用隔离数据目录。预期依据已确认目标，不能改预期掩盖失败。特殊能力登记与执行细节可通过read_production_context按需读取。',
    '不强制额外测试脚本或自报PASS。特殊能力需要时在CORE_CHECK.json只登记实际入口，例如llm/speech；用read_production_context按需查看协议。未实现或未验证的必需能力如实保留。',
    brief.lean_brief.ui === 'required' ? `界面任务登记register_gui_check：steps需id/kind/selector，expect用equals；仅留存任务加restart且重开后仍需expect。${software ? '宿主绑定已确认预期，不用复制expectations；只提交steps和acceptance_refs（expect步骤id→F编号数组）。' : 'expectations保留任务单预期，acceptance_refs把expect步骤关联F编号。'}宿主独立操作应用，登记不等于通过。` : '无界面任务登记register_cli_check：固定args与stdout/exit_code，宿主调用实际LAUNCH入口。一次性命令在LAUNCH写mode:"command"，服务默认保持运行。',
    software ? '宿主将独立运行核心检查、安全扫描及正常启动；你结束执行不等于交付通过。' : '产物根写LAUNCH.json：{"schema_version":1,"command":["python","app.py"],"window_title":"实际标题","ui":"webview"}，按实际入口填写。宿主将独立运行核心检查、安全扫描及正常启动；你结束执行不等于交付通过。',
  ].join('\n\n')
  // Shared physical-request, output, monetary and active-time budgets own the
  // stop boundary; another 96-turn limit only interrupts useful work early.
  const maxTurns = software ? Number.MAX_SAFE_INTEGER : 96
  registerParentLoopContext(input.sessionId, { query, env: input.env, maxTokens: Math.min(input.maxTokens, 16384), maxTurns,
    delegationMaxTurns: 24, permissionMode: 'allow-all', temperature: .1, system, editFormat: 'diff', runtime: 'pi', runtimeScope: 'lean-build',
    executionScope: budget.executionScope, materials: sessionMaterials(input.projectId, input.sessionId), publish: emit,
    ...(collaboration ? { maxConcurrentDelegations: 2, allowChannelOverrides: false, delegationSummaryLimit: 3000,
      prepareDelegation: collaboration.prepare,
      childSystemBuilder: (_role: import('../../shared/delegation-run-context').DelegationRunRole, child: string) =>
        `完成主负责人交付的具体子任务，先读相关文件，沿用现有接口。项目根：${project.root_path}。文件权限：${collaboration.describe(child)}。仅在归属范围内修改；不运行命令、不再委派、不修改目标/验收输入。需要跨边界修改时回报主负责人。简短交接实际修改、检查和未验证项，不自报产品通过。全局约束：${JSON.stringify(brief.constraints)}` } : {}),
    childToolsBuilder: (id, role, format) => collaboration ? buildSoftwareAgentTools(id, role, collaboration) : buildDesktopChildTools(id, role, format) })
  const cancelChildren = () => { stopDelegations(input.sessionId) }
  runSignal.addEventListener('abort', cancelChildren, { once: true })
  let task = input.observedSoftwareVersion ? trialFeedbackText(input.projectId, input.observedSoftwareVersion, input.content) : input.content
  let initial = true
  try {
    for (;;) {
      runSignal.throwIfAborted()
      updateProject(input.projectId, { status: 'active', desktop_phase: 'desktop-implement', current_stage: 'generating_mvp', desktop_blocked: undefined })
      emit('stage_changed', { stage: 'desktop-implement' })
      let result: Awaited<ReturnType<typeof runAgentLoop>> | undefined, modelBudgetStop: string | undefined
      if (initialBudgetStop) { modelBudgetStop = initialBudgetStop; initialBudgetStop = undefined }
      else try { result = await runAgentLoop({ runtime: 'pi', runtimeScope: 'lean-build', system, task, query, env: input.env, tools,
        projectId: input.projectId, sessionId: input.sessionId, requestId: input.requestId, signal: runSignal,
        maxTokens: Math.min(input.maxTokens, 16384), maxTurns, permissionMode: 'allow-all', workMode: 'implementation', executionScope: budget.executionScope,
        materials: sessionMaterials(input.projectId, input.sessionId), images: initial ? input.images : undefined,
        initialMessagePersisted: initial ? input.initialMessagePersisted : false,
        shouldPause: () => scopePending,
        beforeComplete: ctx => guardDispatcherCompletion(ctx), publish: emit }) }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const detailedError = monetaryFailure instanceof Error && reason.includes(monetaryFailure.message) ? monetaryFailure : error
        const admissionCode = detailedError instanceof Error ? detailedError.message : reason
        const admissionStopped = /^(?:HARNESS_(?:REQUEST|OUTPUT)_BUDGET_EXHAUSTED|REQUEST_BUDGET_EXHAUSTED|MONETARY_(?:BUDGET|OPERATION)_EXHAUSTED)$/.test(admissionCode)
        const registered = brief.lean_brief.ui === 'required' ? guiSuitePath(input.projectId) : cliSuitePath(input.projectId)
        if (!software || runSignal.aborted || !admissionStopped || !existsSync(registered)) throw detailedError
        if(!continuation&&originalSource===softwareVerificationFingerprint(project.root_path)&&!(await recentSoftwareVerification(input.projectId,input.requestId,runSignal)))throw detailedError
        modelBudgetStop = reason
        emit('message_delta', { text: `${monetaryStopMessage(detailedError) ?? '模型请求额度已到，当前进度已保留。'}已有验收规则，我会停止模型调用，继续运行宿主检查；只有实际通过才交付。` })
      }
      initial = false
      if (scopePending) { checkpoint('waiting_user'); deps.complete(input.sessionId, input.projectId, 'incomplete'); return }
      if (!modelBudgetStop && result?.status !== 'completed') { blocked(result?.status === 'cancelled' ? '已停止，程序和现场已保留。' : `制作尚未完成（${result?.termination_detail?.reason ?? result?.status}），可沿当前现场继续。`, false, result?.status === 'cancelled' ? 'cancelled' : 'blocked'); return }
      // Integration checks own a quiet tree. Never race outstanding writers or dev servers.
      stopDelegations(input.sessionId)
      if (software) { await closeDebugSessions(input.projectId, input.sessionId); await stopSoftwareSession(input.projectId, input.sessionId); emit('software_preview_changed', { preview_url: null }) }
      if (software) await settleParentDelegationRuns(input.sessionId)
      updateProject(input.projectId, { desktop_phase: 'desktop-verify', current_stage: 'testing' })
      emit('stage_changed', { stage: 'desktop-verify' })
      const version = versionOf()
      if (!version || prdScopeFingerprint(readPrdBackplane(input.projectId)) !== scope) { blocked('验证前目标或文件版本发生变化，请沿当前版本继续。'); return }
      let candidate: Awaited<ReturnType<typeof prepareSoftwareRelease>> | undefined
      let core: CoreVerificationResult, failure: string | undefined, cleanEnvironmentPending = false, failureCategory = 'unknown'
      if (software && !deps.coreVerification && !deps.securityScan && !deps.launchSmoke) {
        // The agent tool and final delivery share one verifier. Every fresh
        // attempt invalidates earlier receipts, including failures at closure.
        checkpoint('verifying', { source: softwareVerificationFingerprint(project.root_path) })
        const checked = await verifySoftwareCandidate(input.projectId, input.requestId, runSignal)
        failureCategory=checked.failure?.category??'unknown'
        candidate = checked.candidate
        core = checked.core ?? { status: 'unverified', checked_at: new Date().toISOString(), summary: checked.summary, missing: [checked.summary], evidence: [] }
        cleanEnvironmentPending = checked.status === 'environment_blocked' && core.local_status === 'passed'
          && core.distribution?.status === 'environment_blocked' && checked.launch?.passed === true
        if (checked.status !== 'passed' && !cleanEnvironmentPending) failure = checked.summary
        if (checked.launch) writeTextFileAtomic(join(project.root_path, '00_VERIFY/launch-smoke.json'), JSON.stringify(checked.launch, null, 2))
        checkpoint('verifying', { source: softwareVerificationFingerprint(project.root_path), candidateId: candidate?.id })
      } else {
        let preparationFailure: string | undefined
        if (software) {
          try { candidate = await prepareSoftwareRelease(input.projectId, project.root_path, runSignal) }
          catch (error) { runSignal.throwIfAborted(); preparationFailure = `发布候选未准备完成：${String(error)}` }
        }
        const checkRoot = candidate?.root ?? project.root_path
        const priorSecurity = software && !preparationFailure
          ? deps.securityScan ? deps.securityScan(input.projectId) : defaultQuickSecurityGate(input.projectId, checkRoot) : undefined
        checkpoint('verifying', { source: software ? softwareVerificationFingerprint(project.root_path) : undefined, candidateId: candidate?.id })
        core = preparationFailure ? { status: 'unverified', checked_at: new Date().toISOString(), summary: preparationFailure, missing: [preparationFailure], evidence: [] }
          : software && (!priorSecurity?.passed || priorSecurity.blocking > 0) ? { status: 'unverified', checked_at: new Date().toISOString(), summary: `执行产品前的静态检查未通过：${priorSecurity?.listing ?? '扫描未能完成'}`, missing: [], evidence: [] }
          : deps.coreVerification ? await deps.coreVerification(input.projectId, runSignal)
          : await runCoreVerification({ projectId: input.projectId, sandboxRoot: checkRoot, signal: runSignal, reuse: !software })
        runSignal.throwIfAborted()
        cleanEnvironmentPending = software && core.local_status === 'passed' && core.distribution?.status === 'environment_blocked'
        if (core.status !== 'passed' && !cleanEnvironmentPending) failure = `${core.summary}\n${core.missing.join('\n')}`
        else {
          const security = software ? priorSecurity : deps.securityScan ? deps.securityScan(input.projectId) : defaultQuickSecurityGate(input.projectId)
          if (!security || !security.passed || security.blocking > 0) failure = `安全检查未通过或未执行：${security?.listing ?? '无有效证据'}`
          else {
            const declared = readLaunchDeclaration(checkRoot)
            const command = brief.lean_brief.ui === 'none' && declared?.ok && declared.launch.mode === 'command'
            const launch = deps.launchSmoke ? await deps.launchSmoke(input.projectId, runSignal) : command
              ? await runLaunchSmoke(checkRoot, { signal: runSignal, allowCleanExit: true }) : software ? await runLaunchSmoke(checkRoot, { signal: runSignal }) : await defaultLaunchSmokeGate(input.projectId, runSignal)
            runSignal.throwIfAborted()
            writeTextFileAtomic(join(project.root_path, '00_VERIFY/launch-smoke.json'), JSON.stringify(launch, null, 2))
            if (brief.lean_brief.ui === 'required' && launch?.criteria?.degraded) { blocked('正常窗口验证环境不可用，程序已保留，未将仅存活检查当作交付通过。'); return }
            const browser = software && brief.lean_brief.delivery === 'browser' && declared?.ok && declared.launch.ui === 'browser'
            const windowReady = brief.lean_brief.ui !== 'required' || browser && launch?.http_ready === true || launch?.criteria && launch.criteria.window_found && launch.criteria.responsive && launch.criteria.stable && launch.criteria.closed_gracefully
            if (!launch?.passed || !windowReady) failure = `正常启动未通过：${launch?.detail ?? '未执行或证据缺失'}\n${launch?.outputExcerpt ?? ''}`
          }
        }
      }
      runSignal.throwIfAborted()
      if (failure) {
        if (modelBudgetStop) { blocked(`模型请求额度已到，宿主检查未通过，未再调用模型：\n${failure}`); return }
        if (core.status === 'environment_blocked' && !cleanEnvironmentPending) { blocked(failure); return }
        if (software) {
          const progress = recordSoftwareRepair({ projectId: input.projectId, sessionId: input.sessionId, runId, error: failure,category:failureCategory,
            source: softwareVerificationFingerprint(project.root_path), candidateId: candidate?.id,
            observations: { gui: core.host_gui?.steps, cli: core.host_cli?.cases } })
          if (!progress.allowed) { blocked(`连续${progress.repeats}次验证得到相同失败观察，尚无可见改善，已停止自动重试并保留现场：\n${failure}`); return }
        }
        const attempt = consumeProjectAttempt(input.projectId, 'lean-repair', software ? undefined : 2)
        if (!attempt.allowed) { blocked(failure); return }
        emit('message_delta', { text: '验证发现具体缺口，我会沿当前现场局部修复。' })
        task = `宿主实际验证反馈（修复${attempt.used}${software ? '，共享原请求与费用预算' : '/2'}）：\n${failure}\n保留已正确实现，不改已确认目标或测试期望；核对失败入口后做最小修复。`
        continue
      }
      if (prdScopeFingerprint(readPrdBackplane(input.projectId)) !== scope || versionOf() !== version) {
        blocked('验证期间目标或产物发生变化，本次通过记录未用于交付。'); return
      }
      if (candidate) await verifyReleaseSource(candidate, runSignal)
      const launch = existsSync(join(project.root_path, 'LAUNCH.json')) ? JSON.parse(readFileSync(join(project.root_path, 'LAUNCH.json'), 'utf8')) as { command?: string[] } : undefined
      const text = `${modelBudgetStop ? '模型调用已停止；宿主沿已登记规则完成了实际验证。' : ''}本次目标已完成并通过当前核心、安全与启动检查。${software ? '可从项目交付入口一键启动试用。' : launch?.command ? `启动：${launch.command.join(' ')}` : '可从项目交付入口启动。'}${core.llm ? 'AI请求与异常分支已做本机HTTP检查，外部供应商连通与生成效果尚未实测。' : ''}继续修改可直接描述或点选。`
      return async () => {
        runSignal.throwIfAborted()
        if (prdScopeFingerprint(readPrdBackplane(input.projectId)) !== scope || versionOf() !== version) { blocked('收口前产物或验证输入发生变化，本次未交付。'); return }
        if (candidate) {
          const began = Date.now(); let accounted = false
          try {
            await promoteSoftwareRelease(candidate, { version, scope, at: new Date().toISOString() }, runSignal,
              () => { budget.recordRuntime(Date.now() - began); accounted = true; return prdScopeFingerprint(readPrdBackplane(input.projectId)) === scope && versionOf() === version })
          } finally { if (!accounted) budget.recordRuntime(Date.now() - began) }
          saveSoftwareRegressionBaseline(input.projectId, version)
        }
        if (cleanEnvironmentPending) {
          blocked(`本机功能、安全及启动检查已通过，可以从交付入口试用。${core.distribution!.detail}`, false, 'waiting_environment')
          return
        }
        resetProjectAttemptScope(input.projectId, 'lean-repair')
        const report = join(candidate?.root ?? project.root_path, '00_VERIFY/core-verification.json')
        checkpoint('verified', { candidateId: candidate?.id, source: software ? softwareVerificationFingerprint(project.root_path) : undefined,
          ...(existsSync(report) ? { check: { path: report, sha256: createHash('sha256').update(readFileSync(report)).digest('hex') } } : {}) })
        commitDesktopDelivery(input.projectId, runSignal)
        recordEvaluationEvent(input.projectId,'delivery_final',{status:'delivered',candidate_id:candidate?.id})
        emit('stage_changed', { stage: 'delivered' })
        deps.persistAssistant(input.sessionId, text); emit('message_delta', { text }); deps.complete(input.sessionId, input.projectId)
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const monetaryNotice = monetaryStopMessage(error)
    blocked(runSignal.aborted ? '执行已停止或到达运行时限，已有结果与用量记录保留。'
      : monetaryNotice ? `${reason}：${monetaryNotice}`
      : /^HARNESS_(?:REQUEST|OUTPUT)_BUDGET_EXHAUSTED$/.test(reason) ? leanBudgetStopMessage(input.projectId, 'desktop-implement', reason)
      : `当前执行受阻：${reason}`, false, runSignal.aborted ? 'interrupted' : 'blocked')
  } finally {
    runSignal.removeEventListener('abort', cancelChildren)
    disposeParentDelegationState(input.sessionId)
    if (software) {
      const cleanup = await Promise.allSettled([closeDebugSessions(input.projectId, input.sessionId), stopSoftwareSession(input.projectId, input.sessionId), settleParentDelegationRuns(input.sessionId)])
      emit('software_preview_changed', { preview_url: null })
      const failed = cleanup.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }
  }
}
