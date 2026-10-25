import { app } from 'electron'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { resolveDelegationChannelOverride } from '../main/agent/delegation/delegation-channel'
import { anthropicMessagesQueryViaProviders } from '../main/platform/upstream/providers/loop-query'
import { createRequestBudget } from '../main/platform/llm/request-budget'
import { readMonetaryBudget } from '../main/platform/llm/monetary-budget'
import { createProject, findProject } from '../main/project/project-service'
import { parseLeanBrief } from '../main/guide/lean-brief'
import { readPrdBackplane, markPrdUserConfirmed } from '../main/project/prd-store'
import { syncDocuments } from '../main/project/document-sync'
import { enterDesktopLine } from '../main/desktop/desktop-route'
import { activeSoftwareRelease } from '../main/software/release-store'
import { readProjectUsage } from '../main/platform/llm/request-ledger'
import { redactSoftwareOutput } from '../main/software/process-manager'
import { guiSuitePath } from '../main/desktop/gui-acceptance'
import { buildLeanGuiTool } from '../main/desktop/lean-gui-tool'
import { createToolState } from '../main/agent/loop/agent-loop'
import { handleGuideMessage } from '../main/guide/stages/guide-pipeline'
import { registerProjectsIpc } from '../main/ipc/projects'
import { IPC_CHANNELS, type AgentEvent } from '../shared/types'
import { launchSoftwareForUser } from '../main/software/user-launch'
import { stopSoftwareSession } from '../main/software/process-manager'
import { observeSoftwareUi } from '../main/software/ui-observation'
import { softwareEnvironment } from '../main/software/command-runtime'
import type { SDKQuery, SDKQueryOptions } from '../main/orchestration/stages/orchestration-contracts'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export async function main() {
  const root = resolve(process.env.SOFTWARE_PAID_ROOT!), phase = process.env.SOFTWARE_PAID_PHASE ?? 'preflight'
  if (!['preflight', 'refresh', 'run', 'resume', 'resume-2', 'verify-only', 'verify-selectors', 'verify-software-policy', 'fresh-guide'].includes(phase)) throw Error('UNKNOWN_TEST_PHASE')
  const fresh = phase === 'fresh-guide'
  const hostOnly = phase.startsWith('verify-')
  const home = join(root, 'home'), manifestPath = join(root, 'manifest.json'), policy = join(root, 'monetary-policy.json')
  mkdirSync(root, { recursive: true }); mkdirSync(home, { recursive: true })
  process.env.PROMA_HOME = home
  process.env.BLOMA_DISPATCH_EXPERIMENT = '0'; delete process.env.BLOMA_EXPERIMENT_UNLIMITED_MONETARY
  const profile = join(root, 'electron-profile'), encryptedState = join(process.env.APPDATA!, 'bloma', 'Local State')
  mkdirSync(profile, { recursive: true })
  if (!existsSync(encryptedState)) throw Error('MATCHING_ENCRYPTED_LOCAL_STATE_UNAVAILABLE')
  cpSync(encryptedState, join(profile, 'Local State'))
  app.setPath('userData', profile); await app.whenReady()
  const sourceChannels = join(process.env.SOFTWARE_SOURCE_HOME ?? join(homedir(), '.proma'), 'bloma-channels.json')
  // The private test receives ciphertext only. No key is exported or printed.
  cpSync(sourceChannels, join(home, 'bloma-channels.json'))
  const binding = resolveDelegationChannelOverride({ channelId: 'c0711f40-a244-4df1-96bd-b06a323b829e', modelId: 'deepseek-flash' })!
  if (binding.modelName !== 'deepseek-flash' || binding.providerType !== 'deepseek' || binding.env.ANTHROPIC_BASE_URL !== 'https://api.deepseek.com/anthropic') throw Error('LIVE_CHANNEL_SELECTOR_CHANGED')
  const key = binding.env.ANTHROPIC_AUTH_TOKEN ?? binding.env.ANTHROPIC_API_KEY
  if (!key) throw Error('LIVE_KEY_UNAVAILABLE')
  const safe = (value: unknown) => redactSoftwareOutput(JSON.stringify(value)).split(key).join('[REDACTED]')
  const get = async (path: string) => {
    const response = await fetch(`https://api.deepseek.com/${path}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw Error(`FREE_PREFLIGHT_HTTP_${response.status}`)
    return response.json() as Promise<any>
  }
  if (phase === 'preflight' || phase === 'refresh') {
    const priorManifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : undefined
    if (priorManifest && phase !== 'refresh') throw Error('PREFLIGHT_ALREADY_EXISTS_USE_EXISTING_TEST_WINDOW')
    if (phase === 'refresh' && priorManifest?.authorization?.new_test_cap_rmb !== 3) throw Error('EXISTING_AUTHORIZATION_REQUIRED')
    const models = await get('models'), balance = await get('user/balance')
    if (!models.data?.some((model: any) => model.id === 'deepseek-flash') || balance.is_available !== true) throw Error('LIVE_MODEL_OR_BALANCE_UNAVAILABLE')
    const info = balance.balance_infos?.find((row: any) => row.currency === 'CNY')
    if (!info || !(Number(info.total_balance) >= 3)) throw Error('CNY_BALANCE_NOT_SUFFICIENT_OR_UNKNOWN')
    const priceResponse = await fetch('https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', { signal: AbortSignal.timeout(20000) })
    if (!priceResponse.ok) throw Error('LIVE_PRICING_UNAVAILABLE')
    const pricing = await priceResponse.text(), text = pricing.replace(/<[^>]*>/g, '').replace(/\s+/g, '')
    if (!text.includes('deepseek-flash') || !text.includes('2元') || !text.includes('8元') || !text.includes('0.04元')) throw Error('LIVE_PRICING_CHANGED_REVIEW_REQUIRED')
    writeFileSync(join(root, 'pricing.html'), pricing)
    const oldEpochRoot = process.env.BLOMA_MONETARY_EPOCH_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'Bloma', 'monetary-epochs')
    const oldEpoch = join(oldEpochRoot, hash('api.deepseek.com\ndeepseek-flash') + '.json'), oldFiles: string[] = []
    if (existsSync(oldEpoch)) { oldFiles.push(oldEpoch); const old = JSON.parse(readFileSync(oldEpoch, 'utf8')); oldFiles.push(old.policy_path); if (existsSync(old.policy_path + '.state.json')) oldFiles.push(old.policy_path + '.state.json') }
    const manifest = { version: 1, at: new Date().toISOString(), authorization: { source: 'direct_user_confirmation', new_test_cap_rmb: 3 },
      channel_id: binding.channelId, model: binding.modelName, host: 'api.deepseek.com', selector_source_sha256: hash(readFileSync(sourceChannels)),
      model_catalog_available: true, balance_before: { currency: 'CNY', total: info.total_balance, available: balance.is_available },
      pricing: { source: priceResponse.url, sha256: hash(pricing), context_tokens: 1048576, input_peak_rmb_per_million: 2, output_peak_rmb_per_million: 8, cache_peak_rmb_per_million: 0.04 },
      old_accounting: priorManifest?.old_accounting ?? oldFiles.map(path => ({ path, sha256: hash(readFileSync(path)) })),
      scope: 'new explicitly authorized 3 RMB software smoke; original experiment records and global accounting remain unchanged; all retries share this durable ceiling' }
    const expected = JSON.stringify({ version: 1, models: [{ host: 'api.deepseek.com', model: 'deepseek-flash', cap_rmb: 3, context_tokens: 1048576,
      input_rmb_per_million: 2, output_rmb_per_million: 8, cache_rmb_per_million: 0.04 }] }, null, 2)
    if (existsSync(policy)) { if (readFileSync(policy, 'utf8') !== expected) throw Error('EXISTING_MONETARY_POLICY_CHANGED') }
    else writeFileSync(policy, expected)
    if (priorManifest) {
      const bytes = readFileSync(manifestPath); mkdirSync(join(root, 'preflight-history'), { recursive: true }); writeFileSync(join(root, 'preflight-history', hash(bytes) + '.json'), bytes)
      Object.assign(manifest, { balance_before: priorManifest.balance_before, balance_latest: { currency: 'CNY', total: info.total_balance }, refreshed_from_sha256: hash(bytes) })
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    process.stdout.write(safe({ phase, status: 'ready', model: binding.modelName, currency: 'CNY', available: true, cap_rmb: 3, generation_requests: 0 }) + '\n'); return
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.authorization?.new_test_cap_rmb !== 3 || !hostOnly && Date.now() - Date.parse(manifest.at) > 3600000 || manifest.selector_source_sha256 !== hash(readFileSync(sourceChannels))) throw Error('PREFLIGHT_STALE_OR_CHANGED')
  for (const old of manifest.old_accounting) if (hash(readFileSync(old.path)) !== old.sha256) throw Error('ORIGINAL_ACCOUNTING_CHANGED')
  const expectedPolicy = JSON.parse(readFileSync(policy, 'utf8')).models?.[0]
  if (expectedPolicy?.cap_rmb !== 3 || expectedPolicy.context_tokens !== manifest.pricing.context_tokens || expectedPolicy.input_rmb_per_million !== 2 || expectedPolicy.output_rmb_per_million !== 8 || expectedPolicy.cache_rmb_per_million !== 0.04) throw Error('MONETARY_POLICY_CHANGED')
  process.env.BLOMA_MONETARY_POLICY = policy
  // A distinct, explicitly funded test window; never switch/reset the global
  // epoch or erase liabilities belonging to an earlier frozen experiment.
  process.env.BLOMA_MONETARY_EPOCH_DIR = join(root, 'test-window-epochs')
  const existing = existsSync(policy + '.state.json') ? JSON.parse(readFileSync(policy + '.state.json', 'utf8')).entries.length : 0
  const continuing = /^resume(?:-2)?$/.test(phase) || hostOnly, originalReport = continuing ? JSON.parse(readFileSync(join(root, 'report.json'), 'utf8')) : undefined
  const requestLimit = fresh ? 128 : phase === 'resume-2' ? 56 : 40
  if (!hostOnly && existing >= requestLimit) throw Error('TEST_REQUEST_LIMIT_EXHAUSTED')
  const control = createRequestBudget(binding.env, { requests: Math.max(0, requestLimit - existing), outputTokens: 8192, rmb: 3 })
  const paid = control.wrap(anthropicMessagesQueryViaProviders), deadline = AbortSignal.timeout(8 * 60000)
  let logical = 0
  const query: SDKQuery = async function* (prompt, options) {
    if (hostOnly) throw Error('REQUEST_BUDGET_EXHAUSTED') // No provider request; exercise production host-only completion.
    if (options.env.ANTHROPIC_MODEL !== binding.modelName || options.env.ANTHROPIC_BASE_URL !== binding.env.ANTHROPIC_BASE_URL) throw Error('PAID_SMOKE_ROUTE_CHANGED')
    logical++
    yield* paid(prompt, { ...options, monetaryPolicyPath: policy, thinkingLevel: 'low', maxTokens: Math.min(8192, options.maxTokens ?? 8192),
      signal: AbortSignal.any([options.signal, deadline]), responseHeaderTimeoutMs: 30000 })
  }
  const reportPath = join(root, fresh ? 'report-fresh-guide-01.json' : phase === 'verify-software-policy' ? 'report-software-policy.json' : hostOnly ? `report-${phase === 'verify-only' ? 'host-only' : 'host-selectors'}.json` : continuing ? `report-continuation-${phase === 'resume-2' ? '02' : '01'}.json` : 'report.json')
  if (existsSync(reportPath)) throw Error('TEST_ALREADY_RAN_PRESERVE_RESULT_DO_NOT_REPEAT')
  const report: any = { version: 1, at: new Date().toISOString(), status: 'running', model: binding.modelName, budget_rmb: 3, scope: 'confirmed short goal → actual software-v1 Pi executor → host checks; one new browser notes task; no comparison/control or claim of general quality' }
  const save = () => writeFileSync(reportPath, safe({ ...report, operation: control.snapshot(), money: existsSync(policy + '.state.json') ? readMonetaryBudget(policy) : [] }))
  const events = (type: string, payload: unknown) => { appendFileSync(join(root, fresh ? 'events-fresh-guide-01.jsonl' : 'events.jsonl'), safe({ at: new Date().toISOString(), phase, type, payload }) + '\n'); save() }
  try {
    if (continuing && (!originalReport.project_id || !originalReport.tool_qualification || originalReport.status === 'host_checks_passed')) throw Error('ORIGINAL_TEST_NOT_RESUMABLE')
    if (!continuing) {
    const qualified: any[] = []
    const qualification: SDKQueryOptions = { env: binding.env, signal: deadline, sessionId: 'qualification', maxTokens: 1024,
      systemPrompt: 'Call the provided echo tool exactly once with text ready.', messages: [{ role: 'user', content: 'Call echo with text ready.' }],
      tools: [{ name: 'echo', description: 'Return the provided text.', input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } }] }
    for await (const message of query('', qualification)) if (message.type === 'assistant') qualified.push(...((message as any).message?.content ?? []))
    if (!qualified.some(item => item.type === 'tool_use' && item.name === 'echo' && item.input?.text === 'ready')) throw Error('LIVE_TOOL_QUALIFICATION_FAILED')
    report.tool_qualification = 'real provider emitted structured tool call'
    } else { report.tool_qualification = originalReport.tool_qualification; report.resumes_report_sha256 = hash(readFileSync(join(root, 'report.json'))) }
    let project
    if (fresh) {
      const handlers = new Map<string, (...args: any[]) => any>()
      registerProjectsIpc({ handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) } as never, {} as never)
      const created = await handlers.get(IPC_CHANNELS.PROJECT_CREATE)!({}, { request_id: randomUUID(), mode: 'quick', initial_message: '本机浏览器记事本' })
      if (!created.ok) throw Error('PUBLIC_PROJECT_CREATE_FAILED')
      project = created.data
    } else project = continuing ? findProject(originalReport.project_id) : createProject({ request_id: randomUUID(), mode: 'quick', initial_message: '本机浏览器记事本' }, { workflowVersion: 'software-v1' })
    if (phase === 'verify-selectors') {
      const file = guiSuitePath(project.project_id), original = readFileSync(file), suite = JSON.parse(original.toString('utf8'))
      const changed: Array<{ id: string; before: string; after: string }> = []
      for (const step of suite.steps) if (step.kind === 'click' && step.selector?.includes('.note-item:nth-child')) {
        const title = step.id.includes('pick-a') ? '验收笔记A' : '验收笔记B', after = `#note-list .note-item:has-text("${title}")`
        changed.push({ id: step.id, before: step.selector, after }); step.selector = after
      }
      if (changed.length !== 6) throw Error('UNEXPECTED_SELECTOR_REPAIR_SCOPE')
      writeFileSync(join(root, 'gui-before-selector-repair.json'), original)
      const repaired = await buildLeanGuiTool(project.project_id).execute({ steps: suite.steps, acceptance_refs: suite.acceptance_refs },
        { projectId: project.project_id, sessionId: 'software-smoke', requestId: 'selector-repair', signal: deadline, state: createToolState() })
      if (repaired.isError) throw Error(repaired.output)
      report.manual_selector_changes = changed; report.manual_diagnostic_interventions = 2
    }
    const sessionId = fresh ? 'software-fresh-guide' : 'software-smoke'
    if (phase === 'verify-software-policy') report.manual_diagnostic_interventions = 2
    report.project_id = project.project_id; report.root = project.root_path; report.session_id = sessionId
    const goal = '做一个在本机浏览器使用的简单记事本。可以新增、编辑笔记，保存后关闭重开仍保留。界面简洁、操作明确，不需要账号或联网服务。先完成这个小版本。'
    if (!continuing && !fresh) {
    const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal, ui: 'required', delivery: 'browser', requirements: [
      { description: '新增和编辑笔记', expected: '能新增两条不同笔记，并修改其中一条，另一条保持不变' },
      { description: '保存并重开', expected: '保存后关闭程序再打开，两条笔记及修改后的内容仍然存在' }] }),
    { projectId: project.project_id, sessionId: 'software-smoke', source: goal, previous: readPrdBackplane(project.project_id), software: true })!
    if (parsed.action !== 'brief') throw Error('FIXED_GOAL_INVALID')
    parsed.brief.lean_brief!.preview = 'skip'
    syncDocuments({ request_id: randomUUID(), project_id: project.project_id, session_id: 'software-smoke', checkpoint: 'requirement_confirmed' }, parsed.brief)
    const confirmed = markPrdUserConfirmed(project.project_id)!
    const { updateProject } = await import('../main/project/project-service'), { prdScopeFingerprint } = await import('../main/project/requirement-contract')
    const scope = prdScopeFingerprint(confirmed); updateProject(project.project_id, { ux_confirmation: { prd_fingerprint: scope, design_hash: scope, html_hash: null } })
    }
    save()
    if (fresh) {
      report.scope = 'public project creation → actual model short-goal extraction → actual scope confirmation → software executor → host checks and delivery; fresh project and transcript, shared original 3 RMB ledger'
      report.manual_diagnostic_interventions = 0
      const cards: AgentEvent[] = [], input = { project_id: project.project_id, session_id: sessionId, request_id: randomUUID(), mode: 'quick' as const, current_stage: 'clarifying' as const,
        content: goal + '不用草图。' }
      const publish = (event: AgentEvent) => { if (event.type === 'user_decision_required') cards.push(event); events(event.type, event.payload) }
      const model = { query, env: binding.env, signal: deadline, sessionId, history: [], maxTokens: 8192, persistAssistant: () => {} }
      await handleGuideMessage(input, publish, model)
      const brief = readPrdBackplane(project.project_id)
      if (!brief.user_confirmed_at) {
        const card = cards.find(event => event.payload.kind === 'lean_scope'), questions = card?.payload.questions as Array<{ id: string }> | undefined
        const id = questions?.find(question => question.id.startsWith('lean_confirm:'))?.id
        if (!id || brief.lean_brief?.delivery !== 'browser') throw Error('EXPECTED_SCOPE_CONFIRMATION_OR_DELIVERY_MISMATCH')
        report.scope_confirmation = 'actual published scope card selected, no engineering correction'
        await handleGuideMessage({ ...input, request_id: randomUUID(), content: '按这份做', metadata: { source: 'card_option', selected_option_id: id } }, publish, model)
      }
    } else {
    const diagnostic = phase === 'resume-2' ? '宿主诊断：当前反复stale源于把临时验证数据写进项目的tmp-verify-data，保存JSON会改变源码指纹。使用start_service默认提供的工程外APP_DATA_DIR，不再自行覆盖。已有程序不必重建，完成正常入口和register_gui_check登记后让宿主验收。' : ''
    if (diagnostic) report.manual_diagnostic_interventions = 1
    await enterDesktopLine({ projectId: project.project_id, sessionId: 'software-smoke', requestId: randomUUID(), content: continuing ? `继续沿已有程序完成原记事本目标并验证，不重复创建项目。${diagnostic}` : goal, maxTokens: 8192, signal: deadline }, query, binding.env,
      { publish: (_target, type, payload) => events(type, payload), persistAssistant: () => {}, persistSystem: () => {}, complete: (_s, _p, subtype) => { report.completion = subtype ?? 'success' } })
    }
    const final = findProject(project.project_id), released = await activeSoftwareRelease(project.project_id)
    report.project_status = final.status; report.blocked = final.desktop_blocked; report.release = released?.id
    if (released && existsSync(join(released.root, '00_VERIFY/core-verification.json'))) report.core = JSON.parse(readFileSync(join(released.root, '00_VERIFY/core-verification.json'), 'utf8'))
    report.status = final.status === 'completed' && report.core?.status === 'passed' ? 'host_checks_passed' : 'incomplete'
    if (released && report.status === 'host_checks_passed') {
      const { chromium } = await import('playwright')
      const browser = await chromium.launch({ headless: true, env: softwareEnvironment(project.project_id),
        ...(existsSync(chromium.executablePath()) ? { executablePath: chromium.executablePath() } : { channel: process.platform === 'win32' ? 'msedge' : 'chrome' }) })
      try {
        const page = await browser.newPage()
        const launched = await launchSoftwareForUser(project.project_id, project.root_path, released.launch, async url => { await page.goto(url, { waitUntil: 'networkidle' }) })
        report.user_launch = { ...launched, ui: await observeSoftwareUi(page), boundary: 'normal user-launch/data path and actual browser; not an independent assertion of every business behavior' }
        if (!launched.started) throw Error('USER_TRIAL_LAUNCH_FAILED')
        await page.screenshot({ path: join(root, fresh ? 'fresh-user-launch.png' : 'original-user-launch.png') })
      } finally { await browser.close(); await stopSoftwareSession(project.project_id, 'user-launch') }
    }
    report.usage = readProjectUsage(project.project_id)
  } catch (error) { report.status = 'failed'; report.error = String(error) }
  finally {
    report.logical_queries = logical; report.finished_at = new Date().toISOString()
    const balance = await get('user/balance').catch(() => undefined)
    report.balance_after = balance?.balance_infos?.filter((row: any) => row.currency === 'CNY').map((row: any) => ({ currency: row.currency, total: row.total_balance }))
    report.old_accounting_unchanged = manifest.old_accounting.every((old: any) => hash(readFileSync(old.path)) === old.sha256)
    save(); process.stdout.write(safe({ status: report.status, logical_queries: logical, money: readMonetaryBudget(policy), report: reportPath }) + '\n')
  }
}
