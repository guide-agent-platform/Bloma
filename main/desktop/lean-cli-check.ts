import { existsSync, readFileSync, realpathSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint, trustedAcceptance } from '../project/requirement-contract'
import { readLaunchDeclaration } from './launch-smoke'
import { buildDriverEnv, execFileDriverSpawn, resolveDriverVenvCommand } from './process-driver'
import { isSoftwareProject } from './workflow-policy'
import { executeSoftwareCommand } from '../software/command-runtime'
import { assertRetainedSoftwareBehavior } from '../software/regression-baseline'

interface CliCase { name: string; covers: string[]; args: string[]; stdout: string; exit_code: number }
interface CliSuite { version: 1; scope_hash: string; cases: CliCase[]; expectations: Record<string, string> }
export interface LeanCliResult { status: 'passed' | 'failed' | 'unverified'; error?: string; cases: Array<{ name: string; covers: string[]; passed: boolean; actual: string; exit_code: number | null }> }
export const cliSuitePath = (id: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('CLI_PROJECT_INVALID')
  return join(getPromaHome(), 'cli-acceptance', `${id}.json`)
}
function parseSuite(value: unknown): CliSuite {
  const suite = value as CliSuite
  if (!suite || suite.version !== 1 || !/^[a-f0-9]{64}$/.test(suite.scope_hash) || !suite.expectations || !Array.isArray(suite.cases)
    || !suite.cases.length || suite.cases.length > 32 || new Set(suite.cases.map(c => c?.name)).size !== suite.cases.length
    || suite.cases.some(c => !c || typeof c.name !== 'string' || !c.name || !Array.isArray(c.covers) || !c.covers.length || c.covers.some(id => typeof id !== 'string')
      || !Array.isArray(c.args) || c.args.length > 16 || c.args.some(arg => typeof arg !== 'string' || arg.length > 2048)
      || typeof c.stdout !== 'string' || !c.stdout.trim() || c.stdout.length > 8192 || !Number.isInteger(c.exit_code) || c.exit_code < 0 || c.exit_code > 255)) throw new Error('CLI_CHECK_INVALID')
  return suite
}
function checkScope(suite: CliSuite, projectId: string): void {
  const brief = readPrdBackplane(projectId)
  if (!brief.user_confirmed_at || brief.lean_brief?.ui !== 'none' || suite.scope_hash !== prdScopeFingerprint(brief)
    || Object.keys(suite.expectations).some(id => !brief.requirements.some(row => row.id === id))
    || brief.requirements.some(row => suite.expectations[row.id] !== trustedAcceptance(brief, row) || !suite.cases.some(c => c.covers.includes(row.id)))
    || suite.cases.some(c => c.covers.some(id => !brief.requirements.some(row => row.id === id)))) throw new Error('CLI_CHECK_SCOPE_CHANGED')
}
export function buildLeanCliTool(projectId: string): AgentLoopTool {
  return { name: 'register_cli_check', description: '登记无界面程序的真实入口检查。expectations逐项复制任务单expected；cases给名称、covers功能编号、传入正常入口的args、固定stdout与exit_code。宿主直接运行LAUNCH入口，不采信脚本自报PASS；同目标不能改输入或预期过关。',
    input_schema: { type: 'object', required: ['expectations', 'cases'], properties: {
      expectations: { type: 'object', additionalProperties: { type: 'string' } }, cases: { type: 'array', items: { type: 'object', additionalProperties: true } },
    } }, execute: async (input, ctx) => {
      try {
        if (ctx.projectId !== projectId) throw new Error('CLI_PROJECT_MISMATCH')
        const suite = parseSuite({ ...input, version: 1, scope_hash: prdScopeFingerprint(readPrdBackplane(projectId)) })
        checkScope(suite, projectId)
        if (isSoftwareProject(projectId)) assertRetainedSoftwareBehavior(projectId, 'cli', suite)
        if (existsSync(cliSuitePath(projectId))) {
          const previous = parseSuite(JSON.parse(readFileSync(cliSuitePath(projectId), 'utf8')))
          if (previous.scope_hash === suite.scope_hash && JSON.stringify(previous.cases) !== JSON.stringify(suite.cases)) throw new Error('CLI_EXISTING_EXPECTATIONS_CHANGED')
        }
        writeTextFileAtomic(cliSuitePath(projectId), JSON.stringify(suite, null, 2))
        return { output: '已登记固定输入与输出预期，尚未运行或判定通过。' }
      } catch (error) { return { output: error instanceof Error ? error.message : String(error), isError: true } }
    } }
}
export async function runLeanCliCheck(projectId: string, root: string, signal?: AbortSignal): Promise<LeanCliResult> {
  const result: LeanCliResult = { status: 'unverified', cases: [] }
  let temporary: string | undefined
  try {
    signal?.throwIfAborted()
    const bytes = readFileSync(cliSuitePath(projectId))
    const suite = parseSuite(JSON.parse(bytes.toString('utf8'))); checkScope(suite, projectId)
    const launch = readLaunchDeclaration(root)
    if (!launch?.ok) throw new Error(launch?.error ?? 'CLI_LAUNCH_MISSING')
    const command = launch.launch.command
    const software = isSoftwareProject(projectId)
    if (!software) {
      if (!/(?:^|[\\/])python(?:3)?(?:\.exe)?$/i.test(command[0] ?? '') || !command[1]?.endsWith('.py')) throw new Error('CLI_REGISTERED_PYTHON_ENTRY_REQUIRED')
      const entry = realpathSync(resolve(root, command[1])), directory = realpathSync(root)
      if (!entry.startsWith(directory + sep)) throw new Error('CLI_ENTRY_OUTSIDE_PROJECT')
    }
    temporary = mkdtempSync(join(tmpdir(), 'bloma-cli-check-'))
    const runSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120000)])
    for (const test of suite.cases) {
      runSignal.throwIfAborted()
      const outcome = software ? await executeSoftwareCommand({ root, projectId, command: [...command, ...test.args], timeoutMs: 15000, signal: runSignal, dataDir: join(temporary, 'data') })
        : await execFileDriverSpawn({ command: resolveDriverVenvCommand([...command, ...test.args], root), cwd: root, timeoutMs: 15000,
        signal: runSignal, env: { ...buildDriverEnv({ env_whitelist: [] } as never, process.env), APP_DATA_DIR: join(temporary, 'data'), PYTHONDONTWRITEBYTECODE: '1' } })
      const passed = outcome.code === test.exit_code && outcome.stdout.trim() === test.stdout.trim()
      result.cases.push({ name: test.name, covers: test.covers, passed, actual: outcome.stdout.slice(0, 8192), exit_code: outcome.code })
    }
    checkScope(suite, projectId)
    if (!readFileSync(cliSuitePath(projectId)).equals(bytes)) throw new Error('CLI_INPUT_CHANGED')
    result.status = result.cases.every(row => row.passed) ? 'passed' : 'failed'
  } catch (error) { if (signal?.aborted) throw error; result.error = error instanceof Error ? error.message : String(error) }
  finally { if (temporary) rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) }
  return result
}
