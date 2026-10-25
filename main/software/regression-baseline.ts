import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { readPrdBackplane } from '../project/prd-store'
import { requirementEvidenceHash } from '../project/requirement-contract'
import { guiSuitePath, type GuiAcceptanceSuite } from '../desktop/gui-acceptance'
import { cliSuitePath } from '../desktop/lean-cli-check'

interface CliSuite { cases: Array<{ name: string; covers: string[]; args: string[]; stdout: string; exit_code: number }> }
interface Baseline { version: string; requirements: Record<string, string>; gui?: GuiAcceptanceSuite; cli?: CliSuite }
const pathFor = (id: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw Error('REGRESSION_PROJECT_INVALID')
  return join(getPromaHome(), 'software-regressions', `${id}.json`)
}
function requirements(projectId: string) {
  const brief = readPrdBackplane(projectId)
  return Object.fromEntries(brief.requirements.map(row => [row.id, requirementEvidenceHash(brief, row)]))
}
/** Called only after the host has actually checked the candidate. */
export function saveSoftwareRegressionBaseline(projectId: string, version: string) {
  const read = (file: string) => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
  writeTextFileAtomic(pathFor(projectId), JSON.stringify({ version, requirements: requirements(projectId), gui: read(guiSuitePath(projectId)), cli: read(cliSuitePath(projectId)) } satisfies Baseline))
}
export function assertRetainedSoftwareBehavior(projectId: string, kind: 'gui' | 'cli', suite: GuiAcceptanceSuite | CliSuite) {
  if (!existsSync(pathFor(projectId))) return
  const baseline = JSON.parse(readFileSync(pathFor(projectId), 'utf8')) as Baseline, current = requirements(projectId)
  const retained = new Set(Object.keys(baseline.requirements).filter(id => current[id] === baseline.requirements[id]))
  if (!retained.size) return
  if (kind === 'gui' && baseline.gui) {
    const before = baseline.gui, after = suite as GuiAcceptanceSuite
    // CSS identities can change with a legitimate redesign; the old observed
    // outputs and their retained feature references cannot silently disappear.
    const signature = (step: GuiAcceptanceSuite['steps'][number]) => {
      const { id: _id, selector: _selector, has_text: _text, timeout_ms: _timeout, ...behavior } = step as unknown as Record<string, unknown>
      if (behavior.kind === 'expect' && !behavior.property) behavior.property = 'text'
      return JSON.stringify(Object.fromEntries(Object.entries(behavior).sort(([a], [b]) => a.localeCompare(b))))
    }
    for (const step of before.steps) {
      if (!['expect', 'expect_file'].includes(step.kind)) continue
      const covers = before.acceptance_refs?.[step.id]?.filter(id => retained.has(id)) ?? []
      if (covers.length && !after.steps.some(candidate => signature(candidate) === signature(step)
        && covers.every(id => after.acceptance_refs?.[candidate.id]?.includes(id)))) throw Error(`GUI_RETAINED_BEHAVIOR_MISSING: ${step.id} (${covers.join(',')})；保留旧行为断言，可更新selector；用户确认改变的业务预期不受旧断言约束`)
    }
    if (before.covers.every(id => retained.has(id))) {
      let cursor = 0
      for (const step of before.steps) {
        const index = after.steps.findIndex((candidate, i) => i >= cursor && signature(candidate) === signature(step))
        if (index < 0) throw Error(`GUI_RETAINED_INPUT_MISSING: ${step.id}；保留原输入与操作顺序，可追加新的检查`)
        cursor = index + 1
      }
      for (const file of before.fixtures ?? []) if (!(after.fixtures ?? []).some(next => next.path === file.path && next.sha256 === file.sha256 && next.text === file.text)) throw Error(`GUI_RETAINED_FIXTURE_CHANGED: ${file.path}`)
    }
  }
  if (kind === 'cli' && baseline.cli) {
    for (const before of baseline.cli.cases) {
      const covers = before.covers.filter(id => retained.has(id))
      if (covers.length && !(suite as CliSuite).cases.some(after => JSON.stringify(after.args) === JSON.stringify(before.args)
        && after.stdout === before.stdout && after.exit_code === before.exit_code && covers.every(id => after.covers.includes(id)))) throw Error(`CLI_RETAINED_BEHAVIOR_MISSING: ${before.name}`)
    }
  }
}
