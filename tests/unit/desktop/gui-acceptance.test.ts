import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guiSuitePath, installGuiAcceptanceSuite, parseGuiSuite, runGuiAcceptance, type GuiAcceptanceSuite } from '../../../main/desktop/gui-acceptance'
import type { DriverCommandRequest } from '../../../main/desktop/process-driver'
let root: string
const scope = 'a'.repeat(64)
const suite = (): GuiAcceptanceSuite => ({ version: 1, scope_hash: scope, covers: ['F-001'], steps: [{ id: 'empty', kind: 'expect', selector: '#count', equals: '0' }] })
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bloma-native-gui-test-'))
  cpSync(resolve('tests/fixtures/gui-acceptance'), root, { recursive: true })
  cpSync(resolve('main/templates/skeletons/desktop-python/ui/bridge.js'), join(root, 'bridge.js'))
  writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify({ schema_version: 1, command: ['python', 'app.py'] }))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
const observation = (steps: unknown[], status = 'passed') => ({ code: 0, stdout: 'BLOMA_GUI_ACCEPTANCE:' + JSON.stringify({ version: 1, status, steps }), stderr: '' })
describe('independent host native GUI acceptance', () => {
  it('shares isolated data across actual restart segments and removes it afterwards', async () => {
    const input = suite(); input.steps.push({ id: 'restart', kind: 'restart' }, { id: 'saved', kind: 'expect', selector: '#count', equals: '1' })
    installGuiAcceptanceSuite('p', input)
    let data = ''
    const spawn = vi.fn(async (request: DriverCommandRequest) => {
      if (data) expect(request.env.APP_DATA_DIR).toBe(data)
      data = request.env.APP_DATA_DIR
      const group = JSON.parse(readFileSync(request.command.at(-1)!, 'utf8'))
      return observation(group.map((step: { id: string }) => ({ id: step.id, passed: true })))
    })
    expect((await runGuiAcceptance({ projectId: 'p', root, scopeHash: scope, spawn }))?.status).toBe('passed')
    expect(spawn).toHaveBeenCalledTimes(2); expect(existsSync(data)).toBe(false)
  })
  it.each(['scope', 'source', 'rules', 'missing_steps', 'failure', 'cancel'] as const)('does not accept stale or incomplete %s evidence', async mode => {
    installGuiAcceptanceSuite('p', suite())
    const abort = new AbortController()
    const spawn = vi.fn(async () => {
      if (mode === 'source') writeFileSync(join(root, 'app.py'), '# changed')
      if (mode === 'rules') installGuiAcceptanceSuite('p', { ...suite(), covers: ['F-002'] })
      if (mode === 'cancel') abort.abort()
      return observation(mode === 'missing_steps' ? [] : [{ id: 'empty', passed: mode !== 'failure' }], mode === 'failure' ? 'failed' : 'passed')
    })
    const work = runGuiAcceptance({ projectId: 'p', root, scopeHash: mode === 'scope' ? 'b'.repeat(64) : scope, spawn, signal: abort.signal })
    if (mode === 'cancel') await expect(work).rejects.toThrow()
    else expect((await work)?.status).toBe(mode === 'failure' ? 'failed' : 'unverified')
    if (mode === 'scope') expect(spawn).not.toHaveBeenCalled()
  })
  it('requires real expected assertions in each bounded segment', () => {
    expect(() => parseGuiSuite({ ...suite(), steps: [{ id: 'click', kind: 'click', selector: '#button' }] })).toThrow('ASSERTION')
    expect(() => parseGuiSuite({ ...suite(), steps: [...suite().steps, { id: 'restart', kind: 'restart' }] })).toThrow('ASSERTION')
    expect(guiSuitePath('p')).not.toContain(root)
  })
  const nativePython = resolve('run-artifacts/workflow-gui-runtime/Scripts/python.exe')
  it.skipIf(process.platform !== 'win32' || !existsSync(nativePython))('really clicks through native pywebview, checks persistence after restart, and rejects empty input', async () => {
    const input = suite()
    input.steps.push({ id: 'type', kind: 'fill', selector: '#name', value: 'saved by host' }, { id: 'save', kind: 'click', selector: '#save' },
      { id: 'added', kind: 'expect', selector: '#count', equals: '1' }, { id: 'restart', kind: 'restart' },
      { id: 'persisted', kind: 'expect', selector: '#items', equals: 'saved by host' },
      { id: 'empty-save', kind: 'click', selector: '#save' }, { id: 'error', kind: 'expect', selector: '#error', equals: 'Name required' },
      { id: 'unchanged', kind: 'expect', selector: '#count', equals: '1' })
    installGuiAcceptanceSuite('p', input)
    const result = await runGuiAcceptance({ projectId: 'p', root, scopeHash: scope, python: nativePython, signal: AbortSignal.timeout(90000) })
    expect(result?.status, JSON.stringify(result)).toBe('passed')
    expect(result?.steps).toHaveLength(8)
    installGuiAcceptanceSuite('p', { ...suite(), steps: [{ id: 'wrong-expectation', kind: 'expect', selector: '#count', equals: '999', timeout_ms: 100 }] })
    const negative = await runGuiAcceptance({ projectId: 'p', root, scopeHash: scope, python: nativePython, signal: AbortSignal.timeout(45000) })
    expect(negative?.status).toBe('failed')
    expect(negative?.steps[0].actual).toBe('0')
    writeFileSync(resolve('run-artifacts/workflow-20261022-native-gui.json'), JSON.stringify({ fixture: 'tests/fixtures/gui-acceptance', success: result, intentional_counterexample: negative }, null, 2))
  }, 100000)
})
