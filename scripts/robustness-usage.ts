import { writeFileSync } from 'node:fs'
import { readProjectUsage } from '../main/platform/llm/request-ledger'

const [home, projectId, output] = process.argv.slice(2)
if (!home || !projectId || !output) throw new Error('Explicit isolated home/project/output required')
process.env.PROMA_HOME = home
const report = readProjectUsage(projectId)
writeFileSync(output, JSON.stringify(report, null, 2))
console.log(JSON.stringify({ logical_queries: report.logical_queries, physical_requests: report.physical_requests,
  reported_input: report.reported_input, reported_output: report.reported_output, reported_total: report.reported_total,
  missing_usage_queries: report.missing_usage_queries, active_queries: report.active_queries, complete: report.complete }))
