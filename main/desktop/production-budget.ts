import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { readJsonFile, writeJsonFile } from '../../storage/json-store'
import type { SDKQuery, SDKQueryOptions } from '../orchestration/stages/orchestration-contracts'

interface BudgetState {
  version: 1
  requests: number
  output: number
  phases: Record<string, number>
  phaseStarts?: Record<string, number>
  runtimeMs?: number
  runtimeStartedAt?: number
  runtimeHeartbeatAt?: number
  runtimeOwner?: string
  runtimePid?: number
  runtimeUncertainMs?: number
}
const liveRuntimeLeases = new Map<string, string>()
export const RUNTIME_HEARTBEAT_MS = 5000
const RUNTIME_LEASE_MS = 15000
export interface ProductionLimits { requests: number; output: number; perResponse: number; phaseRequests: number }
const PHASE_REQUESTS: Record<string, number> = { 'desktop-arch': 64, 'desktop-scaffold': 32, 'desktop-implement': 160, 'desktop-verify': 64 }
export const PRODUCTION_LIMITS = { requests: 256, output: 262144, perResponse: 16384 }
export function productionDeadlineMs(phase: string): number {
  return ({ 'desktop-arch': 8, 'desktop-scaffold': 5, 'desktop-implement': 30, 'desktop-verify': 15 }[phase] ?? 15) * 60_000
}

/** Persistent admission, shared by primary, children, continuation and transport
 * retries. This measures requests/output, not money; existing monetary policy is
 * still authoritative. No prompts, keys or generated code enter this record. */
export function createProductionBudget(projectId: string, scope: string, phase: string,
  limits: ProductionLimits = { ...PRODUCTION_LIMITS, phaseRequests: PHASE_REQUESTS[phase] ?? 64 }, runtimeMode: 'legacy' | 'lease' = 'legacy') {
  const key = createHash('sha256').update(`${projectId}\n${scope}`).digest('hex')
  const file = join(getPromaHome(), 'harness-budgets', `${key}.json`)
  let ownedLease: string | undefined
  const load = (): BudgetState => {
    let value: BudgetState
    try { value = readJsonFile<BudgetState>(file, { version: 1, requests: 0, output: 0, phases: {} }) }
    catch { throw new Error('HARNESS_BUDGET_UNREADABLE: 运行预算记录损坏，未发起请求') }
    if (value.runtimeMs !== undefined && (!Number.isSafeInteger(value.runtimeMs) || value.runtimeMs < 0)) throw new Error('HARNESS_BUDGET_UNREADABLE')
    if (value.runtimeStartedAt !== undefined && (!Number.isSafeInteger(value.runtimeStartedAt) || value.runtimeStartedAt < 0)) throw new Error('HARNESS_BUDGET_UNREADABLE')
    if ([value.runtimeHeartbeatAt, value.runtimeUncertainMs].some(time => time !== undefined && (!Number.isSafeInteger(time) || time < 0))
      || value.runtimeOwner !== undefined && !/^[a-f0-9-]{36}$/.test(value.runtimeOwner)
      || value.runtimePid !== undefined && (!Number.isSafeInteger(value.runtimePid) || value.runtimePid < 1)
      || value.runtimeHeartbeatAt !== undefined && (value.runtimeStartedAt === undefined || value.runtimeHeartbeatAt < value.runtimeStartedAt)) throw Error('HARNESS_BUDGET_UNREADABLE')
    if (value.version !== 1 || !Number.isSafeInteger(value.requests) || value.requests < 0 || !Number.isSafeInteger(value.output)
      || value.output < 0 || !value.phases || typeof value.phases !== 'object' || Array.isArray(value.phases)
      || Object.values(value.phases).some(n => !Number.isSafeInteger(n) || n < 0)
      || value.phaseStarts !== undefined && (!value.phaseStarts || typeof value.phaseStarts !== 'object' || Array.isArray(value.phaseStarts)
        || Object.values(value.phaseStarts).some(n => !Number.isSafeInteger(n) || n < 0))) throw new Error('HARNESS_BUDGET_UNREADABLE')
    return value
  }
  const persist = (value: BudgetState) => {
    try { writeJsonFile(file, value) } catch { throw new Error('HARNESS_BUDGET_UNWRITABLE: 预算不能落盘，未放行后续请求') }
  }
  const reserve = (requested: number) => {
    const state = load()
    if (runtimeMode === 'lease' && liveRuntimeLeases.has(key) && state.runtimeOwner !== liveRuntimeLeases.get(key)) throw Error('HARNESS_RUNTIME_LEASE_LOST')
    if (state.requests >= limits.requests || (state.phases[phase] ?? 0) >= limits.phaseRequests) throw new Error('HARNESS_REQUEST_BUDGET_EXHAUSTED')
    const tokens = Math.min(requested, limits.perResponse, limits.output - state.output)
    if (tokens < 512) throw new Error('HARNESS_OUTPUT_BUDGET_EXHAUSTED')
    state.requests++
    state.phases[phase] = (state.phases[phase] ?? 0) + 1
    state.output += tokens
    persist(state)
    return tokens
  }
  const wrap = (query: SDKQuery): SDKQuery => async function* (prompt, options) {
    options.signal.throwIfAborted()
    let reservation = reserve(Math.max(512, options.maxTokens ?? limits.perResponse))
    let physical = 0
    let usage: { output_tokens?: number } | undefined
    let completed = false
    const requestGuard: SDKQueryOptions['requestGuard'] = request => {
      options.signal.throwIfAborted()
      options.requestGuard?.(request)
      const body = JSON.parse(request.body) as { max_tokens?: number; max_output_tokens?: number }
      const actual = body.max_tokens ?? body.max_output_tokens
      if (typeof actual === 'number' && actual > reservation) throw new Error('HARNESS_RESPONSE_LIMIT_EXCEEDED')
      if (physical++ > 0) {
        const next = reserve(reservation)
        if (next < reservation) throw new Error('HARNESS_OUTPUT_BUDGET_EXHAUSTED')
        reservation = next
      }
    }
    try {
      for await (const message of query(prompt, { ...options, maxTokens: reservation, requestGuard })) {
        if (message.usage) usage = { ...usage, ...message.usage }
        if (message.type === 'result') completed = message.subtype === 'success'
        yield message
      }
    } finally {
      // Unknown/cancelled requests keep their full reservation. Retried failed
      // transports also retain theirs; only the final complete usage releases it.
      if (completed && !options.signal.aborted && Number.isSafeInteger(usage?.output_tokens) && usage!.output_tokens! >= 0) {
        const state = load()
        state.output += usage!.output_tokens! - reservation
        persist(state)
      }
    }
  }
  return { wrap, executionScope: `${key}-${phase}`, snapshot: () => ({ ...load(), limits, file }), admission: () => {
    const state = load()
    const reason = state.requests >= limits.requests || (state.phases[phase] ?? 0) >= limits.phaseRequests ? 'HARNESS_REQUEST_BUDGET_EXHAUSTED'
      : limits.output - state.output < 512 ? 'HARNESS_OUTPUT_BUDGET_EXHAUSTED' : undefined
    return { allowed: !reason, reason }
  }, recordRuntime: (milliseconds: number) => {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new Error('HARNESS_RUNTIME_INVALID')
    const state = load(); state.runtimeMs = (state.runtimeMs ?? 0) + milliseconds; persist(state)
  }, heartbeatRuntime: () => {
    if (runtimeMode !== 'lease') return
    const state = load()
    if (!ownedLease || state.runtimeOwner !== ownedLease || state.runtimeStartedAt === undefined) throw Error('HARNESS_RUNTIME_LEASE_LOST')
    state.runtimeHeartbeatAt = Math.max(state.runtimeStartedAt, Date.now()); persist(state)
  }, startRuntime: () => {
    const state = load(), now = Date.now()
    if (runtimeMode === 'lease') {
      if (liveRuntimeLeases.has(key)) throw Error('HARNESS_RUNTIME_ALREADY_ACTIVE')
      if (state.runtimeStartedAt !== undefined) {
        let previousHostExited = false
        if (state.runtimePid && state.runtimePid !== process.pid) {
          let alive = true
          try { process.kill(state.runtimePid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false }
          if (alive) throw Error('HARNESS_RUNTIME_LEASE_ACTIVE: 旧执行宿主仍可能存活，请先关闭旧实例；不接管其进程或同时写入工程')
          previousHostExited = true
        }
        if (!previousHostExited && state.runtimeOwner && now - (state.runtimeHeartbeatAt ?? state.runtimeStartedAt) < RUNTIME_LEASE_MS) throw Error('HARNESS_RUNTIME_LEASE_ACTIVE: 等待旧执行租约过期后继续，不接管仍可能运行的任务')
        const heartbeat = state.runtimeHeartbeatAt ?? state.runtimeStartedAt
        const known = Math.max(0, heartbeat - state.runtimeStartedAt), tail = Math.min(RUNTIME_HEARTBEAT_MS, Math.max(0, now - heartbeat))
        state.runtimeMs = (state.runtimeMs ?? 0) + known + tail
        state.runtimeUncertainMs = (state.runtimeUncertainMs ?? 0) + Math.max(0, now - heartbeat - tail)
      }
      ownedLease = randomUUID(); state.runtimeOwner = ownedLease; state.runtimeHeartbeatAt = now; state.runtimePid = process.pid
    } else if (state.runtimeStartedAt !== undefined) state.runtimeMs = (state.runtimeMs ?? 0) + Math.max(0, now - state.runtimeStartedAt)
    state.runtimeStartedAt = now; persist(state)
    if (ownedLease) liveRuntimeLeases.set(key, ownedLease)
    return state.runtimeMs ?? 0
  }, finishRuntime: () => {
    try {
      const state = load()
      if (state.runtimeStartedAt === undefined) throw new Error('HARNESS_RUNTIME_NOT_STARTED')
      if (runtimeMode === 'lease' && (!ownedLease || state.runtimeOwner !== ownedLease)) throw Error('HARNESS_RUNTIME_LEASE_LOST')
      state.runtimeMs = (state.runtimeMs ?? 0) + Math.max(0, Date.now() - state.runtimeStartedAt)
      delete state.runtimeStartedAt; delete state.runtimeHeartbeatAt; delete state.runtimeOwner; delete state.runtimePid; persist(state)
    } finally { if (liveRuntimeLeases.get(key) === ownedLease) liveRuntimeLeases.delete(key); ownedLease = undefined }
  }, phaseStartedAt: () => {
    const state = load()
    if (!state.phaseStarts?.[phase]) {
      state.phaseStarts = { ...state.phaseStarts, [phase]: Date.now() }
      persist(state)
    }
    return state.phaseStarts![phase]!
  } }
}
