import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { USAGE_PHASES, type AuditEvidence, type Counts, type MonitorPhase, type ToolAttempt, type UsageRow, type UsageSnapshot, type UsageTurn } from '../shared/token-monitor'

const roles = new Map<string, MonitorPhase>(Object.entries({
  brief: 'requirements', ux_sketch: 'interface', ux_visual_design: 'interface',
  orchestrator: 'production', implement: 'production', explore: 'production',
  research: 'production', review: 'verification', gui_acceptance_planner: 'verification',
  acceptance_designer: 'verification', delivery: 'delivery',
}))
const providers = new Map(Object.entries({
  'api.openai.com': 'OpenAI', 'api.anthropic.com': 'Anthropic', 'api.deepseek.com': 'DeepSeek',
  'generativelanguage.googleapis.com': 'Google', 'api.moonshot.cn': '月之暗面',
  'api.moonshot.ai': '月之暗面', 'api.kimi.com': '月之暗面', 'opencode.ai': 'OpenCode',
  'open.bigmodel.cn': '智谱 AI', 'api.minimaxi.com': 'MiniMax', 'api.minimax.io': 'MiniMax',
  'ark.cn-beijing.volces.com': '火山方舟', 'api.xiaomimimo.com': '小米 MiMo',
  'token-plan-cn.xiaomimimo.com': '小米 MiMo', 'dashscope.aliyuncs.com': '阿里云百炼',
  'dashscope-intl.aliyuncs.com': '阿里云百炼', 'token-plan.cn-beijing.maas.aliyuncs.com': '阿里云百炼',
  'openrouter.ai': 'OpenRouter',
}))
type Data = Record<string, unknown>
type Issues = UsageSnapshot['issues']
type TurnKey = UsageRow['turn']
interface Query {
  project: string
  id: string
  start?: Data
  end?: Data
  failed: Map<number, string>
  http: Map<number, number>
}

const object = (value: unknown): value is Data => typeof value === 'object' && value !== null && !Array.isArray(value)
const string = (value: unknown) => typeof value === 'string' ? value : ''
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)
const key = (...parts: string[]) => JSON.stringify(parts)
function date(value: unknown): number | undefined {
  const result = typeof value === 'number' ? value : Date.parse(string(value))
  return Number.isFinite(result) && Math.abs(result) <= 8.64e15 ? result : undefined
}

async function index(path: string, field: string, issues: Issues): Promise<Data[]> {
  try {
    const data = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))?.[field]
    return Array.isArray(data) ? data.filter(object) : []
  } catch (error) {
    if (error instanceof SyntaxError) issues.malformed++
    else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues.unreadable++
    return []
  }
}

async function scan(path: string, issues: Issues, accept: (row: Data) => void): Promise<void> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues.unreadable++
    return
  }
  // An append in progress may leave the final line incomplete.
  const lines = raw.split('\n')
  lines.pop()
  for (const line of lines) {
    if (!line.trim()) continue
    let value: unknown
    try { value = JSON.parse(line.replace(/^\uFEFF/, '')) }
    catch { issues.malformed++; continue }
    if (object(value)) accept(value)
    else issues.malformed++
  }
}

function extract(content: unknown, limit: number): string {
  const raw = Array.isArray(content) ? content.filter(object).filter(item => item.type === 'text').map(item => string(item.text)).join(' ') : string(content)
  const text = raw.replace(/\s+/g, ' ').trim()
  return text.length <= limit ? text : text.slice(0, limit).trimEnd() + '…'
}

function failedOutput(content: unknown): string {
  const raw = Array.isArray(content) ? content.filter(object).filter(item => item.type === 'text').map(item => string(item.text)).join('\n') : string(content)
  const lines = raw.split(/\r?\n|\\r\\n|\\n/)
  const errors = lines.filter(line => !line.includes('�') && /\[err\]|\berror:|requires |exit_code|exitCode=/i.test(line) && !line.includes('<launching>'))
  return errors.length && raw.length > 560 ? extract([...errors.slice(-4), raw.slice(0, 160)].join(' '), 560) : extract(raw, 560)
}

interface Reply { at: number; text: string; tools: Data[]; used?: boolean }
interface Transcript { turns: UsageTurn[]; replies: Reply[]; results: Map<string, Data> }
async function readTurns(home: string, project: string, session: string, issues: Issues): Promise<Transcript> {
  const turns: UsageTurn[] = []
  const replies: Reply[] = []
  const results = new Map<string, Data>()
  await scan(join(home, 'agent-sessions', session + '.jsonl'), issues, message => {
    const at = date(message.timestamp)
    if (at === undefined) return
    const blocks = Array.isArray(message.content) ? message.content.filter(object) : []
    for (const block of blocks) if (block.type === 'tool_result' && safeId(block.tool_use_id)) results.set(block.tool_use_id, block)
    if (message.role === 'user' && message.origin !== 'system' && message.origin !== 'agent') {
      const id = message.client_message_id || message.id
      if (!safeId(id)) return
      turns.push({ project, session, id, at, request: extract(message.content, 150) || '附件或空文本消息', reply: '' })
    } else if (message.role === 'assistant' && message.origin !== 'system') {
      const turn = turns.at(-1)
      const reply = extract(message.content, 220)
      if (turn && reply) turn.reply = reply
      replies.push({ at, text: reply, tools: blocks.filter(block => block.type === 'tool_use') })
    }
  })
  return { turns: turns.sort((a, b) => a.at - b.at), replies: replies.sort((a, b) => a.at - b.at), results }
}

function evidence(query: Query, transcript?: Transcript): AuditEvidence {
  const finish = date(query.end?.at)
  const ids = Array.isArray(query.end?.audit_tool_ids) ? query.end.audit_tool_ids.filter(safeId) : []
  let reply = ids.length ? transcript?.replies.find(item => !item.used && item.tools.some(tool => ids.includes(string(tool.id)))) : undefined
  let source: AuditEvidence['source'] = reply ? 'id' : 'none'
  if (!reply && !ids.length && finish !== undefined && query.end?.status === 'completed' && ['loop', 'handoff'].includes(string(query.end?.scope))) {
    // Old ledgers lack tool IDs. Require a unique nearby persisted assistant reply.
    const earliest = Math.max(date(query.start?.at) ?? finish - 120, finish - 120)
    const candidates = transcript?.replies.filter(item => !item.used && item.at >= earliest && item.at <= finish + 120) ?? []
    if (candidates.length === 1) { reply = candidates[0]; source = 'time' }
  }
  if (reply) reply.used = true
  const calls: Data[] = (reply?.tools ?? ids.map(id => ({ id }))).filter(tool => !ids.length || ids.includes(string(tool.id)))
  const tools = calls.slice(0, 16).map((tool): ToolAttempt => {
    const args = object(tool.input) ? tool.input : {}
    const result = transcript?.results.get(string(tool.id))
    const summary = extract(result?.content, 180)
    const command = Array.isArray(args.command) ? args.command.filter(part => typeof part === 'string').join(' ') : args.command
    const target = extract(args.path ?? args.file_path ?? args.file ?? args.topic ?? command ?? args.pattern ?? args.goal, 180)
    return { name: string(tool.name) || '工具调用', target, result: summary,
      ...(result?.is_error === true ? { diagnostic: failedOutput(result.content) } : {}),
      state: !result || summary.includes('执行结果未知') ? 'unknown' : result.is_error === true ? 'failed' : 'ok' }
  })
  const stop = string(query.end?.stop_reason)
  const http = [...query.http.values()].filter(status => status >= 400).at(-1)
  const failure = ['max_tokens', 'length'].includes(stop) ? '触及输出上限，响应被截断' :
    query.end?.status === 'cancelled' ? '请求已取消' : ['error', 'failed'].includes(string(query.end?.status)) ?
      (http ? 'HTTP ' + http : '请求异常结束，日志未记录具体原因') : ''
  return { text: reply?.text ?? '', tools, source, failure }
}

function precedingTurn(turns: UsageTurn[], at: number): UsageTurn | undefined {
  let low = 0
  let high = turns.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (turns[mid].at <= at) low = mid + 1
    else high = mid
  }
  const candidate = turns[low - 1]
  return candidate && at - candidate.at <= 120_000 ? candidate : undefined
}

function provider(host: string, channel: string): string {
  const name = host.toLowerCase().match(/^\[[^\]]+\]|^[^:]+/)?.[0] ?? ''
  return providers.get(name) ?? (['localhost', '127.0.0.1', '[::1]'].includes(name) ? '本地服务' :
    host ? '自定义端点 · ' + host : channel || '未知供应商')
}

function tokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export async function collectUsage(home: string): Promise<Omit<UsageSnapshot, 'pricing' | 'fx'>> {
  const issues = { malformed: 0, unreadable: 0 }
  const [projectIndex, sessionIndex, files] = await Promise.all([
    index(join(home, 'projects.json'), 'projects', issues),
    index(join(home, 'bloma-agent-sessions.json'), 'sessions', issues),
    readdir(join(home, 'usage-ledger'), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') issues.unreadable++
      return []
    }),
  ])
  const projects = new Map<string, string>()
  const sessions = new Map<string, string>()
  for (const row of projectIndex) if (safeId(row.project_id)) projects.set(row.project_id, string(row.name) || row.project_id)
  for (const row of sessionIndex) {
    if (safeId(row.session_id) && safeId(row.project_id) && !row.parent_session_id) sessions.set(row.session_id, row.project_id)
  }
  const queries = new Map<string, Query>()
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
    await scan(join(home, 'usage-ledger', file.name), issues, record => {
      const { event, project_id: project, query_id: id, session_id: session } = record
      if (event !== 'query_started' && event !== 'query_finished' && event !== 'transport_finished' && event !== 'transport_response') return
      if (record.version !== 1 || !safeId(project) || !safeId(id) || !safeId(session)) { issues.malformed++; return }
      if (!projects.has(project)) projects.set(project, project === 'unassigned' ? '未分配项目' : project)
      if (!sessions.has(session)) sessions.set(session, project)
      const idKey = key(project, id)
      const query = queries.get(idKey) ?? { project, id, failed: new Map<number, string>(), http: new Map<number, number>() }
      if (event === 'query_started') query.start = record
      if (event === 'query_finished') query.end = record
      if (event === 'transport_finished' && typeof record.transport_index === 'number' && record.status !== 'completed') {
        query.failed.set(record.transport_index, string(record.status))
      }
      if (event === 'transport_response' && typeof record.transport_index === 'number' && object(record.response) && typeof record.response.status === 'number') query.http.set(record.transport_index, record.response.status)
      queries.set(idKey, query)
    })
  }

  const transcripts = new Map<string, Transcript>()
  const turnIndex = new Map<string, UsageTurn>()
  for (const [session, project] of sessions) {
    const transcript = await readTurns(home, project, session, issues)
    transcripts.set(key(project, session), transcript)
    const turns = transcript.turns
    for (const turn of turns) turnIndex.set(key(project, session, turn.id), turn)
    if (turns.length && !projects.has(project)) projects.set(project, project)
  }

  const rows: UsageRow[] = []
  const runLinks = new Map<string, { turn: TurnKey; inferred: boolean }>()
  const queryAt = (query: Query) => date(query.start?.at ?? query.end?.at)
  const sorted = [...queries.values()].sort((a, b) => (queryAt(a) ?? 0) - (queryAt(b) ?? 0))
  for (const query of sorted) {
    const at = queryAt(query)
    if (at === undefined) { issues.malformed++; continue }
    const { project, id } = query
    const record = { ...query.start, ...query.end }
    const session = string(record.parent_session_id) || string(record.session_id)
    const turnId = string(record.turn_id) || string(record.run_id)
    const runKey = key(project, session, turnId)
    let link = runLinks.get(runKey)
    if (!link) {
      const explicit = turnIndex.get(runKey)
      const nearby = explicit ? undefined : precedingTurn(transcripts.get(key(project, session))?.turns ?? [], at)
      const match = explicit ?? nearby
      const idForTurn = match?.id ?? 'run-' + (turnId || id)
      link = { turn: [project, session, idForTurn], inferred: Boolean(nearby) }
      if (!match) turnIndex.set(key(...link.turn), {
        project, session, id: idForTurn, at, request: '该请求未关联到会话消息', reply: '', unlinked: true,
      })
      if (turnId) runLinks.set(runKey, link)
    }
    const phase = string(record.phase)
    const explicitPhase = Object.hasOwn(USAGE_PHASES, phase) ? phase as MonitorPhase : undefined
    const category = explicitPhase ?? roles.get(string(record.role)) ?? 'unknown'
    const usage = query.end?.usage
    const fields = object(usage) ? usage : {}
    const counts: Counts = {
      uncached: tokens(fields.input_tokens), read: tokens(fields.cache_read_input_tokens),
      write: tokens(fields.cache_creation_input_tokens), output: tokens(fields.output_tokens),
    }
    const host = string(record.endpoint_host)
    const channel = string(record.provider_type)
    const retries = [...query.failed].map(([index, status]) => ({ index, status, http: query.http.get(index) }))
    rows.push({
      id, project, ...link, at, phase: category, phase_inferred: !explicitPhase && category !== 'unknown',
      provider: provider(host, channel), channel, host, model: string(record.model) || '未知模型', counts,
      status: query.end ? string(query.end.status) || 'unknown' : 'running',
      missing: counts.uncached === null || counts.output === null, failed: retries.length, retries,
      evidence: evidence(query, transcripts.get(key(project, string(record.session_id)))),
    })
  }
  return { projects: Object.fromEntries(projects), rows, turns: [...turnIndex.values()], issues, phases: USAGE_PHASES }
}
