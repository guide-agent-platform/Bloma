// Bounded transport probes only, never a product-quality or autonomous-planning trial.
// Run through esbuild (see the dated readiness report). Credentials remain DPAPI-only.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { anthropicMessagesQueryViaProviders } from '../main/platform/upstream/providers/loop-query'
import { activeMonetaryPolicyPath, activateMonetaryPolicy } from '../main/platform/llm/monetary-epoch'
import { readMonetaryBudget } from '../main/platform/llm/monetary-budget'
import type { ConversationTurn, SDKQueryOptions } from '../main/orchestration/orchestrator'
import type { MessageContentBlock } from '../shared/types'

const args = process.argv.slice(2)
const option = (name: string) => { const i = args.indexOf(`--${name}`); if (i < 0 || !args[i + 1]) throw new Error(`Missing --${name}`); return args[i + 1] }
const out = resolve(option('out')), credentialPath = resolve(option('credentials'))
mkdirSync(out, { recursive: true })
process.env.PROMA_HOME = join(out, 'home')
const live = args.includes('--live')
const recover = args.includes('--recover')
if (!recover && existsSync(join(out, 'preflight.json'))) throw new Error('PREFLIGHT_OUTPUT_EXISTS')
const report: Record<string, any> = recover ? JSON.parse(readFileSync(join(out, 'preflight.json'), 'utf8'))
  : { at: new Date().toISOString(), kind: 'transport_preflight', live,
    product_quality: null, metadata: {}, probes: [], policies: {}, physical_requests: 0 }
const save = () => writeFileSync(join(out, 'preflight.json'), JSON.stringify(report, null, 2))
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const decrypt = "$ErrorActionPreference='Stop';$s=Get-Content -LiteralPath $env:BEX_CREDENTIAL_STORE -Raw|ConvertFrom-Json;$r=@{};foreach($n in @('deepseek','glm')){$v=ConvertTo-SecureString $s.$n;$r[$n]=[System.Net.NetworkCredential]::new('', $v).Password};$r|ConvertTo-Json -Compress"
const keys = JSON.parse(execFileSync('pwsh.exe', ['-NoProfile', '-Command', decrypt], {
  encoding: 'utf8', windowsHide: true, env: { ...process.env, BEX_CREDENTIAL_STORE: credentialPath }, stdio: ['ignore', 'pipe', 'pipe'],
}).replace(/^\uFEFF/, ''))
if (!keys.deepseek || !keys.glm) throw new Error('PREFLIGHT_CREDENTIALS_MISSING')

async function metadata(path: string) {
  const response = await fetch(`https://api.deepseek.com${path}`, { headers: { Authorization: `Bearer ${keys.deepseek}` }, signal: AbortSignal.timeout(30000) })
  const raw = await response.json() as any
  return { http_status: response.status, ...(path === '/models' ? { models: raw.data } : { is_available: raw.is_available, balance_infos: raw.balance_infos }) }
}

// A tiny Coding Plan probe uses the existing regular tariff as a conservative
// accounting proxy, NOT as a subscription invoice. Carry every old liability;
// never reset a model or release unknown usage. The reduced context reservation
// is allowed ONLY because requestGuard bounds the entire outgoing body in bytes.
function codingProbePolicy() {
  const host = 'open.bigmodel.cn', model = 'glm-5.3'
  const previous = activeMonetaryPolicyPath({ host, model })
  if (!previous) throw new Error('PREFLIGHT_EXISTING_GLM_BUDGET_REQUIRED')
  const originalPolicy = JSON.parse(readFileSync(previous, 'utf8').replace(/^\uFEFF/, ''))
  const originalState = JSON.parse(readFileSync(previous + '.state.json', 'utf8'))
  const rows = originalState.entries.filter((e: any) => e.host === host && e.model === model)
  if (rows.some((e: any) => e.status === 'reserved')) throw new Error('PREFLIGHT_GLM_ACTIVE_RESERVATIONS')
  const rate = originalPolicy.models.find((e: any) => e.host === host && e.model === model)
  if (!rate) throw new Error('PREFLIGHT_GLM_RATE_MISSING')
  const path = join(out, 'coding-probe-policy.json')
  const bytes = JSON.stringify({ version: 1, models: [{ ...rate, context_tokens: 16384 }] }, null, 2)
  writeFileSync(path, bytes, { flag: 'wx' })
  writeFileSync(path + '.state.json', JSON.stringify({ ...originalState, policy_hash: hash(bytes), entries: rows,
    balance_checkpoints: originalState.balance_checkpoints?.filter((e: any) => e.host === host && e.model === model) }, null, 2), { flag: 'wx' })
  activateMonetaryPolicy(path)
  report.policies.glm = { previous, probe: path, budget_before: readMonetaryBudget(path),
    metering: 'regular_tariff_conservative_proxy_for_prepaid_plan_not_invoice', input_body_max_bytes: 12000 }
  return { path, restore: () => restoreCodingPolicy(path, previous) }
}
function restoreCodingPolicy(path: string, previous: string) {
    const state = JSON.parse(readFileSync(path + '.state.json', 'utf8'))
    if (state.entries.some((e: any) => e.status === 'reserved')) throw new Error('PREFLIGHT_UNSETTLED_GLM_REQUEST')
    const deadline = Date.now() + 2000
    let lock: number
    for (;;) {
      try { lock = openSync(previous + '.lock', 'wx'); break }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw new Error('PREFLIGHT_LEDGER_LOCKED')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }
    const temp = previous + '.state.json.preflight.tmp'
    try {
      const current = JSON.parse(readFileSync(previous + '.state.json', 'utf8'))
      const ids = new Set(current.entries.map((e: any) => e.id))
      current.entries.push(...state.entries.filter((e: any) => !ids.has(e.id)))
      writeFileSync(temp, JSON.stringify(current, null, 2), { flag: 'wx' }); renameSync(temp, previous + '.state.json')
    } finally {
      if (existsSync(temp)) unlinkSync(temp)
      closeSync(lock); unlinkSync(previous + '.lock')
    }
    activateMonetaryPolicy(previous, { only_models: ['glm-5.3'] })
    report.policies.glm.restored = true
    report.policies.glm.new_reservations = state.entries.filter((e: any) => e.at >= report.at).length
    report.policies.glm.budget_after = readMonetaryBudget(path)
}

async function probe(provider: 'deepseek' | 'zhipu-coding', key: string, policyPath: string) {
  const model = provider === 'deepseek' ? 'deepseek-flash' : 'glm-5.3'
  const counts = { admitted: 0, active: 0, peak: 0 }
  const windows: Array<{ start: number; finish: number }> = []
  async function worker(index: number) {
    const row: Record<string, any> = { provider, model, index, calls: [], tool_roundtrip: false }
    report.probes.push(row)
    const messages: ConversationTurn[] = [{ role: 'user', content: `Transport test ${index}. Call echo_probe with value "probe-${index}" exactly once. After its tool result, reply only OK.` }]
    const query = async () => {
      const begin = Date.now(); counts.active++; counts.peak = Math.max(counts.peak, counts.active)
      const blocks: MessageContentBlock[] = []; let text = '', usage, stopReason
      try {
        const options: SDKQueryOptions = {
          sessionId: `preflight-${provider}-${index}`, signal: AbortSignal.timeout(120000),
          env: { ...process.env, PATH: process.env.PATH ?? process.env.Path ?? '', ANTHROPIC_AUTH_TOKEN: key,
            ANTHROPIC_MODEL: model, ANTHROPIC_PROVIDER_TYPE: provider,
            ANTHROPIC_BASE_URL: provider === 'deepseek' ? 'https://api.deepseek.com/anthropic' : 'https://open.bigmodel.cn/api/anthropic' },
          providerType: provider, messages, maxTokens: 8192, thinkingLevel: 'high', temperature: 0.1,
          monetaryPolicyPath: policyPath, responseHeaderTimeoutMs: 60000,
          accounting: { projectId: 'parallel-preflight', runId: 'parallel-preflight-20261018', role: 'transport_probe' },
          requestGuard: request => {
            const url = new URL(request.url)
            if (url.protocol !== 'https:' || url.pathname !== (provider === 'deepseek' ? '/anthropic/v1/messages' : '/api/anthropic/v1/messages')
              || url.hostname !== (provider === 'deepseek' ? 'api.deepseek.com' : 'open.bigmodel.cn')) throw new Error('PREFLIGHT_ENDPOINT_CHANGED')
            if (Buffer.byteLength(request.body) > 12000) throw new Error('PREFLIGHT_BODY_LIMIT')
            if (++counts.admitted > 4) throw new Error('PREFLIGHT_PHYSICAL_REQUEST_LIMIT')
            save()
          },
          onTransportAttempt: state => { if (state === 'started') { report.physical_requests++; save() } },
          tools: [{ name: 'echo_probe', description: 'Echo the supplied short value.', input_schema: {
            type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }],
        }
        for await (const event of anthropicMessagesQueryViaProviders('', options)) {
          if (event.type === 'assistant') for (const block of event.message?.content ?? []) {
            if (block.type === 'tool_use') blocks.push(block)
            else if (block.type === 'text') text += block.text
          }
          if (event.type === 'result') { usage = event.usage; stopReason = event.stop_reason }
        }
        row.calls.push({ duration_ms: Date.now() - begin, usage, stop_reason: stopReason,
          tools: blocks.filter(block => block.type === 'tool_use').map(block => ({ name: block.name, input: block.input })), text })
        if (text) blocks.unshift({ type: 'text', text })
        return blocks
      } finally { counts.active--; windows.push({ start: begin, finish: Date.now() }); save() }
    }
    try {
      const blocks = await query()
      const calls = blocks.filter(block => block.type === 'tool_use')
      if (calls.length !== 1 || calls[0].type !== 'tool_use' || calls[0].name !== 'echo_probe'
        || calls[0].input?.value !== `probe-${index}`) throw new Error('PREFLIGHT_TOOL_CALL_MISMATCH')
      messages.push({ role: 'assistant', content: blocks }, { role: 'user', content: calls.map(call => ({
        type: 'tool_result', tool_use_id: call.id, content: `probe-${index}` })) })
      const answer = await query()
      row.tool_roundtrip = answer.some(block => block.type === 'text' && block.text?.trim() === 'OK')
      if (!row.tool_roundtrip) throw new Error('PREFLIGHT_FINAL_RESPONSE_MISMATCH')
    } catch (error) {
      // Error bodies can contain request data; preserve safe classifications only.
      const e = error as any
      row.error = { type: e.name, status: e.status, provider_code: e.providerCode,
        code: /^PREFLIGHT_|^MONETARY_/.test(e.message) ? e.message : 'PROVIDER_PROBE_FAILED' }
    }
  }
  await Promise.allSettled([worker(1), worker(2)])
  report[`${provider}_concurrency`] = { peak_query_lifetimes: counts.peak, physical_admissions: counts.admitted, windows,
    note: 'Provider-level overlap; real child-loop scheduling is verified separately.' }
}

function physicalEvidence() {
  const events = readFileSync(join(process.env.PROMA_HOME!, 'usage-ledger/parallel-preflight.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const spans = events.filter(e => e.event === 'transport_started').map(start => {
    const end = events.find(e => e.event === 'transport_finished' && e.query_id === start.query_id && e.transport_index === start.transport_index)
    return { model: start.model, query_id: start.query_id, transport_index: start.transport_index,
      start: start.at, finish: end?.at, status: end?.status }
  })
  report.physical_transport_spans = spans
  for (const model of ['deepseek-flash', 'glm-5.3']) {
    const points = spans.filter(span => span.model === model && span.finish).flatMap(span => [
      { at: Date.parse(span.start), delta: 1 }, { at: Date.parse(span.finish!), delta: -1 }]).sort((a, b) => a.at - b.at || a.delta - b.delta)
    let active = 0, peak = 0
    for (const point of points) { active += point.delta; peak = Math.max(peak, active) }
    report[`${model}_physical_peak`] = peak
  }
}

try {
  if (recover) {
    restoreCodingPolicy(report.policies.glm.probe, report.policies.glm.previous)
    physicalEvidence()
    report.initial_cleanup_error ??= report.error
    delete report.error
    report.cleanup_recovered_at = new Date().toISOString()
    report.passed = report.probes.length === 4 && report.probes.every((row: any) => row.tool_roundtrip)
      && report['deepseek-flash_physical_peak'] === 2 && report['glm-5.3_physical_peak'] === 2
  } else {
  const metadataRows = await Promise.allSettled([metadata('/models'), metadata('/user/balance')])
  metadataRows.forEach((row, i) => { report.metadata[i === 0 ? 'deepseek_models' : 'deepseek_balance'] = row.status === 'fulfilled' ? row.value : { error: 'METADATA_UNAVAILABLE' } })
  const dsPolicy = activeMonetaryPolicyPath({ host: 'api.deepseek.com', model: 'deepseek-flash' })
  if (dsPolicy) report.policies.deepseek = { path: dsPolicy, budget_before: readMonetaryBudget(dsPolicy) }
  save()
  if (live) {
    if (!dsPolicy) throw new Error('PREFLIGHT_EXISTING_DS_BUDGET_REQUIRED')
    await probe('deepseek', keys.deepseek, dsPolicy)
    const coding = codingProbePolicy()
    try { await probe('zhipu-coding', keys.glm, coding.path) } finally { coding.restore() }
    physicalEvidence()
    report.policies.deepseek.budget_after = readMonetaryBudget(dsPolicy)
    report.passed = report.probes.length === 4 && report.probes.every((row: any) => row.tool_roundtrip)
      && report['deepseek-flash_physical_peak'] === 2 && report['glm-5.3_physical_peak'] === 2
  }
  }
} catch (error) {
  const message = (error as Error).message
  report.error = /^PREFLIGHT_|^MONETARY_/.test(message) ? message : 'PREFLIGHT_SETUP_FAILED'
  process.exitCode = 1
} finally { save(); console.log(JSON.stringify({ report: join(out, 'preflight.json'), live, passed: report.passed, error: report.error })) }
