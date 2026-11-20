import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readJsonFile, writeJsonFile } from '../storage/json-store'
import { collectUsage } from './usage'
import type { AuditFilter, AuditFinding, AuditProgress, ExchangeRate, UsageRow, UsageSnapshot, UsageTurn } from '../shared/token-monitor'
import config from './audit-config.json'
import { auditDisposition, failureSummary, hasUnreadableFailure, needsSummary, observedFailure, readableSummary } from './web/review.js'

type Transport = (url: string, options?: RequestInit) => Promise<Response>
type AuditCache = Partial<AuditFinding> & { auditError?: string }
class AuditBatchError extends Error {}
const ollama = 'http://127.0.0.1:11434'
const cachePath = (home: string, row: UsageRow) => join(home, 'token-monitor', 'audit-v1', row.project, row.id + '.json')
const fingerprint = (row: UsageRow) => createHash('sha256').update(JSON.stringify([
  row.phase, row.status, row.evidence.text, row.evidence.source, row.evidence.failure,
  row.evidence.tools.map(tool => [tool.name, tool.target, tool.result, tool.state]),
])).digest('hex')
const outcome = (value: unknown): value is AuditFinding['outcome'] => typeof value === 'string' && Object.hasOwn(config.outcomes, value)
const category = (value: unknown): value is string => typeof value === 'string' && Object.hasOwn(config.categories, value)

function groupBy<T>(rows: T[], keyFor: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const key = keyFor(row)
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  return groups
}

function auditMessages(selected: UsageRow[], timeline: UsageTurn[], compact = false): Array<{ role: string; content: string }> {
  const subjects = new Map(timeline.map((turn, index) => [turn.id, { subject: turn.request, order: index + 1 }]))
  const turns = new Map<string, { id: number; subject: string; order: number }>()
  const requests = selected.map((row, index) => {
    const key = row.turn[2]
    const subject = subjects.get(key)
    if (subject && !turns.has(key)) turns.set(key, { id: turns.size + 1, ...subject })
    const { text, failure, tools } = row.evidence
    const excerpts = [...tools.filter(tool => tool.state === 'failed'), ...tools.filter(tool => tool.state !== 'failed')]
      .slice(0, compact ? 2 : 4).map(({ diagnostic, ...tool }, position) => ({
        ...tool, name: tool.name.slice(0, 80), result: (diagnostic || tool.result).slice(0, position === 0 ? 480 : 120),
      }))
    return {
      id: index + 1, turnId: turns.get(key)?.id, phase: row.phase, explainFailure: needsSummary(row),
      observed: {
        text: text || undefined, failure: failure || undefined,
        retries: row.retries?.length ? row.retries.slice(0, 4) : undefined,
        tools: excerpts.length ? excerpts : undefined,
      },
    }
  })
  const extraTurns = timeline.filter(turn => !turns.has(turn.id))
  const firstRequestAt = Math.min(...selected.map(row => row.at))
  const context = compact ? [] : extraTurns.length <= 6 ? extraTurns : [...new Set([
    ...extraTurns.slice(0, 2),
    ...extraTurns.filter(turn => turn.at < firstRequestAt).slice(-2),
    ...extraTurns.slice(-2),
  ])].sort((a, b) => a.at - b.at)
  const session = {
    totalTurns: timeline.length, omittedTurns: extraTurns.length - context.length,
    context: context.map(turn => ({ order: subjects.get(turn.id)?.order, subject: turn.request.slice(0, 80), reply: turn.reply.slice(0, 100) || undefined })),
  }
  const messages = [{ role: 'system', content: config.system },
    { role: 'user', content: JSON.stringify({ categories: config.categories, outcomes: config.outcomes, session, turns: [...turns.values()], requests }) }]
  return !compact && selected.length === 1 && inputBytes(messages) > config.auditInputBytes
    ? auditMessages(selected, timeline, true) : messages
}

function inputBytes(messages: ReturnType<typeof auditMessages>): number {
  return Buffer.byteLength(JSON.stringify(messages))
}


function sessionBatches(rows: UsageRow[], timeline: UsageTurn[]): UsageRow[][] {
  const byTurn = groupBy(rows, row => row.turn[2])
  const batches: UsageRow[][] = []
  const fits = (items: UsageRow[]) => items.length <= config.auditBatchSize &&
    inputBytes(auditMessages(items, timeline)) <= config.auditInputBytes
  let batch: UsageRow[] = []
  for (const group of byTurn.values()) {
    if (batch.length && !fits([...batch, ...group])) {
      batches.push(batch)
      batch = []
    }
    for (const row of group) {
      if (batch.length && !fits([...batch, row])) {
        batches.push(batch)
        batch = []
      }
      batch.push(row)
    }
  }
  if (batch.length) batches.push(batch)
  return batches
}

export function addFindings(home: string, rows: UsageRow[]): void {
  for (const row of rows) {
    delete row.auditError
    try {
      const saved = readJsonFile<AuditCache | null>(cachePath(home, row), null)
      if (!saved || saved.fingerprint !== fingerprint(row)) continue
      const { auditError, ...finding } = saved
      if (typeof auditError === 'string' && auditError) row.auditError = auditError
      if (category(finding.category) && outcome(finding.outcome) && typeof finding.model === 'string' &&
          typeof finding.purpose === 'string' && typeof finding.result === 'string') row.finding = finding as AuditFinding
    } catch { /* Incomplete or damaged audit cache is recomputed on request. */ }
  }
}

export async function installedModels(request: Transport): Promise<string[]> {
  const response = await request(ollama + '/api/tags', { signal: AbortSignal.timeout(5000), redirect: 'error' })
  if (!response.ok) throw new Error('Ollama HTTP ' + response.status)
  const data = await response.json() as { models?: { name?: string; remote_host?: string }[] }
  const names = (data.models ?? []).filter(model => !model.remote_host && model.name && !/cloud/i.test(model.name)).map(model => model.name!)
  return [...new Set([...config.preferredModels.filter(model => names.includes(model)), ...names])]
}

export class LocalAudit {
  private job: AuditProgress | null = null
  constructor(private readonly home: string, private readonly request: Transport) {}
  models() { return installedModels(this.request) }

  status(): AuditProgress | null { return this.job && { ...this.job } }

  start(filter: AuditFilter): AuditProgress {
    if (this.job?.state === 'running' || this.job?.state === 'stopping') throw new Error('本机审查正在运行')
    if (!filter || typeof filter !== 'object' || Array.isArray(filter) ||
      [filter.start, filter.end].some(value => value !== undefined && !Number.isFinite(value)) ||
      (filter.session !== undefined && (typeof filter.session !== 'string' || !filter.session.trim())) ||
      (filter.mode !== undefined && !['pending', 'all', 'retry'].includes(filter.mode))) throw new Error('无效的审查参数')
    const job: AuditProgress = { state: 'running', model: filter.model || '', processed: 0, remaining: 0 }
    this.job = job
    void this.run(filter, job)
    return { ...job }
  }

  stop(): AuditProgress | null {
    if (this.job?.state === 'running') this.job.state = 'stopping'
    return this.status()
  }

  private async run(filter: AuditFilter, job: AuditProgress): Promise<void> {
    try {
      const { rows, turns } = await collectUsage(this.home)
      addFindings(this.home, rows)
      const disposition = (row: UsageRow) => auditDisposition(row, filter.mode ?? 'pending')
      const eligible = (row: UsageRow) => disposition(row) === 'queued'
      const scoped = rows.filter(row => (!filter.project || filter.project === row.project)
        && (filter.session === undefined || filter.session === row.turn[1])
        && (filter.start === undefined || row.at >= filter.start) && (filter.end === undefined || row.at < filter.end))
      const byDisposition = groupBy(scoped, disposition)
      const pending = byDisposition.get('queued') ?? []
      if (byDisposition.has('noEvidence')) job.skippedNoEvidence = byDisposition.get('noEvidence')!.length
      if (byDisposition.has('unknown')) job.skippedUnknownErrors = byDisposition.get('unknown')!.length
      job.remaining = pending.length
      if (pending.length && job.state === 'running') {
        const models = await this.models()
        const model = filter.model || models[0]
        if (!model || !models.includes(model)) throw new Error('Ollama 未安装所选本地模型')
        job.model = model
        const sessions = groupBy(pending, row => JSON.stringify(row.turn.slice(0, 2)))
        const timelines = groupBy(turns.filter(turn => !turn.unlinked), turn => JSON.stringify([turn.project, turn.session]))
        for (const [key, requests] of sessions) {
          if (job.state !== 'running') break
          const timeline = (timelines.get(key) ?? []).sort((a, b) => a.at - b.at)
          const batches = sessionBatches(requests, timeline).map(rows => ({ rows, retry: false }))
          for (const [index, { rows: selected, retry }] of batches.entries()) {
            if (job.state !== 'running') break
            // The standalone monitor shares this cache and may have written a result.
            addFindings(this.home, selected)
            const candidates = selected.filter(eligible)
            job.remaining -= selected.length - candidates.length
            if (!candidates.length) continue
            const messages = auditMessages(candidates, timeline)
            const bytes = inputBytes(messages)
            if (candidates.length > 1 && bytes > config.auditInputBytes) {
              batches.splice(index + 1, 0, ...sessionBatches(candidates, timeline).map(rows => ({ rows, retry })))
              continue
            }
            const started = performance.now()
            const batch = {
              project: requests[0].project, session: requests[0].turn[1], title: timeline[0]?.request.slice(0, 60),
              index: index + 1, total: batches.length, requests: candidates.length,
              inputBytes: bytes, startedAt: Date.now(), retry,
            }
            job.activeBatch = batch
            let deferred = candidates
            let reason = '本地模型返回的分类或失败摘要不完整'
            try {
              deferred = await this.classify(candidates, model, messages)
            } catch (error) {
              deferred = candidates
              reason = error instanceof Error ? error.message : String(error)
              if (!(error instanceof AuditBatchError)) throw error
            } finally {
              const unresolved = deferred.length
              job.batchHistory = [...(job.batchHistory ?? []), {
                ...batch, elapsedMs: Math.round(performance.now() - started), unresolved,
                ...(unresolved ? { error: reason } : {}),
              }].slice(-config.auditHistoryLimit)
              delete job.activeBatch
            }
            job.processed += candidates.length - deferred.length
            job.remaining -= candidates.length - deferred.length
            if (!deferred.length) continue
            if (retry) {
              addFindings(this.home, deferred)
              const unresolved = deferred.filter(eligible)
              for (const row of unresolved) writeJsonFile(cachePath(this.home, row), {
                ...row.finding, fingerprint: fingerprint(row), auditError: reason,
              })
              if (unresolved.length) {
                job.unknownErrors = (job.unknownErrors ?? 0) + unresolved.length
                job.lastAuditError = reason
              }
              job.remaining -= deferred.length
            } else {
              const middle = Math.ceil(deferred.length / 2)
              for (const group of [deferred.slice(0, middle), deferred.slice(middle)]) {
                batches.push(...sessionBatches(group, timeline).map(rows => ({ rows, retry: true })))
              }
            }
          }
        }
      }
      job.state = job.remaining ? 'stopped' : 'completed'
    } catch (error) {
      job.state = 'error'
      job.error = error instanceof Error ? error.message : String(error)
    }
  }

  private async classify(selected: UsageRow[], model: string, messages: ReturnType<typeof auditMessages>): Promise<UsageRow[]> {
    const signal = AbortSignal.timeout(180_000)
    const options = {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, think: false, format: 'json',
        options: { temperature: 0, num_ctx: 8192, num_predict: 2200 },
        messages }),
    } satisfies RequestInit
    const response = await this.request(ollama + '/api/chat', options).catch((error: unknown) => {
      if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) throw new AuditBatchError('Ollama 响应超时')
      const cause = error instanceof Error ? error.cause as NodeJS.ErrnoException | undefined : undefined
      if (cause?.code === 'ECONNREFUSED' || (error as NodeJS.ErrnoException | undefined)?.code === 'ECONNREFUSED') {
        throw new Error('无法连接 Ollama，请确认本机服务正在运行')
      }
      throw new AuditBatchError('Ollama 请求连接中断')
    })
    if (!response.ok) {
      const message = 'Ollama HTTP ' + response.status
      if ([401, 403, 404].includes(response.status)) throw new Error(message)
      throw new AuditBatchError(message)
    }
    let items: Record<string, unknown>[]
    try {
      const responseData = await response.json() as { message?: { content?: string } } | null
      const parsed: { items?: unknown } | null = JSON.parse(responseData?.message?.content ?? '{}')
      items = Array.isArray(parsed?.items) ? parsed.items : []
    } catch {
      throw new AuditBatchError(signal.aborted ? 'Ollama 响应超时' : 'Ollama 返回的 JSON 无法解析')
    }
    const byId = new Map(items.filter(item => item && typeof item === 'object' && (typeof item.id === 'number' || typeof item.id === 'string'))
      .map(item => [Number(item.id), item]))
    const deferred: UsageRow[] = []
    for (const [index, row] of selected.entries()) {
      const item = byId.get(index + 1)
      if (!item) { deferred.push(row); continue }
      const trim = (value: unknown) => typeof value === 'string' ? value.slice(0, 180) : ''
      addFindings(this.home, [row])
      const missingSummary = needsSummary(row)
      const summary = failureSummary(row) || (hasUnreadableFailure(row) ? observedFailure(row) : readableSummary(item.failureSummary))
      if (missingSummary && !summary) { deferred.push(row); continue }
      const finding = row.finding ?? (category(item.category) && outcome(item.outcome) ? {
        category: item.category, outcome: item.outcome, purpose: trim(item.purpose), result: trim(item.result), model, fingerprint: fingerprint(row),
      } : undefined)
      if (!finding) { deferred.push(row); continue }
      if (!row.finding || missingSummary) writeJsonFile(cachePath(this.home, row), {
        ...finding, ...(missingSummary && summary ? { failureSummary: summary, summaryModel: model } : {}),
      })
    }
    return deferred
  }
}

export class Exchange {
  private current: ExchangeRate = config.fx
  private pending?: Promise<void>
  private readonly file: string
  constructor(home: string, private readonly request: Transport) {
    this.file = join(home, 'token-monitor', 'fx.json')
    try {
      const value = readJsonFile<ExchangeRate | null>(this.file, null)
      if (value && value.rate > 0 && Number.isFinite(value.rate) && /^\d{4}-\d{2}-\d{2}$/.test(value.date)) this.current = value
    } catch { /* Use the bundled reference rate. */ }
  }
  snapshot(): UsageSnapshot['fx'] { return this.current }
  refresh() { return this.pending ??= this.update().finally(() => { this.pending = undefined }) }
  private async update() {
    try {
      const response = await this.request(config.fxUrl, { signal: AbortSignal.timeout(6500) })
      if (!response.ok) return
      const data = await response.json() as { date?: string; rates?: { CNY?: number } }
      const rate = data.rates?.CNY
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || !data.date || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) return
      this.current = { rate, date: data.date }
      writeJsonFile(this.file, this.current)
    } catch { /* Keep the last reference rate offline. */ }
  }
}
