import { existsSync, mkdirSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { BrowserContext, ElectronApplication, Locator, Page } from 'playwright'
import type { LaunchDeclaration } from '../desktop/launch-smoke'
import { splitSteps, type GuiAcceptanceSuite, type GuiAcceptanceResult } from '../desktop/gui-acceptance'
import { softwareEnvironment } from './command-runtime'
import { startSoftwareProcess, stopSoftwareSession, redactSoftwareOutput } from './process-manager'
import { guiDataPath } from '../desktop/gui-fixtures'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { selectOwnedNativeFile } from './native-file-dialog'
import { closeOwnedGui } from './gui-cleanup'
import type { ChildProcess } from 'node:child_process'

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

async function selectGuiOption(locator: Locator, choice: { value?: string; label?: string }, allowLabelFallback = false): Promise<string> {
  const options = await locator.evaluate(element => element instanceof HTMLSelectElement
    ? Array.from(element.options, option => ({ value: option.value, label: option.label })) : null)
  if (!options) throw Error('GUI_SELECT_ELEMENT_REQUIRED: select需要真实select控件，不要修改产品控件来适配调试')
  let matches = options.filter(option => choice.value !== undefined ? option.value === choice.value : option.label === choice.label)
  if (!matches.length && allowLabelFallback) matches = options.filter(option => option.label === choice.value)
  if (matches.length !== 1 || options.filter(option => option.value === matches[0]?.value).length !== 1) {
    throw Object.assign(Error('GUI_SELECT_OPTION_NOT_UNIQUE: 按value或label精确选择一个已有选项'), { actual: options.slice(0, 20) })
  }
  await locator.selectOption({ value: matches[0].value })
  return locator.inputValue()
}

export async function observeGuiStep(page: Page, step: GuiAcceptanceSuite['steps'][number], context?: { data: string; fixtures?: GuiAcceptanceSuite['fixtures']; nativeProcessRoot?: number; signal?: AbortSignal }): Promise<unknown> {
  const frozenUpload = (path: string) => {
    if (!context) throw Error('GUI_ACTION_UNSUPPORTED_WITHOUT_DATA_DIRECTORY')
    const descriptor = context.fixtures?.find(file => file.path === path), file = guiDataPath(context.data, path)
    if (!descriptor || !existsSync(file)) throw Error('GUI_FIXTURE_NOT_SEALED')
    const expected = descriptor.text !== undefined ? createHash('sha256').update(descriptor.text).digest('hex') : descriptor.sha256
    if (!expected || createHash('sha256').update(readFileSync(file)).digest('hex') !== expected) throw Error('GUI_FIXTURE_FROZEN_BYTES_CHANGED')
    return file
  }
  if (step.kind === 'expect_file') {
    if (!context) throw Error('GUI_ACTION_UNSUPPORTED_WITHOUT_DATA_DIRECTORY')
    const file = guiDataPath(context.data, step.path)
    if (!existsSync(file)) throw Error(`GUI_FILE_ASSERTION_FAILED:${step.id}`)
    if (statSync(file).size > 20 * 1024 * 1024) throw Error('GUI_ACTION_UNSUPPORTED_FILE_ASSERTION_SIZE')
    const bytes = readFileSync(file), text = bytes.toString('utf8'), digest = createHash('sha256').update(bytes).digest('hex')
    if (step.sha256 !== undefined ? digest !== step.sha256 : step.equals !== undefined ? text !== step.equals : step.contains !== undefined ? !text.includes(step.contains) : bytes.length === 0) throw Object.assign(Error(`GUI_FILE_ASSERTION_FAILED:${step.id}`), { actual: { size: bytes.length, sha256: digest } })
    return { size: bytes.length, sha256: digest }
  }
  if (!('selector' in step)) throw new Error(`GUI_ACTION_UNSUPPORTED_FOR_THIS_RUNTIME:${step.kind}`)
  const locator = step.has_text === undefined ? page.locator(step.selector) : page.locator(step.selector).filter({ hasText: step.has_text })
  if (step.kind !== 'expect' || step.property !== 'count') {
    const matches = await locator.count()
    if (matches > 1) throw Object.assign(Error(`GUI_LOCATOR_AMBIGUOUS:${step.id}: 匹配${matches}个控件，请用has_text或更具体的selector定位；数量检查使用property=count`), {
      actual: { matched: matches, candidates: await locator.evaluateAll(elements => elements.slice(0, 4).map(element => ({
        id: element.id || undefined, text: (element.textContent ?? '').trim().slice(0, 180),
      }))) }, selector: step.selector, has_text: step.has_text,
    })
  }
  if (step.kind === 'select') return selectGuiOption(locator, step)
  if (step.kind === 'fill') {
    // Durable older transcripts used fill for selects. Preserve their intended
    // value/visible-label choice instead of forcing the model to redesign a UI.
    if (await locator.evaluate(element => element instanceof HTMLSelectElement)) return selectGuiOption(locator, { value: step.value }, true)
    await locator.fill(step.value); return await locator.inputValue()
  }
  if (step.kind === 'click') { await locator.click(); return 'clicked' }
  if (step.kind === 'press') { await locator.press(step.key); return 'key pressed' }
  if (step.kind === 'scroll') { await locator.scrollIntoViewIfNeeded(); return 'scrolled into view' }
  if (step.kind === 'drag') { await locator.dragTo(page.locator(step.target_selector)); return 'dragged' }
  if (step.kind === 'native_upload') {
    if (!context?.nativeProcessRoot) throw Error('GUI_ACTION_UNSUPPORTED_NATIVE_DIALOG_ENVIRONMENT')
    const file = frozenUpload(step.path)
    await locator.click()
    try { await selectOwnedNativeFile(context.nativeProcessRoot, file, context.signal) }
    catch (error) {
      const rendererErrors = (await page.pageErrors()).slice(-3).map(row => redactSoftwareOutput(row.stack || row.message || String(row)).slice(0, 1000))
      throw Object.assign(error as Error, { actual: { error: String(error), renderer_errors: rendererErrors } })
    }
    frozenUpload(step.path); return { selected: step.path }
  }
  if (step.kind === 'upload') {
    if (!context) throw Error('GUI_ACTION_UNSUPPORTED_WITHOUT_DATA_DIRECTORY')
    const file = frozenUpload(step.path)
    if (await locator.evaluate(element => element instanceof HTMLInputElement && element.type === 'file')) await locator.setInputFiles(file)
    else { const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), locator.click()]); await chooser.setFiles(file) }
    frozenUpload(step.path); return { uploaded: step.path, size: statSync(file).size, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }
  }
  if (step.kind === 'download') {
    if (!context) throw Error('GUI_ACTION_UNSUPPORTED_WITHOUT_DATA_DIRECTORY')
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), locator.click()])
    const target = guiDataPath(context.data, step.path); mkdirSync(dirname(target), { recursive: true }); await download.saveAs(target)
    const failure = await download.failure(); if (failure) throw Error(`GUI_DOWNLOAD_FAILED: ${failure}`)
    return { downloaded: step.path, size: statSync(target).size }
  }
  if (step.kind !== 'expect') throw new Error('GUI_ACTION_UNSUPPORTED_FOR_THIS_RUNTIME')
  const deadline = Date.now() + (step.timeout_ms ?? 3000)
  let actual: unknown
  do {
    try {
      actual = step.property === 'count' ? String(await locator.count()) : step.property === 'value' ? await locator.inputValue({ timeout: 300 }) : await locator.innerText({ timeout: 300 })
      if (step.equals !== undefined ? String(actual) === step.equals : step.contains !== undefined ? String(actual).includes(step.contains)
        : step.property === 'count' ? Number(actual) > 0 : String(actual).trim().length > 0) return actual
    } catch { /* a genuine async UI may not have its output yet */ }
    await new Promise(resolve => setTimeout(resolve, 75))
  } while (Date.now() < deadline)
  throw Object.assign(new Error(`GUI_ASSERTION_FAILED:${step.id}`), { actual, expected: step.equals ?? step.contains ?? 'nonempty', selector: step.selector, has_text: step.has_text })
}

/** DOM actions are host-owned and run against the normal application. No product
 * self-test mode, injected business assertions or self-reported PASS scripts. */
export async function observeSoftwareGui(input: { projectId: string; root: string; launch: LaunchDeclaration; suite: GuiAcceptanceSuite; temporary: string; signal?: AbortSignal; screenshotDir?: string; purpose?:'acceptance'|'development' }): Promise<Pick<GuiAcceptanceResult, 'status' | 'steps' | 'error'>> {
  const { _electron, chromium } = await import('playwright')
  const result: Pick<GuiAcceptanceResult, 'status' | 'steps' | 'error'> = { status: 'unverified', steps: [] }
  const data = join(input.temporary, 'data'), userData = join(input.temporary, 'user-data'), screenshotDir = input.screenshotDir ?? join(input.temporary, 'evidence')
  mkdirSync(screenshotDir, { recursive: true })
  const owner = `host-gui-${Date.now()}-${Math.random().toString(36).slice(2)}`
  for (const [index, steps] of splitSteps(input.suite).entries()) {
    let app: ElectronApplication | undefined, context: BrowserContext | undefined
    let child: ChildProcess | undefined
    const close = async () => { await closeOwnedGui([async () => app?.close(), async () => context?.close(), () => stopSoftwareSession(input.projectId, owner)], child); await stopSoftwareSession(input.projectId, owner) }
    const abort = () => { void close().catch(() => undefined) }
    input.signal?.addEventListener('abort', abort, { once: true })
    try {
      input.signal?.throwIfAborted()
      let page: Page
      if (input.launch.ui === 'electron') {
        const entry = electronEntry(input.root, input.launch.command)
        app = await _electron.launch({ ...entry, args: [...entry.args, `--user-data-dir=${userData}`], cwd: input.root,
          env: softwareEnvironment(input.projectId, data), timeout: 20000 })
        child = app.process()
        input.signal?.throwIfAborted()
        page = await app.firstWindow({ timeout: 15000 })
      } else if (input.launch.ui === 'browser' && input.launch.url) {
        await startSoftwareProcess({ root: input.root, projectId: input.projectId, sessionId: owner, command: input.launch.command,
          url: input.launch.url, dataDir: data, signal: input.signal, purpose: input.purpose })
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
        try { const actual = await observeGuiStep(page, step, { data, fixtures: input.suite.fixtures, nativeProcessRoot: child?.pid, signal: input.signal }); result.steps.push({ id: step.id, passed: true, actual }) }
        catch (error) {
          result.steps.push({ id: step.id, passed: false, actual: (error as { actual?: unknown }).actual ?? String(error) })
          result.error = error instanceof Error ? error.message : String(error)
          result.status = result.error.startsWith('GUI_ACTION_UNSUPPORTED') || result.error.startsWith('GUI_FIXTURE_') ? 'unverified' : 'failed'
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
