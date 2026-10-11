// Read-only audit of the six authorized Bloma sessions and their actual request ledgers.
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
const artifacts = resolve('run-artifacts')
const definitions = [
  ['ledger-quick', 'blr-0bce5650', '89705501-5191-4af8-b5fc-007fc4a8e282', 'pilot_stopped_unverified'],
  ['ledger-longterm', 'blr-be38ad3e', 'fc008005-944c-4a2e-839c-4575224351df', 'timeout'],
  ['files-quick', 'blr-7fe4d989', 'c0944f7c-668d-4f22-8d33-a3908b37659c', 'generation_stopped_unverified'],
  ['files-longterm', 'blr-820dfcc5', '7d321bf9-805c-48d8-9d34-2b8ed2f1a4ac', 'user_interrupted'],
  ['voice-quick', 'blr-fe7b76d0', 'f85b449e-ca53-43b0-9d80-a1e35dcc7bc8', 'generation_stopped_unverified'],
  ['voice-longterm', 'blr-254b2789', 'b9eaf63a-8ccf-45dd-988f-d07d5e33e415', 'user_interrupted_no_runnable_artifact'],
]
const optional = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
const cases = definitions.map(([id, homeName, projectId, generationOutcome]) => {
  const home = join(tmpdir(), homeName)
  const metadata = optional(join(home, 'bloma-agent-sessions.json'))?.sessions ?? []
  const source = optional(join(home, 'projects.json'))?.projects.find(p => p.project_id === projectId)
  const usage = optional(join(artifacts, `robustness-${id}-usage.json`))
  const independent = optional(join(artifacts, `robustness-${id}-independent.json`))
  const inventory = []
  let malformedLines = 0
  for (const name of readdirSync(join(home, 'agent-sessions')).filter(n => n.endsWith('.jsonl'))) {
    const path = join(home, 'agent-sessions', name)
    const bytes = readFileSync(path)
    const tools = {}, settles = [], controls = []
    let rows = 0
    for (const line of bytes.toString('utf8').split(/\r?\n/).filter(Boolean)) {
      try {
        const row = JSON.parse(line); rows++
        if (row.delegation_settle) settles.push(row.delegation_settle)
        for (const block of Array.isArray(row.content) ? row.content : []) {
          if (block.type === 'tool_use') tools[block.name] = (tools[block.name] ?? 0) + 1
          if (block.type === 'text' && typeof block.text === 'string' && /^\[terminal\]/.test(block.text)) controls.push(block.text)
        }
      } catch { malformedLines++ }
    }
    const session = metadata.find(s => s.session_id === name.replace(/\.jsonl$/, ''))
    inventory.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), rows,
      session_id: session?.session_id ?? name.replace(/\.jsonl$/, ''), recorded_status: session?.status,
      parent_session_id: session?.parent_session_id, delegation_id: session?.source_delegation_id,
      tools, settles, terminal_markers: controls })
  }
  const ledgerModels = {}
  const ledger = join(home, 'usage-ledger', `${projectId}.jsonl`)
  for (const line of readFileSync(ledger, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const event = JSON.parse(line)
    if (event.event === 'query_started') ledgerModels[event.model ?? 'unknown'] = (ledgerModels[event.model ?? 'unknown'] ?? 0) + 1
  }
  return { id, home, project_id: projectId, root: source?.root_path, generation_outcome: generationOutcome,
    final_phase: source?.desktop_phase, stored_project_status: source?.status,
    runnable_artifact: source?.root_path ? existsSync(join(source.root_path, 'app.py')) : false,
    independent: independent ? { status: independent.status, passed: independent.replays.filter(r => r.status === 'passed').length,
      attempted: independent.replays.length } : { status: 'not_run', passed: 0, attempted: 0 },
    usage, models_requested: ledgerModels, log_inventory: inventory, malformed_session_lines: malformedLines,
    unique_child_session_files: inventory.filter(s => s.parent_session_id).length }
})
const totals = { logical_queries: 0, physical_requests: 0, reported_input: 0, reported_output: 0, reported_total: 0,
  cache_read: 0, cache_creation: 0, missing_usage_queries: 0, active_queries: 0 }
for (const item of cases) for (const key of Object.keys(totals)) totals[key] += item.usage?.[key] ?? 0
const report = { observed_at: new Date().toISOString(), cases, totals,
  uncached_reported_input: totals.reported_input - totals.cache_read - totals.cache_creation,
  all_usage_complete: cases.every(c => c.usage?.complete),
  original_runnable_artifacts: cases.filter(c => c.runnable_artifact).length,
  automatic_deliveries: cases.filter(c => c.stored_project_status === 'completed').length,
  scope: 'Six actual generation attempts; user-interrupted cases are incomplete. Known reported tokens are not an invoice. Session file inventory includes children and resumed delegation tools.' }
writeFileSync(join(artifacts, 'robustness-six-case-audit.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ totals, uncached_reported_input: report.uncached_reported_input,
  runnable: report.original_runnable_artifacts, deliveries: report.automatic_deliveries,
  session_files: cases.reduce((n, c) => n + c.log_inventory.length, 0),
  child_files: cases.reduce((n, c) => n + c.unique_child_session_files, 0),
  cases: cases.map(c => ({ id: c.id, outcome: c.generation_outcome, independent: c.independent })) }))
