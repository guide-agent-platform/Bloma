import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { findProject } from '../main/project/project-service'
import { readPrdBackplane } from '../main/project/prd-store'
import { prdScopeFingerprint } from '../main/project/requirement-contract'
import { installGuiAcceptanceSuite, runGuiAcceptance } from '../main/desktop/gui-acceptance'

const [operation, projectId, suiteFile] = process.argv.slice(2)
if (!projectId || !['scope', 'install', 'run'].includes(operation)) throw new Error('Usage: node scripts/gui-acceptance.mjs scope|install|run PROJECT_ID [SUITE_JSON]')
const project = findProject(projectId), backplane = readPrdBackplane(projectId), scope = prdScopeFingerprint(backplane)
if (operation === 'scope') {
  process.stdout.write(JSON.stringify({ project_id: projectId, scope_hash: scope, features: backplane.requirements.map(item => ({ id: item.id, description: item.description })) }, null, 2) + '\n')
} else if (operation === 'install') {
  if (!suiteFile) throw new Error('GUI_SUITE_FILE_REQUIRED')
  const suite = JSON.parse(readFileSync(suiteFile, 'utf8'))
  if (suite.scope_hash !== scope) throw new Error(`GUI_SCOPE_STALE: current scope_hash=${scope}`)
  if (!Array.isArray(suite.covers) || suite.covers.some((id: string) => !backplane.requirements.some(item => item.id === id))) throw new Error('GUI_COVERAGE_UNKNOWN_REQUIREMENT')
  installGuiAcceptanceSuite(projectId, suite)
  process.stdout.write(JSON.stringify({ installed: true, project_id: projectId, scope_hash: scope }) + '\n')
} else {
  const result = await runGuiAcceptance({ projectId, root: project.root_path, scopeHash: scope, signal: AbortSignal.timeout(600000), probePath: resolve('main/templates/tools/gui_acceptance_probe.py') })
  process.stdout.write(JSON.stringify(result ?? { status: 'unverified', error: 'GUI_SUITE_NOT_INSTALLED' }, null, 2) + '\n')
  if (result?.status !== 'passed') process.exitCode = 1
}
