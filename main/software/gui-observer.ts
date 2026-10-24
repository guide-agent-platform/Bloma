import { existsSync, mkdirSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { BrowserContext, ElectronApplication, Page } from 'playwright'
import type { LaunchDeclaration } from '../desktop/launch-smoke'
import { splitSteps, type GuiAcceptanceSuite, type GuiAcceptanceResult } from '../desktop/gui-acceptance'
import { softwareEnvironment } from './command-runtime'
import { startSoftwareProcess, stopSoftwareSession } from './process-manager'

/** A real Electron runtime is required; a packaged Bloma.exe is not a generic
 * Electron executable and must never be recursively launched as the product. */
export function electronEntry(root: string, command: readonly string[]): { executablePath: string; args: string[] } {
  let [head, ...args] = command
  if (head === 'npm' && args.length <= 2 && (args[0] === 'start' || args[0] === 'run' && args[1] === 'start')) {
    // Keep the actual normal entry explicit; do not reinterpret arbitrary scripts.
    throw new Error('ELECTRON_DIRECT_ENTRY_REQUIRED: LAUNCH.command填写项目node_modules/electron/dist/electron.exe与实际应用路径，或已打包exe')
  }
  if (head === 'electron') head = join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
  const executablePath = isAbsolute(head) ? head : resolve(root, head)
  if (!existsSync(executablePath)) throw new Error('ELECTRON_EXECUTABLE_MISSING: 请先安装工程依赖或使用实际打包入口')
  if (!args.length && basename(executablePath).toLowerCase() === 'electron.exe') args = ['.']
  return { executablePath, args }
}

export async function observeGuiStep(page: Page, step: GuiAcceptanceSuite['steps'][number]): Promise<unknown> {
  if (!('selector' in step)) throw new Error(`GUI_ACTION_UNSUPPORTED_FOR_THIS_RUNTIME:${step.kind}`)
  const locator = page.locator(step.selector)
  if (step.kind === 'fill') { await locator.fill(step.value); return await locator.inputValue() }
  if (step.kind === 'click') { await locator.click(); return 'clicked' }
  if (step.kind !== 'expect') throw new Error('GUI_ACTION_UNSUPPORTED_FOR_THIS_RUNTIME')
  const deadline = Date.now() + (step.timeout_ms ?? 3000)
  let actual: unknown
  do {
    try {
      actual = step.property === 'count' ? String(await locator.count()) : step.property === 'value' ? await locator.inputValue({ timeout: 300 }) : await locator.innerText({ timeout: 300 })
      if (step.equals !== undefined ? String(actual) === step.equals : step.contains !== undefined ? String(actual).includes(step.contains) : String(actual).trim().length > 0) return actual
    } catch { /* a genuine async UI may not have its output yet */ }
    await new Promise(resolve => setTimeout(resolve, 75))
  } while (Date.now() < deadline)
  throw Object.assign(new Error(`GUI_ASSERTION_FAILED:${step.id}`), { actual })
}

/** DOM actions are host-owned and run against the normal application. No product
 * self-test mode, injected business assertions or self-reported PASS scripts. */
export async function observeSoftwareGui(input: { projectId: string; root: string; launch: LaunchDeclaration; suite: GuiAcceptanceSuite; temporary: string; signal?: AbortSignal; screenshotDir?: string }): Promise<Pick<GuiAcceptanceResult, 'status' | 'steps' | 'error'>> {
  const { _electron, chromium } = await import('playwright')
  const result: Pick<GuiAcceptanceResult, 'status' | 'steps' | 'error'> = { status: 'unverified', steps: [] }
  const data = join(input.temporary, 'data'), userData = join(input.temporary, 'user-data'), screenshotDir = input.screenshotDir ?? join(input.root, '00_VERIFY/screenshots')
  mkdirSync(screenshotDir, { recursive: true })
  const owner = `host-gui-${Date.now()}-${Math.random().toString(36).slice(2)}`
  for (const [index, steps] of splitSteps(input.suite).entries()) {
    let app: ElectronApplication | undefined, context: BrowserContext | undefined
    const close = async () => { try { await app?.close() } catch {} try { await context?.close() } catch {} await stopSoftwareSession(input.projectId, owner) }
    const abort = () => { void close().catch(() => undefined) }
    input.signal?.addEventListener('abort', abort, { once: true })
    try {
      input.signal?.throwIfAborted()
      let page: Page
      if (input.launch.ui === 'electron') {
        const entry = electronEntry(input.root, input.launch.command)
        app = await _electron.launch({ ...entry, args: [...entry.args, `--user-data-dir=${userData}`], cwd: input.root,
          env: softwareEnvironment(input.projectId, data), timeout: 20000 })
        input.signal?.throwIfAborted()
        page = await app.firstWindow({ timeout: 15000 })
      } else if (input.launch.ui === 'browser' && input.launch.url) {
        await startSoftwareProcess({ root: input.root, projectId: input.projectId, sessionId: owner, command: input.launch.command,
          url: input.launch.url, dataDir: data, signal: input.signal })
        const installed = existsSync(chromium.executablePath())
        context = await chromium.launchPersistentContext(userData, { headless: true, ...(installed ? { executablePath: chromium.executablePath() } : { channel: process.platform === 'win32' ? 'msedge' : 'chrome' }),
          env: softwareEnvironment(input.projectId, data), timeout: 20000 })
        input.signal?.throwIfAborted()
        page = context.pages()[0] ?? await context.newPage()
        await page.goto(input.launch.url, { waitUntil: 'domcontentloaded', timeout: 15000 })
      } else throw new Error('SOFTWARE_GUI_ADAPTER_UNSUPPORTED')
      page.setDefaultTimeout(4000)
      for (const step of steps) {
        input.signal?.throwIfAborted()
        try { const actual = await observeGuiStep(page, step); result.steps.push({ id: step.id, passed: true, actual }) }
        catch (error) {
          result.steps.push({ id: step.id, passed: false, actual: (error as { actual?: unknown }).actual ?? String(error) })
          result.error = error instanceof Error ? error.message : String(error)
          result.status = result.error.startsWith('GUI_ACTION_UNSUPPORTED') ? 'unverified' : 'failed'
          await page.screenshot({ path: join(screenshotDir, `gui-${index}-failed.png`) }).catch(() => {})
          return result
        }
      }
      await page.screenshot({ path: join(screenshotDir, `gui-${index}.png`) })
      result.status = 'passed'
    } catch (error) {
      if (input.signal?.aborted) throw error
      result.status = 'unverified'; result.error = error instanceof Error ? error.message : String(error); return result
    } finally { input.signal?.removeEventListener('abort', abort); await close() }
  }
  return result
}
