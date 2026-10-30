import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentLoopTool, ToolContext } from '../agent/loop/agent-loop'
import { startDelegation, findDelegation } from '../agent/delegation/agent-collaboration'
import type { DelegationParentContext } from '../agent/delegation/delegation-context'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { readConfirmedUxBinding } from '../project/ux-binding'
import { trustedAcceptance } from '../project/requirement-contract'
import { guiSuitePath } from '../desktop/gui-acceptance'
import { cliSuitePath } from '../desktop/lean-cli-check'
import { verifySoftwareCandidate, type SoftwareVerification } from './verification'
import type { createSoftwareCollaborationPolicy } from './collaboration-policy'
import { activeSoftwareCommands, redactSoftwareOutput, stopSoftwareSession } from './process-manager'
import { closeDebugSessions } from './debug-sessions'
import { captureVisualMaterial, readVisualMaterial, grantVisualImage, validateVisualGrant, assertVisualRequest } from './visual-review-material'
import type { VisualMaterial } from './visual-review-material'
import type { SDKQuery } from '../orchestration/stages/orchestration-contracts'
import { independentDesignVersion, readIndependentDesign, readIndependentPolicy } from './independent-design'
import { challengeIndependentCase, currentIndependentSemantics } from './independent-quality'

import { qualityHash as hash, sameIdentity as same, qualityIdentity as identity, readQualityLedger, saveQualityLedger, type Identity, type Review, type ReviewKind, type Ledger, type QualityFinding } from './quality-ledger'
export { qualityLedgerPath, readQualityLedger } from './quality-ledger'
export type { QualityFinding } from './quality-ledger'
function rulesVersion(projectId: string) {
  return hash([guiSuitePath(projectId), cliSuitePath(projectId)].map(path => existsSync(path) ? readFileSync(path).toString('base64') : null))
}
function observed(result: SoftwareVerification, finding: QualityFinding, caseName: string): 'passed' | 'failed' | 'unverified' {
  const gui = result.core?.host_gui?.case_results?.filter(c => c.name === caseName && c.feature === finding.requirement)
  if (gui?.length === 1 && gui[0].assertions > 0 && ['passed', 'failed'].includes(gui[0].status)) return gui[0].status as 'passed' | 'failed'
  const cli = result.core?.host_cli?.cases.filter(c => c.name === caseName && c.covers.includes(finding.requirement))
  if (cli?.length === 1 && cli[0].exit_code !== null) return cli[0].passed ? 'passed' : 'failed'
  return 'unverified'
}

/** The model supplies observations only. Candidate IDs, execution results and
 * state transitions belong to the host; the durable ledger lives outside source. */
export function createQualityReview(projectId: string, parent: string, policy: ReturnType<typeof createSoftwareCollaborationPolicy>) {
  const children = new Map<string, string>()
  const materialsRead = new Set<string>(), sourceRead = new Set<string>()
  const imagesRequested = new Set<string>()
  let pending: Review | undefined
  let activeRoute: string | undefined
  let busy = false
  const exclusive = async <T>(work: () => Promise<T>): Promise<T> => {
    if (busy) throw Error('QUALITY_OPERATION_RUNNING')
    busy = true
    try { return await work() } finally { busy = false }
  }
  const save = (ledger: Ledger) => saveQualityLedger(projectId, ledger)
  const assertParent = (ctx: ToolContext) => {
    policy.assertCommand(ctx)
    if (ctx.projectId !== projectId || ctx.sessionId !== parent) throw Error('QUALITY_PARENT_ONLY')
    if (activeSoftwareCommands(projectId, parent).length) throw Error('QUALITY_COMMANDS_RUNNING')
  }
  const prepare: NonNullable<DelegationParentContext['prepareDelegation']> = input => {
    if (readQualityLedger(projectId).reviews.some(r => r.child === input.childSessionId)) throw Error('QUALITY_NEW_REVIEW_REQUIRED: 不续跑旧候选审阅')
    const lease = policy.prepare(input)
    if (!pending) return lease
    const review = pending
    const release = policy.freezeReview()
    try {
      children.set(input.childSessionId, review.id)
      const ledger = readQualityLedger(projectId)
      Object.assign(ledger.reviews.find(r => r.id === review.id)!, { child: input.childSessionId, delegation: input.delegationId,
        ...(review.visual ? { image: grantVisualImage(review.visual, input.childSessionId) } : {}) })
      save(ledger)
    } catch (error) { release(); lease.release(); throw error }
    return { release: () => {
      lease.release(); release(); children.delete(input.childSessionId)
      const ledger = readQualityLedger(projectId), stored = ledger.reviews.find(r => r.id === review.id)!
      if (stored.status !== 'complete') { stored.status = 'interrupted'; save(ledger) }
    }, completionNote: () => {
      const ledger = readQualityLedger(projectId), stored = ledger.reviews.find(r => r.id === review.id)!
      if (stored.status === 'submitted' && findDelegation(parent, input.delegationId)?.loopStatus === 'completed') { stored.status = 'complete'; save(ledger) }
      return '\n结构化审阅意见已交宿主台账；子任务完成不代表缺陷已关闭。'
    } }
  }
  const begin = async (ctx: ToolContext, kind: ReviewKind = 'code', debugId?: string) => exclusive(async () => {
    assertParent(ctx)
    const binding = await identity(projectId, ctx.signal), id = randomUUID(), ledger = readQualityLedger(projectId)
    let visual: VisualMaterial | undefined
    try {
      if (kind === 'visual') {
        if (readPrdBackplane(projectId).lean_brief?.ui !== 'required') throw Error('VISUAL_GUI_REQUIRED')
        visual = await captureVisualMaterial(projectId, parent, id, hash(binding), ctx.signal, debugId)
      }
    } finally { await closeDebugSessions(projectId, parent); await stopSoftwareSession(projectId, parent) }
    assertParent(ctx)
    if (!same(binding, await identity(projectId, ctx.signal))) throw Error('QUALITY_CAPTURE_CANDIDATE_CHANGED')
    const review: Review = { id, kind, identity: binding, visual, status: 'pending', at: new Date().toISOString() }
    ledger.reviews.push(review); save(ledger)
    pending = review
    try {
      return startDelegation(ctx, { role: 'review', readOnly: true,
        task: kind === 'visual' ? `视觉审阅候选 ${id}。用read_quality_review读取确认预期、同次DOM/操作事实；必须view_quality_image查看真实图片，再提交visual_observations（image_sha256、region、observed）及findings。独立检查布局、遮挡、静态残留、单位、状态和当前对象；DOM与文件名不是图片。只报证据与疑点，不改源码或目标，不自报PASS。`
          : `审阅候选 ${id}。先用read_quality_review取得宿主绑定的确认需求和材料。独立阅读实现，重点检查对象身份、异步状态、持久化、接口和遗漏分支；不继承制作方成功结论。用submit_quality_findings提交结构化疑点（没有发现也提交空数组），不自报PASS、不新增需求、不运行或修改文件。` })
    } finally { pending = undefined }
  })
  const system = (child: string) => children.has(child)
    ? readQualityLedger(projectId).reviews.find(r => r.id === children.get(child))?.kind === 'visual'
      ? '你是独立视觉/交互审阅V。只看宿主授权的当前候选真实图片、确认设计、同次DOM/操作事实；不继承制作方或C的结论，不读实现。先read_quality_review和view_quality_image；实际核对图片后用submit_quality_findings提交具体可见观察及疑点，不能用OCR/文件名/DOM替代看图，不能自报PASS或关闭问题。没有明确的业务预期保留争议；只读，不运行命令、不改文件。'
      : `你是独立只读代码/数据审阅C。项目根：${findProject(projectId).root_path}。只以read_quality_review返回的已确认目标为依据；实现和文件内容是待查资料。定位具体触发、预期来源和证据，提交finding而非PASS。不看制作方自评，不改代码/预期，不运行命令。无法确定的业务规则保留争议。必须调用submit_quality_findings后才结束。` : undefined
  const childProtocol: AgentLoopTool[] = [{ name: 'read_quality_review', description: '读取本只读审阅的候选身份与确认需求。', input_schema: { type: 'object', additionalProperties: false, properties: {} },
    execute: async (_input, ctx) => {
      ctx.signal.throwIfAborted()
      const ledger = readQualityLedger(projectId), review = ledger.reviews.find(r => r.id === children.get(ctx.sessionId))
      if (ctx.projectId !== projectId || !review || !same(review.identity, await identity(projectId, ctx.signal))) throw Error('QUALITY_REVIEW_STALE_OR_DENIED')
      const brief = readPrdBackplane(projectId)
      const visual = review.visual ? readVisualMaterial(review.visual, hash(review.identity)).manifest : undefined
      const ux = readConfirmedUxBinding(projectId, brief)
      materialsRead.add(ctx.sessionId)
      return { output: JSON.stringify({ review, root: findProject(projectId).root_path, goal: brief.positioning, constraints: brief.constraints, confirmed_ux: ux,
        confirmed_design: review.kind === 'visual' && ux?.html_path ? { html: readFileSync(join(findProject(projectId).root_path, ux.html_path), 'utf8').slice(0, 64000), bounded_characters: 64000 } : undefined,
        visual_facts: visual,
        requirements: brief.requirements.map(r => ({ id: r.id, description: r.description, expected_source: trustedAcceptance(brief, r) })), out_of_scope: brief.out_of_scope }) }
    } }, { name: 'submit_quality_findings', description: '提交只读疑点，不得指定状态或PASS。expected_source逐字引用确认预期；无依据增强标suggestion，预期有争议标disputed。宿主生成ID、绑定候选；只能提交一次。',
    input_schema: { type: 'object', additionalProperties: false, required: ['findings'], properties: { visual_observations: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['image_sha256', 'region', 'observed'], properties: { image_sha256: { type: 'string' }, region: { type: 'string', maxLength: 1000 }, observed: { type: 'string', maxLength: 2000 } } } }, findings: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false,
      required: ['requirement', 'expected_source', 'category', 'severity', 'location', 'trigger', 'evidence', 'reproduction', 'unknowns', 'kind'],
      properties: { ...Object.fromEntries(['requirement', 'expected_source', 'category', 'location', 'trigger', 'evidence', 'reproduction', 'unknowns'].map(key => [key, { type: 'string', maxLength: 4000 }])),
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, kind: { type: 'string', enum: ['suspected', 'disputed', 'suggestion'] } } } } } },
    execute: async (input, ctx) => {
      ctx.signal.throwIfAborted()
      const ledger = readQualityLedger(projectId), review = ledger.reviews.find(r => r.id === children.get(ctx.sessionId))
      if (ctx.projectId !== projectId || !review || review.status !== 'pending' || !same(review.identity, await identity(projectId, ctx.signal))) throw Error('QUALITY_REVIEW_STALE_OR_DENIED')
      if (!materialsRead.has(ctx.sessionId) || review.kind !== 'visual' && !sourceRead.has(ctx.sessionId)) throw Error('QUALITY_REVIEW_MATERIALS_NOT_READ: 先读取确认材料和候选文件')
      if (review.kind === 'visual') {
        if (!review.visual || !review.image || !review.visual_delivery || !imagesRequested.has(ctx.sessionId)) throw Error('VISUAL_IMAGE_NOT_DELIVERED')
        validateVisualGrant(review.visual, ctx.sessionId, review.image)
        const observations = input.visual_observations as Array<Record<string, unknown>>
        if (!Array.isArray(observations) || !observations.length || observations.length > 16 || observations.some(o => !o || Object.keys(o).some(k => !['image_sha256', 'region', 'observed'].includes(k))
          || o.image_sha256 !== review.visual!.image_hash || typeof o.region !== 'string' || !o.region.trim() || o.region.length > 1000 || typeof o.observed !== 'string' || !o.observed.trim() || o.observed.length > 2000)) throw Error('VISUAL_OBSERVATIONS_REQUIRED')
        review.visual_observations = observations
      } else if (input.visual_observations !== undefined) throw Error('VISUAL_OBSERVATIONS_NOT_APPLICABLE')
      if (Object.keys(input).some(k => !['findings', 'visual_observations'].includes(k)) || !Array.isArray(input.findings) || input.findings.length > 32) throw Error('QUALITY_FINDINGS_INVALID')
      const brief = readPrdBackplane(projectId)
      const rows = input.findings.map((raw: unknown): QualityFinding => {
        const row = raw as Record<string, unknown>, fields = ['requirement', 'expected_source', 'category', 'severity', 'location', 'trigger', 'evidence', 'reproduction', 'unknowns', 'kind']
        if (!row || Object.keys(row).some(k => !fields.includes(k)) || fields.some(k => typeof row[k] !== 'string' || (row[k] as string).length > 4000 || k !== 'unknowns' && !(row[k] as string).trim())
          || !['critical', 'high', 'medium', 'low'].includes(String(row.severity)) || !['suspected', 'disputed', 'suggestion'].includes(String(row.kind))) throw Error('QUALITY_FINDING_INVALID')
        const requirement = brief.requirements.find(r => r.id === row.requirement)
        const disposition = !requirement ? 'suggestion' : row.expected_source !== trustedAcceptance(brief, requirement) ? 'disputed' : row.kind
        const { kind: _kind, ...finding } = row
        return { ...finding, id: randomUUID(), review: review.id, review_kind: review.kind ?? 'code', visual_material_hash: review.visual?.manifest_hash, identity: review.identity, disposition, checks: [] } as unknown as QualityFinding
      })
      ledger.findings.push(...rows); review.status = 'submitted'; save(ledger)
      return { output: JSON.stringify({ submitted: true, findings: rows, verification: 'unverified' }) }
    } }, { name: 'view_quality_image', description: '读取本视觉子会话获宿主授权的当前候选真实PNG。无path或debug_session_id参数；跨会话、过期、换图拒绝。附图之后还须实际核对并提交具体可见观察，图片本身不签发PASS。', input_schema: { type: 'object', additionalProperties: false, properties: {} }, execute: async (input, ctx) => {
      ctx.signal.throwIfAborted()
      const review = readQualityLedger(projectId).reviews.find(r => r.id === children.get(ctx.sessionId))
      if (Object.keys(input).length || ctx.projectId !== projectId || review?.kind !== 'visual' || !review.visual || !review.image || !same(review.identity, await identity(projectId, ctx.signal))) throw Error('VISUAL_IMAGE_NOT_OWNED_OR_STALE')
      validateVisualGrant(review.visual, ctx.sessionId, review.image); imagesRequested.add(ctx.sessionId)
      return { output: JSON.stringify({ sha256: review.visual.image_hash, candidate: review.identity, visual_review: 'image_attached_not_reviewed' }), images: [review.image] }
    } }]
  const check: AgentLoopTool = { name: 'check_quality_finding', description: '宿主实际运行现有冻结验收，按case_name与需求编号记录复现/复测。第一次须在原审阅候选复现失败，后续相同案例/规则在新候选通过才关闭。无证据和争议不能确认；模型不能指定结果。必要案例先通过现有登记入口追加。',
    input_schema: { type: 'object', additionalProperties: false, required: ['finding_id', 'case_name'], properties: { finding_id: { type: 'string' }, case_name: { type: 'string' } } },
    execute: async (input, ctx) => exclusive(async () => {
      assertParent(ctx)
      await closeDebugSessions(projectId, parent); await stopSoftwareSession(projectId, parent)
      assertParent(ctx)
      if (Object.keys(input).some(k => !['finding_id', 'case_name'].includes(k)) || typeof input.case_name !== 'string' || !input.case_name.trim()) throw Error('QUALITY_CHECK_INVALID')
      const ledger = readQualityLedger(projectId), finding = ledger.findings.find(f => f.id === input.finding_id)
      if (!finding || ['suggestion', 'disputed'].includes(finding.disposition)) throw Error('QUALITY_FINDING_UNGROUNDED')
      if (finding.independent) {
        if (finding.disposition === 'superseded' || finding.independent.case_id !== input.case_name || finding.independent.design_version !== independentDesignVersion(projectId)) throw Error('INDEPENDENT_RETEST_CONTRACT_CHANGED')
        const result = await verifySoftwareCandidate(projectId, ctx.requestId, ctx.signal, true)
        const updated = readQualityLedger(projectId).findings.find(f => f.id === finding.id)!
        return { output: JSON.stringify({ finding: updated, status: result.status, summary: result.summary }), isError: result.status !== 'passed' || updated.disposition !== 'closed' }
      }
      const before = await identity(projectId, ctx.signal), rules = rulesVersion(projectId), baseline = finding.checks.find(c => c.outcome === 'failed')
      if (!baseline && !same(finding.identity, before)) throw Error('QUALITY_REPRODUCTION_CANDIDATE_STALE')
      if (baseline && (baseline.case_name !== input.case_name || baseline.rules !== rules || baseline.identity.target !== before.target || baseline.identity.environment !== before.environment)) throw Error('QUALITY_RETEST_CONTRACT_CHANGED')
      const result = await verifySoftwareCandidate(projectId, ctx.requestId, ctx.signal, true)
      const after = await identity(projectId, ctx.signal)
      if (!same(before, after) || rules !== rulesVersion(projectId)) throw Error('QUALITY_CHECK_INPUT_CHANGED')
      const outcome = observed(result, finding, input.case_name)
      finding.checks.push({ at: new Date().toISOString(), identity: before, case_name: input.case_name, rules, outcome, report: result.report_path, candidate: result.candidate?.id,
        observation: redactSoftwareOutput(JSON.stringify({ status: result.status, summary: result.summary,
          gui: result.core?.host_gui?.case_results?.filter(c => c.name === input.case_name), cli: result.core?.host_cli?.cases.filter(c => c.name === input.case_name) })) })
      finding.disposition = outcome === 'failed' ? 'confirmed' : outcome === 'passed' && baseline && result.status === 'passed' ? 'closed'
        : baseline ? 'confirmed' : 'not_reproduced'
      // Read again after asynchronous execution; no other writer may be erased.
      const current = readQualityLedger(projectId), index = current.findings.findIndex(f => f.id === finding.id)
      current.findings[index] = finding; save(current)
      return { output: JSON.stringify({ finding, status: result.status, summary: result.summary }), isError: finding.disposition !== 'closed' && finding.disposition !== 'not_reproduced' }
    }) }
  const gate = async (signal?: AbortSignal): Promise<string | undefined> => {
    const design=readIndependentPolicy(projectId)?.enabled?readIndependentDesign(projectId):undefined
    if(design?.contract){const semantics=currentIndependentSemantics(projectId,design.contract);if(!semantics.ready)return `QUALITY_INDEPENDENT_SEMANTICS_UNRESOLVED: B预期或覆盖争议尚待澄清，不能改目标或断言过关：${JSON.stringify(semantics)}`}
    const current = await identity(projectId, signal), ledger = readQualityLedger(projectId)
    const latest = ledger.reviews.filter(r => (r.kind ?? 'code') === 'code').at(-1)
    if (!latest || latest.status !== 'complete' || !same(latest.identity, current)) return 'QUALITY_REVIEW_REQUIRED: 当前候选尚无有效结构化C审阅；用start_quality_review，等待并处理台账。'
    const blocking = ledger.findings.filter(f => f.disposition !== 'superseded' && ['critical', 'high'].includes(f.severity) && f.checks.some(c => c.outcome === 'failed')
      && !(f.disposition === 'closed' && same(f.checks.at(-1)!.identity, current) && f.checks.at(-1)!.rules === (f.independent ? independentDesignVersion(projectId) : rulesVersion(projectId))))
    if (blocking.length) return `QUALITY_FINDINGS_OPEN: 重要已确认缺陷尚未在当前候选闭合：${JSON.stringify(blocking)}`
    if (readPrdBackplane(projectId).lean_brief?.ui === 'required') {
      const visual = ledger.reviews.filter(r => r.kind === 'visual').at(-1)
      if (visual?.visual_error === 'MODEL_IMAGE_INPUT_UNSUPPORTED' && visual.visual_route === activeRoute) return 'QUALITY_VISUAL_MODEL_UNSUPPORTED: 当前模型已实际拒绝图片输入，V仍未验证；请更换支持图片的当前制作路由后继续，不能改用文字或自动重试同一路由。'
      if (visual?.status === 'complete' && same(visual.identity, current) && visual.visual && visual.image && visual.child && visual.visual_delivery?.image_hash === visual.visual.image_hash && visual.visual_observations?.length) {
        try { validateVisualGrant(visual.visual, visual.child, visual.image); return } catch { /* recapture; old evidence never passes */ }
      }
      return 'QUALITY_VISUAL_REVIEW_REQUIRED: 当前界面候选尚无有效V图片审阅；用start_visual_review，不能用DOM或文件名冒充看图。'
    }
  }
  const parentTools: AgentLoopTool[] = [{name:'challenge_independent_case',description:'提出B案例的业务预期/范围争议，须给具体理由和证据。只保留待核对主张并使旧PASS失效，不删除案例、不改冻结断言、不关闭已确认缺陷，也不自动重发B。需要用户澄清或新的确认设计才能解除；不要为适配器缺失擅自新增功能。',
    input_schema:{type:'object',additionalProperties:false,required:['case_id','reason','evidence'],properties:{case_id:{type:'string'},reason:{type:'string',maxLength:2000},evidence:{type:'string',maxLength:2000}}},
    execute:async(input,ctx)=>{assertParent(ctx);return{output:JSON.stringify({finding:await challengeIndependentCase(projectId,input,ctx.signal),verification:'unverified'})}}}, { name: 'start_quality_review', description: '冻结稳定候选，启动独立只读C审阅；继承当前Pi模型、共享预算及两并发限制。等待期间不能写文件或执行命令。修改后须重新审阅。', input_schema: { type: 'object', additionalProperties: false, properties: {} }, execute: async (_input, ctx) => ({ output: JSON.stringify(await begin(ctx)) }) },
    { name: 'start_visual_review', description: '宿主实际采集当前候选PNG和同次DOM/操作事实，封存并授权独立V子会话；继承父模型与共享预算。可指定本会话当前debug_session_id保留操作状态，否则复用当前实例或打开正常入口。图片缺失或渠道拒绝图像不能记为已审阅。', input_schema: { type: 'object', additionalProperties: false, properties: { debug_session_id: { type: 'string' } } }, execute: async (input, ctx) => {
      if (Object.keys(input).some(k => k !== 'debug_session_id') || input.debug_session_id !== undefined && typeof input.debug_session_id !== 'string') throw Error('VISUAL_INPUT_INVALID')
      return { output: JSON.stringify(await begin(ctx, 'visual', input.debug_session_id as string | undefined)) }
    } },
    { name: 'read_quality_findings', description: '读取宿主finding台账与当前交付缺口；疑点不等于真实缺陷，失败记录保留。', input_schema: { type: 'object', properties: {} }, execute: async (_input, ctx) => { assertParent(ctx); return { output: JSON.stringify({ ledger: readQualityLedger(projectId), gate: await gate(ctx.signal) }) } } }, check]
  const reviewTools = (tools: AgentLoopTool[], child?: string): AgentLoopTool[] => child && readQualityLedger(projectId).reviews.find(r => r.id === children.get(child))?.kind === 'visual' ? childProtocol : [...tools.filter(t => ['read_file', 'list_files', 'find', 'grep'].includes(t.name)).map(tool => ({
    ...tool, execute: async (input: Record<string, unknown>, ctx: ToolContext) => {
      if (readQualityLedger(projectId).reviews.find(r => r.id === children.get(ctx.sessionId))?.kind === 'visual') throw Error('VISUAL_SOURCE_READ_DENIED: V只使用授权图片和操作事实')
      const result = await tool.execute(input, ctx)
      if (tool.name === 'read_file' && !result.isError && children.has(ctx.sessionId)) sourceRead.add(ctx.sessionId)
      return result
    }
  })), ...childProtocol]
  const wrapQuery = (query: SDKQuery): SDKQuery => async function* (prompt, options) {
    const route = hash([options.env.ANTHROPIC_BASE_URL, options.env.ANTHROPIC_MODEL, options.env.ANTHROPIC_PROVIDER_TYPE, options.providerType])
    activeRoute = route
    const review = readQualityLedger(projectId).reviews.find(r => r.id === children.get(options.sessionId))
    if (review?.kind !== 'visual') { yield* query(prompt, options); return }
    if (!review.visual || !review.image || !same(review.identity, await identity(projectId, options.signal))) throw Error('VISUAL_QUERY_CANDIDATE_STALE')
    validateVisualGrant(review.visual, options.sessionId, review.image)
    const requested = imagesRequested.has(options.sessionId)
    let requestHash: string | undefined, started = false, success = false
    try { for await (const message of query(prompt, { ...options, requestGuard: request => {
      options.requestGuard?.(request)
      validateVisualGrant(review.visual!, options.sessionId, review.image!)
      if (requested) requestHash = assertVisualRequest(request.body, review.visual!.image_hash)
    }, onTransportAttempt: state => { options.onTransportAttempt?.(state); started = state === 'started' }, })) {
      if (message.type === 'result') success = message.subtype === 'success'
      yield message
    } } catch (error) {
      if (String(error).includes('不支持图片输入')) {
        const ledger = readQualityLedger(projectId), stored = ledger.reviews.find(r => r.id === review.id)!
        stored.visual_error = 'MODEL_IMAGE_INPUT_UNSUPPORTED'; stored.visual_route = route; save(ledger)
      }
      throw error
    }
    options.signal.throwIfAborted()
    if (requested && requestHash && started && success) {
      validateVisualGrant(review.visual, options.sessionId, review.image)
      if (!same(review.identity, await identity(projectId, options.signal))) throw Error('VISUAL_QUERY_CANDIDATE_STALE')
      const ledger = readQualityLedger(projectId), stored = ledger.reviews.find(r => r.id === review.id)!
      stored.visual_delivery = { at: new Date().toISOString(), image_hash: review.visual.image_hash, request_hash: requestHash }; save(ledger)
    }
  }
  return { prepare, system, gate, begin, parentTools, reviewTools, wrapQuery, isQualityChild: (child: string) => children.has(child),
    // The role-only tool builder cannot know the child ID until execute. Protocol
    // tools authenticate the actual session, including against parent forgeries.
    childProtocol }
}
