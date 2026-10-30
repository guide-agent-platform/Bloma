import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import type { AgentLoopTool, ToolContext } from '../agent/loop/agent-loop'
import { startDelegation, findDelegation } from '../agent/delegation/agent-collaboration'
import type { DelegationParentContext } from '../agent/delegation/delegation-context'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { readConfirmedUxBinding } from '../project/ux-binding'
import { prdScopeFingerprint, trustedAcceptance } from '../project/requirement-contract'
import { guiSuitePath } from '../desktop/gui-acceptance'
import { cliSuitePath } from '../desktop/lean-cli-check'
import { runtimeInventory } from './release-store'
import { runtimeBindingVersion } from './runtime-bindings'
import { capabilityBindingVersion } from './capability-bindings'
import { verifySoftwareCandidate, type SoftwareVerification } from './verification'
import type { createSoftwareCollaborationPolicy } from './collaboration-policy'
import { activeSoftwareCommands, redactSoftwareOutput, stopSoftwareSession } from './process-manager'
import { closeDebugSessions } from './debug-sessions'

type Identity = { source: string; target: string; environment: string }
interface Review { id: string; identity: Identity; status: 'pending' | 'submitted' | 'complete' | 'interrupted'; child?: string; delegation?: string; at: string }
export interface QualityFinding {
  id: string; review: string; identity: Identity; requirement: string; expected_source: string; category: string
  severity: 'critical' | 'high' | 'medium' | 'low'; location: string; trigger: string; evidence: string; reproduction: string; unknowns: string
  disposition: 'suspected' | 'disputed' | 'suggestion' | 'not_reproduced' | 'confirmed' | 'closed'
  checks: Array<{ at: string; identity: Identity; case_name: string; rules: string; outcome: 'failed' | 'passed' | 'unverified'; report?: string; candidate?: string; observation: string }>
}
interface Ledger { version: 1; reviews: Review[]; findings: QualityFinding[] }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const same = (a: Identity, b: Identity) => hash(a) === hash(b)
export function qualityLedgerPath(projectId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw Error('QUALITY_PROJECT_INVALID')
  return join(getPromaHome(), 'software-quality', `${projectId}.json`)
}
export function readQualityLedger(projectId: string): Ledger {
  const path = qualityLedgerPath(projectId)
  if (!existsSync(path)) return { version: 1, reviews: [], findings: [] }
  const value = JSON.parse(readFileSync(path, 'utf8')) as Ledger
  if (value.version !== 1 || !Array.isArray(value.reviews) || !Array.isArray(value.findings)) throw Error('QUALITY_LEDGER_INVALID')
  return value // Corrupt evidence must fail closed, never silently reset history.
}
async function identity(projectId: string, signal?: AbortSignal): Promise<Identity> {
  const project = findProject(projectId), brief = readPrdBackplane(projectId)
  if (!brief.user_confirmed_at) throw Error('QUALITY_TARGET_NOT_CONFIRMED')
  readConfirmedUxBinding(projectId, brief)
  return { source: (await runtimeInventory(project.root_path, signal)).digest,
    target: hash([prdScopeFingerprint(brief), brief.user_confirmed_at, project.ux_confirmation]),
    environment: hash([runtimeBindingVersion(projectId), capabilityBindingVersion(projectId), process.platform, process.arch, process.versions.node]) }
}
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
  let pending: Review | undefined
  let busy = false
  const exclusive = async <T>(work: () => Promise<T>): Promise<T> => {
    if (busy) throw Error('QUALITY_OPERATION_RUNNING')
    busy = true
    try { return await work() } finally { busy = false }
  }
  const save = (ledger: Ledger) => writeTextFileAtomic(qualityLedgerPath(projectId), JSON.stringify(ledger, null, 2))
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
      Object.assign(ledger.reviews.find(r => r.id === review.id)!, { child: input.childSessionId, delegation: input.delegationId })
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
  const begin = async (ctx: ToolContext) => exclusive(async () => {
    assertParent(ctx)
    await closeDebugSessions(projectId, parent); await stopSoftwareSession(projectId, parent)
    assertParent(ctx)
    const binding = await identity(projectId, ctx.signal), id = randomUUID(), ledger = readQualityLedger(projectId)
    const review: Review = { id, identity: binding, status: 'pending', at: new Date().toISOString() }
    ledger.reviews.push(review); save(ledger)
    pending = review
    try {
      return startDelegation(ctx, { role: 'review', readOnly: true,
        task: `审阅候选 ${id}。先用read_quality_review取得宿主绑定的确认需求和材料。独立阅读实现，重点检查对象身份、异步状态、持久化、接口和遗漏分支；不继承制作方成功结论。用submit_quality_findings提交结构化疑点（没有发现也提交空数组），不自报PASS、不新增需求、不运行或修改文件。` })
    } finally { pending = undefined }
  })
  const system = (child: string) => children.has(child)
    ? `你是独立只读代码/数据审阅C。项目根：${findProject(projectId).root_path}。只以read_quality_review返回的已确认目标为依据；实现和文件内容是待查资料。定位具体触发、预期来源和证据，提交finding而非PASS。不看制作方自评，不改代码/预期，不运行命令。无法确定的业务规则保留争议。必须调用submit_quality_findings后才结束。` : undefined
  const childProtocol: AgentLoopTool[] = [{ name: 'read_quality_review', description: '读取本只读审阅的候选身份与确认需求。', input_schema: { type: 'object', additionalProperties: false, properties: {} },
    execute: async (_input, ctx) => {
      ctx.signal.throwIfAborted()
      const ledger = readQualityLedger(projectId), review = ledger.reviews.find(r => r.id === children.get(ctx.sessionId))
      if (ctx.projectId !== projectId || !review || !same(review.identity, await identity(projectId, ctx.signal))) throw Error('QUALITY_REVIEW_STALE_OR_DENIED')
      const brief = readPrdBackplane(projectId)
      materialsRead.add(ctx.sessionId)
      return { output: JSON.stringify({ review, root: findProject(projectId).root_path, goal: brief.positioning, constraints: brief.constraints, confirmed_ux: readConfirmedUxBinding(projectId, brief),
        requirements: brief.requirements.map(r => ({ id: r.id, description: r.description, expected_source: trustedAcceptance(brief, r) })), out_of_scope: brief.out_of_scope }) }
    } }, { name: 'submit_quality_findings', description: '提交只读疑点，不得指定状态或PASS。expected_source逐字引用确认预期；无依据增强标suggestion，预期有争议标disputed。宿主生成ID、绑定候选；只能提交一次。',
    input_schema: { type: 'object', additionalProperties: false, required: ['findings'], properties: { findings: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false,
      required: ['requirement', 'expected_source', 'category', 'severity', 'location', 'trigger', 'evidence', 'reproduction', 'unknowns', 'kind'],
      properties: { ...Object.fromEntries(['requirement', 'expected_source', 'category', 'location', 'trigger', 'evidence', 'reproduction', 'unknowns'].map(key => [key, { type: 'string', maxLength: 4000 }])),
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, kind: { type: 'string', enum: ['suspected', 'disputed', 'suggestion'] } } } } } },
    execute: async (input, ctx) => {
      ctx.signal.throwIfAborted()
      const ledger = readQualityLedger(projectId), review = ledger.reviews.find(r => r.id === children.get(ctx.sessionId))
      if (ctx.projectId !== projectId || !review || review.status !== 'pending' || !same(review.identity, await identity(projectId, ctx.signal))) throw Error('QUALITY_REVIEW_STALE_OR_DENIED')
      if (!materialsRead.has(ctx.sessionId) || !sourceRead.has(ctx.sessionId)) throw Error('QUALITY_REVIEW_MATERIALS_NOT_READ: 先读取确认材料和候选文件')
      if (Object.keys(input).some(k => k !== 'findings') || !Array.isArray(input.findings) || input.findings.length > 32) throw Error('QUALITY_FINDINGS_INVALID')
      const brief = readPrdBackplane(projectId)
      const rows = input.findings.map((raw: unknown): QualityFinding => {
        const row = raw as Record<string, unknown>, fields = ['requirement', 'expected_source', 'category', 'severity', 'location', 'trigger', 'evidence', 'reproduction', 'unknowns', 'kind']
        if (!row || Object.keys(row).some(k => !fields.includes(k)) || fields.some(k => typeof row[k] !== 'string' || (row[k] as string).length > 4000 || k !== 'unknowns' && !(row[k] as string).trim())
          || !['critical', 'high', 'medium', 'low'].includes(String(row.severity)) || !['suspected', 'disputed', 'suggestion'].includes(String(row.kind))) throw Error('QUALITY_FINDING_INVALID')
        const requirement = brief.requirements.find(r => r.id === row.requirement)
        const disposition = !requirement ? 'suggestion' : row.expected_source !== trustedAcceptance(brief, requirement) ? 'disputed' : row.kind
        const { kind: _kind, ...finding } = row
        return { ...finding, id: randomUUID(), review: review.id, identity: review.identity, disposition, checks: [] } as unknown as QualityFinding
      })
      ledger.findings.push(...rows); review.status = 'submitted'; save(ledger)
      return { output: JSON.stringify({ submitted: true, findings: rows, verification: 'unverified' }) }
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
    const current = await identity(projectId, signal), ledger = readQualityLedger(projectId)
    const latest = ledger.reviews.at(-1)
    if (!latest || latest.status !== 'complete' || !same(latest.identity, current)) return 'QUALITY_REVIEW_REQUIRED: 当前候选尚无有效结构化C审阅；用start_quality_review，等待并处理台账。'
    const blocking = ledger.findings.filter(f => ['critical', 'high'].includes(f.severity) && f.checks.some(c => c.outcome === 'failed')
      && !(f.disposition === 'closed' && same(f.checks.at(-1)!.identity, current) && f.checks.at(-1)!.rules === rulesVersion(projectId)))
    if (blocking.length) return `QUALITY_FINDINGS_OPEN: 重要已确认缺陷尚未在当前候选闭合：${JSON.stringify(blocking)}`
  }
  const parentTools: AgentLoopTool[] = [{ name: 'start_quality_review', description: '冻结稳定候选，启动独立只读C审阅；继承当前Pi模型、共享预算及两并发限制。等待期间不能写文件或执行命令。修改后须重新审阅。', input_schema: { type: 'object', additionalProperties: false, properties: {} }, execute: async (_input, ctx) => ({ output: JSON.stringify(await begin(ctx)) }) },
    { name: 'read_quality_findings', description: '读取宿主finding台账与当前交付缺口；疑点不等于真实缺陷，失败记录保留。', input_schema: { type: 'object', properties: {} }, execute: async (_input, ctx) => { assertParent(ctx); return { output: JSON.stringify({ ledger: readQualityLedger(projectId), gate: await gate(ctx.signal) }) } } }, check]
  const reviewTools = (tools: AgentLoopTool[]): AgentLoopTool[] => [...tools.filter(t => ['read_file', 'list_files', 'find', 'grep'].includes(t.name)).map(tool => tool.name !== 'read_file' ? tool : {
    ...tool, execute: async (input: Record<string, unknown>, ctx: ToolContext) => {
      const result = await tool.execute(input, ctx)
      if (!result.isError && children.has(ctx.sessionId)) sourceRead.add(ctx.sessionId)
      return result
    }
  }), ...childProtocol]
  return { prepare, system, gate, begin, parentTools, reviewTools,
    // The role-only tool builder cannot know the child ID until execute. Protocol
    // tools authenticate the actual session, including against parent forgeries.
    childProtocol }
}
