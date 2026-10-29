import { runLeanCliCheck, type LeanCliResult } from './lean-cli-check'
import { findProject } from '../project/project-service'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { writeTextFileAtomic } from '../../storage/json-store'
import { readPrdBackplane } from '../project/document-engine'
import { prdScopeFingerprint, requirementEvidenceHash, requirementVerificationContext } from '../project/requirement-contract'
import { parseProjectContract } from './contract-schema'
import { execFileDriverSpawn, runContractDriver, type DriverSpawn, type DriverScenarioOutcome } from './process-driver'
import { verificationFingerprint } from './verification-fingerprint'
import type { FileVerificationResult } from './file-verification'
import type { LlmVerificationResult } from './llm-verification'
import { combineVerification, runCapabilityVerifiers, type CapabilityVerifier } from './capability-verifiers'
import { runGuiAcceptance, type GuiAcceptanceResult } from './gui-acceptance'
import { coreVerificationCacheKey, withCoreVerificationCache } from './core-verification-cache'
import { isSoftwareProject } from './workflow-policy'
import { readLaunchDeclaration } from './launch-smoke'
import { qualifySoftwareArtifact, type ArtifactQualification } from '../software/artifact-qualification'
import { assertSoftwareDelivery } from '../software/launch-contract'
import { guiFeatureResults } from './gui-feature-results'

export type CoreVerificationStatus = 'passed' | 'failed' | 'unverified' | 'environment_blocked'
export interface CoreVerificationResult {
  verification_scope?: 'registered_local_cases_and_capability_contracts'
  local_status?: CoreVerificationStatus
  distribution?: ArtifactQualification
  host_cli?: LeanCliResult
  reused?: boolean
  host_gui?: GuiAcceptanceResult
  llm?: LlmVerificationResult
  requirements?: Array<{ id: string; requirement_hash: string; implementation: 'implemented' | 'partial' | 'missing' | 'unverified'; verification: CoreVerificationStatus }>
  speech?: import('./speech-verification').SpeechVerificationResult
  file_operations?: FileVerificationResult
  gui_execution?: { command: string; routing: string; scenarios: Array<{ name: string; outcome: string }> }
  status: CoreVerificationStatus
  summary: string
  checked_at: string
  fingerprint?: string
  missing: string[]
  evidence: Array<{ fid: string; scenario: string; input: string; outcome: string }>
}
interface CoreScenario { name: string; covers: string[]; input: 'logic' | 'gui' | 'audio' | 'microphone' | 'mock' }
export const CORE_MANIFEST_REL = 'CORE_CHECK.json'
export const CORE_REPORT_REL = '00_VERIFY/core-verification.json'

function scenarioOutcome(scenarios: DriverScenarioOutcome[], name: string): string {
  const states = scenarios.filter(scenario => scenario.name === name).map(scenario => scenario.outcome)
  return states.includes('fail') ? 'fail' : states.includes('blocked') ? 'blocked' : states.length && states.every(s => s === 'pass') ? 'pass' : 'unverified'
}

/** Minimal shared execution contract; input labels alone are not real audio evidence. */
export interface CoreVerificationOptions {
  projectId: string; sandboxRoot?: string; spawn?: DriverSpawn; signal?: AbortSignal; capabilityVerifiers?: readonly CapabilityVerifier[]; reuse?: boolean; force?: boolean
}
export async function runCoreVerification(options: CoreVerificationOptions): Promise<CoreVerificationResult> {
  if (!options.reuse || options.spawn || options.capabilityVerifiers || !options.sandboxRoot) return runFreshCoreVerification(options)
  try {
    return await withCoreVerificationCache({ projectId: options.projectId, signal: options.signal, force: options.force,
      key: () => coreVerificationCacheKey(options.projectId, options.sandboxRoot!) }, () => runFreshCoreVerification(options))
  } catch (error) {
    if (options.signal?.aborted) throw error
    return { status: 'environment_blocked', summary: '验证凭据未能可靠保存，产物已保留，不能确认交付。', checked_at: new Date().toISOString(),
      evidence: [], missing: [error instanceof Error ? error.message : String(error)] }
  }
}
async function runFreshCoreVerification(options: CoreVerificationOptions): Promise<CoreVerificationResult> {
  const result: CoreVerificationResult = { status: 'unverified', summary: '已生成，核心功能待验证。', checked_at: new Date().toISOString(), missing: [], evidence: [] }
  const root = options.sandboxRoot
  let fingerprintPolicy: 'standard' | 'software' = 'standard'
  try { if (isSoftwareProject(options.projectId)) fingerprintPolicy = 'software' } catch { /* legacy isolated verification */ }
  const fingerprintOf = (directory: string, context: unknown) => verificationFingerprint(directory, context, fingerprintPolicy)
  let dataRoot: string | undefined
  try {
    options.signal?.throwIfAborted()
    if (!root) throw new Error('项目路径不可用')
    const backplane = readPrdBackplane(options.projectId)
    // Confirmed scope is independent of priority. This runs only for a fresh verification;
    // historical delivery state and reports are never silently migrated.
    const required = backplane.requirements
    if (!required.length) throw new Error('没有已确认的核心需求')
    if (new Set(required.map(item => item.id)).size !== required.length) throw new Error('功能项编号重复，不能确定覆盖关系')
    const context = requirementVerificationContext(backplane)
    const fingerprint = fingerprintOf(root, context)
    result.fingerprint = fingerprint
    if (!fingerprint) throw new Error('验证输入不可完整读取，不能运行或复用未知版本证据')
    if (backplane.lean_brief) {
      await verifyLeanBehavior(options, root, backplane, result)
      if (fingerprintOf(root, requirementVerificationContext(readPrdBackplane(options.projectId))) !== fingerprint) {
        result.status = 'unverified'; result.missing.push('验证期间目标或产物变化，本次结果作废')
        for (const row of result.requirements ?? []) row.verification = 'unverified'
      }
    } else {
    if (!existsSync(join(root, CORE_MANIFEST_REL))) throw new Error('缺少核心业务验证入口 CORE_CHECK.json')
    const raw = JSON.parse(readFileSync(join(root, CORE_MANIFEST_REL), 'utf8')) as Record<string, unknown>
    if (raw.schema_version !== 1 && raw.schema_version !== 2) throw new Error('核心验证声明版本不支持')
    if (raw.gui_scenarios !== undefined) throw new Error('CORE_CHECK.json 不支持 gui_scenarios。将界面场景合并到 scenarios，input 填 gui；gui_command 仅登记界面测试脚本。')
    const declarations = Array.isArray(raw.requirements) ? raw.requirements as Record<string, unknown>[] : []
    const ids = new Set(required.map(item => item.id))
    if (declarations.some((entry, index) => !entry || !ids.has(entry.id as string) || declarations.findIndex(other => other?.id === entry.id) !== index ||
      !['implemented', 'partial', 'missing', 'unverified'].includes(entry.implementation as string))) throw new Error('逐项实现声明不合法或重复')
    result.requirements = required.map(item => {
      const declaration = declarations.find(entry => entry.id === item.id)
      const hash = requirementEvidenceHash(backplane, item)
      if (!declaration) result.missing.push(`${item.id}: 缺少逐项实现声明与验证版本，旧场景通过不能证明本项完成`)
      else if (declaration.requirement_hash !== hash) {
        const declared = typeof declaration.requirement_hash === 'string' && /^[a-f0-9]{64}$/i.test(declaration.requirement_hash) ? declaration.requirement_hash : '缺失或无效'
        throw new Error(`${item.id}: 验证声明与当前需求版本不一致（声明指纹 ${declared}；当前指纹 ${hash}）。请先读取当前需求并核对场景语义，再在 CORE_CHECK.json 的 requirements 中重新登记 requirement_hash；只改场景名称不能修正指纹，也不可仅复制旧覆盖编号`)
      }
      else if (declaration.implementation !== 'implemented') result.missing.push(`${item.id}: 实现状态为 ${declaration.implementation}，测试通过不能补成已实现`)
      return { id: item.id, requirement_hash: hash, implementation: (declaration?.implementation ?? 'unverified') as 'implemented' | 'partial' | 'missing' | 'unverified', verification: 'unverified' }
    })
    const scenarios = raw.scenarios as CoreScenario[]
    if (Array.isArray(scenarios) && scenarios.length > 64) throw new Error(`核心验证场景数量 ${scenarios.length} 超过上限 64；请合并重复场景并保留全部需求覆盖，再重新运行验证`)
    if (!Array.isArray(scenarios) || !scenarios.length || scenarios.length > 64 || scenarios.some(s =>
      !s || typeof s.name !== 'string' || !s.name || /[\r\n]/.test(s.name) || !Array.isArray(s.covers) || s.covers.some(fid => typeof fid !== 'string') ||
      !['logic', 'gui', 'audio', 'microphone', 'mock'].includes(s.input)) || new Set(scenarios.map(s => s.name)).size !== scenarios.length) throw new Error('核心验证场景声明不合法或场景名重复')
    // Register existing logic and GUI scripts separately; never infer GUI evidence from logic output.
    const registeredCommand = (value: unknown): string[] => {
      if (!Array.isArray(value) || value.length < 2 || value.some(p => typeof p !== 'string') ||
          !/(?:^|[\\/])python(?:3)?(?:\.exe)?$/i.test(value[0] ?? '') || !value[1]?.endsWith('.py')) throw new Error('核心验证命令必须为 Python 项目脚本')
      const script = resolve(root, value[1]!)
      const rel = relative(resolve(root), script)
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || !existsSync(script)) throw new Error('核心验证脚本缺失或不在项目内')
      return value as string[]
    }
    const command = registeredCommand(raw.command)
    const guiCommand = raw.gui_command === undefined ? undefined : registeredCommand(raw.gui_command)
    const knownIds = new Set(backplane.requirements.map(r => r.id))
    if (scenarios.some(s => s.covers.some(fid => !knownIds.has(fid)))) throw new Error('核心验证引用了不存在的需求')
    dataRoot = mkdtempSync(join(tmpdir(), 'bloma-core-verification-'))
    const execute = (registered: string[]) => runContractDriver({ contract: parseProjectContract(JSON.stringify({ schema_version: 1, entry: 'app.py',
      driver: { command: registered, timeout_ms: 120000, exit_code_semantics: { 0: 'pass', 1: 'fail', 2: 'blocked' }, assert_readback: 'core scenario readback' },
      components: [], env_whitelist: ['APP_DATA_DIR', 'BLOMA_SPEECH_MODEL_DIR', 'BLOMA_SPEECH_OFFLINE'], scenarios,
    })), cwd: root, spawn: options.spawn ?? execFileDriverSpawn, exactScenarioNames: scenarios.map(scenario => scenario.name),
      signal: options.signal, parentEnv: { ...process.env, APP_DATA_DIR: join(dataRoot!, 'data'), BLOMA_SPEECH_OFFLINE: '1' } })
    const report = await execute(command)
    options.signal?.throwIfAborted()
    const guiReport = guiCommand ? await execute(guiCommand) : undefined
    options.signal?.throwIfAborted()
    const reports = guiReport ? [report, guiReport] : [report]
    if (guiReport) result.gui_execution = { command: guiReport.command, routing: guiReport.routing, scenarios: guiReport.scenarios }
    for (const scenario of scenarios) {
      const source = scenario.input === 'gui' && guiReport ? guiReport : report
      const outcome = scenarioOutcome(source.scenarios, scenario.name)
      for (const fid of scenario.covers) result.evidence.push({ fid, scenario: scenario.name, input: scenario.input, outcome })
      if (outcome !== 'pass') {
        const observed = outcome === 'unverified' ? source.scenarios.map(row => row.name).slice(0, 64) : []
        result.missing.push(`场景「${scenario.name}」(${scenario.input}) 未通过：${outcome}${observed.length ? `；脚本实际输出的场景名：${JSON.stringify(observed)}。登记名称必须逐字一致，请核对引号、空格与动态输入。` : ''}`)
      }
    }
    if (fingerprintOf(root, context) !== fingerprint) result.missing.push('验证期间源码或声明变化，本次结果作废')
    const capabilities = await runCapabilityVerifiers({ projectId: options.projectId, root, backplane, manifest: raw, signal: options.signal }, options.capabilityVerifiers)
    for (const outcome of capabilities) { result.missing.push(...outcome.missing); Object.assign(result, outcome.report) }
    let designHash: string | undefined
    try { designHash = findProject(options.projectId).ux_confirmation?.design_hash } catch { /* legacy isolated verification */ }
    const hostGui = await runGuiAcceptance({ projectId: options.projectId, root, scopeHash: prdScopeFingerprint(backplane), designHash, signal: options.signal })
    if (!hostGui) {
      try { if (findProject(options.projectId).gui_acceptance) result.missing.push('宿主独立GUI验收规则缺失，不能用产品自测替代') }
      catch { /* a missing project is already diagnosed by the PRD reader */ }
    }
    if (hostGui) {
      result.host_gui = hostGui
      if (hostGui.covers.some(id => !ids.has(id))) throw new Error('GUI_COVERAGE_UNKNOWN_REQUIREMENT')
      if (hostGui.status !== 'passed') result.missing.push(`宿主GUI业务验收未通过：${hostGui.error ?? hostGui.status}`)
      for (const fid of hostGui.covers) result.evidence.push({ fid, scenario: 'host-native-gui', input: 'gui',
        outcome: hostGui.status === 'passed' ? 'pass' : hostGui.status === 'failed' ? 'fail' : 'unverified' })
    }
    for (const requirement of required) {
      const rows = result.evidence.filter(e => e.fid === requirement.id && e.outcome === 'pass' && e.input !== 'mock')
      if (!rows.length) result.missing.push(requirement.id)
      const completion = result.requirements.find(entry => entry.id === requirement.id)!
      const evidence = result.evidence.filter(e => e.fid === requirement.id)
      completion.verification = evidence.some(e => e.outcome === 'fail') ? 'failed' : evidence.some(e => e.outcome === 'blocked') ? 'environment_blocked' :
        rows.length && evidence.every(e => e.outcome === 'pass') ? 'passed' : 'unverified'
      for (const outcome of capabilities) {
        const status = outcome.features[requirement.id]
        if (status) completion.verification = combineVerification(completion.verification, status)
      }
    }
    const guiEntryPassed = guiReport?.routing === 'pass' && guiReport.scenarios.some(s => s.outcome === 'pass')
    if (!result.evidence.some(e => e.input === 'gui' && e.outcome === 'pass') && !guiEntryPassed) result.missing.push('缺少关键界面业务链的驱动回读')
    for (const executed of reports) if (executed.routing !== 'pass') result.missing.push(executed.routingReason, executed.stderrExcerpt.slice(0, 300))
    // PRD lives outside the generated root. Re-read it after all probes, rather than
    // hashing the same in-memory requirements captured at the start twice.
    if (fingerprintOf(root, requirementVerificationContext(readPrdBackplane(options.projectId))) !== fingerprint) {
      result.missing.push('验证期间源码或需求契约变化，本次结果作废')
      for (const item of result.requirements) item.verification = 'unverified'
    }
    if (reports.some(r => r.routing === 'fail') || capabilities.some(outcome => outcome.status === 'failed') || hostGui?.status === 'failed') { result.status = 'failed'; result.summary = '核心功能测试失败，需要修复。' }
    else if (reports.some(r => r.routing === 'blocked') || capabilities.some(outcome => outcome.status === 'environment_blocked')) { result.status = 'environment_blocked'; result.summary = '验证环境未就绪，程序已保留。' }
    else if (result.missing.length || !fingerprint || result.requirements.some(item => item.verification !== 'passed') || capabilities.some(outcome => outcome.status === 'unverified')) {
      result.summary = result.requirements.some(item => item.implementation === 'partial' || item.implementation === 'missing')
        ? '程序已保留，仍有未完成的已确认功能，尚不能完整交付。'
        : result.requirements.some(item => item.implementation === 'unverified')
          ? '程序已保留，功能实现情况尚未确认，不能完整交付。' : '已生成，核心功能仍有待验证项。'
    }
    else { result.status = 'passed'; result.summary = '核心业务驱动已通过，验证范围见报告。' }
    }
  } catch (error) {
    if (options.signal?.aborted) throw error
    if (result.status === 'passed') {
      result.status = 'unverified'; result.summary = '验证未能完整收口，产物已保留。'
      for (const row of result.requirements ?? []) row.verification = 'unverified'
    }
    result.missing.push(error instanceof Error ? error.message : String(error))
  } finally {
    if (dataRoot) { try { rmSync(dataRoot, { recursive: true, force: true }) } catch { /* owned test fixture only */ } }
  }
  if (root) {
    try { writeTextFileAtomic(join(root, CORE_REPORT_REL), JSON.stringify(result, null, 2)) }
    catch { result.status = 'environment_blocked'; result.summary = '验证记录未能保存，不能确认交付。' }
  }
  return result
}

/** Lean projects observe the actual application, without requiring a second
 * product-authored script to print PASS. Specialized adapters remain mandatory. */
async function verifyLeanBehavior(options: CoreVerificationOptions, root: string, brief: import('../model/prd-backplane').PrdBackplane, result: CoreVerificationResult): Promise<void> {
  result.verification_scope='registered_local_cases_and_capability_contracts'
  if (!brief.user_confirmed_at) throw new Error('LEAN_SCOPE_NOT_CONFIRMED')
  if (isSoftwareProject(options.projectId)) {
    const declared = readLaunchDeclaration(root)
    if (!declared?.ok) throw new Error('SOFTWARE_LAUNCH_DECLARATION_REQUIRED')
    assertSoftwareDelivery(brief, declared.launch)
  }
  const scope = prdScopeFingerprint(brief)
  const states = new Map(brief.requirements.map(row => [row.id, 'unverified' as CoreVerificationStatus]))
  let behavior: CoreVerificationStatus = 'unverified'
  if (brief.lean_brief!.ui === 'none') {
    const cli = result.host_cli = await runLeanCliCheck(options.projectId, root, options.signal)
    behavior = cli.status
    if (cli.status !== 'passed') result.missing.push(`实际命令入口检查：${cli.error ?? cli.status}`)
    for (const check of cli.cases) for (const fid of check.covers) {
      result.evidence.push({ fid, scenario: check.name, input: 'cli', outcome: check.passed ? 'pass' : 'fail' })
      states.set(fid, check.passed && states.get(fid) !== 'failed' ? 'passed' : 'failed')
    }
  } else {
    // Confirmed direction must also be current at verification, not only at build entry.
    const { readConfirmedUxBinding } = await import('../project/ux-binding')
    readConfirmedUxBinding(options.projectId, brief)
    const gui = await runGuiAcceptance({ projectId: options.projectId, root, scopeHash: scope,
      designHash: findProject(options.projectId).ux_confirmation?.design_hash, signal: options.signal })
    if (!gui) result.missing.push('缺少宿主GUI操作，使用register_gui_check登记后重验')
    else {
      result.host_gui = gui; behavior = gui.status
      if (gui.covers.some(id => !states.has(id))) throw new Error('GUI_COVERAGE_UNKNOWN_REQUIREMENT')
      if (gui.status !== 'passed') result.missing.push(`实际界面业务检查：${gui.error ?? gui.status}`)
      for (const row of guiFeatureResults(gui)) {
        states.set(row.id, row.status)
        result.evidence.push({ fid:row.id, scenario:row.cases.join('; ')||'host-native-gui', input:'gui', outcome:row.status==='failed'?'fail':row.not_run?'not_run':row.status==='passed'?'pass':'unverified' })
      }
    }
  }
  const manifest = existsSync(join(root, CORE_MANIFEST_REL)) ? JSON.parse(readFileSync(join(root, CORE_MANIFEST_REL), 'utf8')) as Record<string, unknown> : {}
  const capabilities = await runCapabilityVerifiers({ projectId: options.projectId, root, backplane: brief, manifest, signal: options.signal }, options.capabilityVerifiers)
  for (const outcome of capabilities) {
    result.missing.push(...outcome.missing); Object.assign(result, outcome.report)
    behavior = combineVerification(behavior, outcome.status)
    for (const [fid, state] of Object.entries(outcome.features)) states.set(fid, combineVerification(states.get(fid) ?? 'unverified', state))
  }
  result.requirements = brief.requirements.map(row => {
    const verification = states.get(row.id) ?? 'unverified'
    if (verification !== 'passed') result.missing.push(`${row.id}: ${verification}`)
    return { id: row.id, requirement_hash: requirementEvidenceHash(brief, row), implementation: verification === 'passed' ? 'implemented' : 'unverified', verification }
  })
  result.status = result.requirements.reduce((status, row) => combineVerification(status, row.verification), behavior)
  if (result.missing.length && result.status === 'passed') result.status = 'unverified'
  if (isSoftwareProject(options.projectId)) {
    result.local_status = result.status
    result.distribution = await qualifySoftwareArtifact(root, brief, options.signal)
    if (result.distribution.status !== 'passed') {
      result.status = combineVerification(result.status, result.distribution.status)
      result.missing.push(result.distribution.detail)
    }
  }
  result.summary = result.status === 'passed' ? '已登记的本机业务案例与能力协议检查通过，完整效果以实际验收范围为准。' : '实际功能检查尚未全部通过，产物已保留。'
}

export const CORE_DECLARATION_BRIEF = `
所有逻辑与界面场景都登记在同一个 scenarios 数组，分别标记 input=logic/gui；不要使用 gui_scenarios 字段。用固定场景名，避免把 repr/JSON 格式化的测试输入拼入名称后与声明产生引号差异。
核心业务验证：复用已写好的测试，在项目根登记 CORE_CHECK.json：
{"schema_version":2,"requirements":[{"id":"F-001","requirement_hash":"需求清单中的完整验证版本","implementation":"implemented"}],"command":["python","core_check.py"],"scenarios":[{"name":"新增并重启仍保留","covers":["F-001"],"input":"gui"}]}。
requirements 必须列出全部已确认功能项，P0/P1/P2 仅决定顺序。implementation 如实填 implemented/partial/missing/unverified；仅 mock、占位分支或尚未调用真实端点的功能不能填 implemented。核对每个场景与本项描述和断言后再登记版本，不可只复制旧覆盖编号。实现状态与测试结果独立，旧声明仅作诊断，不认证新交付。
command 必须实际执行并输出所有登记场景；只有逻辑测试时 input 填 logic。已有独立 GUI 测试可另登记 gui_command:["python","test_ui.py"]，平台顺序执行两者，gui 场景仅从 GUI 入口回读，不必重写测试或额外造聚合脚本。场景名必须全局唯一，stdout 为 PASS/FAIL/BLOCKED 加完全一致的场景名。每个已确认需求至少一条实际业务断言，至少一条实际界面业务链。input 如实填 logic/gui/audio/microphone/mock；mock 不覆盖真实能力。数据目录从 APP_DATA_DIR 读取。`
export const MODEL_VERIFICATION_BRIEF = `模型功能须实现实际 HTTP 客户端与用户可配 endpoint/model/Key，保留无配置引导；不得以固定 network_error 伪装连接失败。复用内置 llm_client.py，登记 llm:{"module":"app","factory":"Logic","method":"enhance","covers":["对应模型功能 F-id"]}，入口接收 {prompt,config:{endpoint,model,api_key,provider,timeout}}，返回 {ok,kind,text/message}。必须登记产品实际使用的入口，不能另写只供探针的替身。宿主用本机 HTTP 服务验证请求、响应、401/404/429/非法响应及无 Key，不调用付费端点；外部生成质量另列待真实验证。`
export const SPEECH_VERIFICATION_BRIEF = `语音复用 speech_runtime.py 的 SpeechEngine/StreamingRecorder，另加 speech:{"module":"speech_runtime","factory":"SpeechEngine","method":"transcribe","rate_argument":true}，须指向产品实际使用的 ASR 实例构造入口，宿主固定 WAV/二维 PCM 探针会执行它。录音只入队，准备/识别在后台，UI 线程显示累计文字；硬件采集需要单独授权证据，文本模拟不能替代。环境不具备时明确待验证，不改需求或期望绕过失败。`
export const CORE_VERIFICATION_BRIEF = [CORE_DECLARATION_BRIEF, MODEL_VERIFICATION_BRIEF, SPEECH_VERIFICATION_BRIEF].join('\n')
