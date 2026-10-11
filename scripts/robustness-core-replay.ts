import { writeFileSync } from 'node:fs'
import { runCoreVerification } from '../main/desktop/core-verification'

const [home, projectId, root, output] = process.argv.slice(2)
if (!home || !projectId || !root || !output) throw new Error('Explicit test home/project/root/output required')
process.env.PROMA_HOME = home
const report = await runCoreVerification({ projectId, sandboxRoot: root })
writeFileSync(output, JSON.stringify(report, null, 2))
console.log(JSON.stringify({ status: report.status, missing: report.missing, evidence_rows: report.evidence.length }))
process.exitCode = report.status === 'passed' ? 0 : 1
