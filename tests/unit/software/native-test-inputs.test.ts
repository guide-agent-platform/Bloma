import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { nativeTestInputs } from '../../../main/software/native-test-inputs'
import { freezeNativeGuiTests, frozenNativeGuiEntry, nativeGuiObservations, nativeTestContractChanges, validateNativeGuiTests } from '../../../main/software/native-gui-tests'
import { prepareNativeTestRuntime } from '../../../main/software/native-test-runtime'

let home: string, root: string, previous: string | undefined
const script = `export default async({test,page,expect})=>{await test('F-001 create',async()=>{await page.locator('#name').fill('Alice');await expect(page.locator('#name')).toHaveValue('Alice')})}`
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-test-inputs-')); process.env.PROMA_HOME = home; root = join(home, 'project'); mkdirSync(join(root, 'tests'), { recursive: true }); writeFileSync(join(root, 'tests/acceptance.mjs'), script) })
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) })
it('snapshots only reachable inputs, including helpers outside tests and static fixture URLs', () => {
  mkdirSync(join(root, 'tools')); writeFileSync(join(root, 'tools/fixture.json'), '{"value":"Alice"}')
  writeFileSync(join(root, 'tools/helper.mjs'), `import fs from 'node:fs';export const input=JSON.parse(fs.readFileSync(new URL('./fixture.json',import.meta.url),'utf8')).value;`)
  writeFileSync(join(root, 'tests/acceptance.mjs'), `import{input}from'../tools/helper.mjs';\n` + script)
  writeFileSync(join(root, 'tests/unrelated-probe.mjs'), 'this is not valid JavaScript')
  expect(nativeTestInputs(root, 'tests/acceptance.mjs')).toEqual(['tests/acceptance.mjs', 'tools/fixture.json', 'tools/helper.mjs'])
  const first = freezeNativeGuiTests('p', root, 'tests/acceptance.mjs', ['F-001'])
  writeFileSync(join(root, 'tests/unrelated-probe.mjs'), 'changed unrelated probe')
  expect(freezeNativeGuiTests('p', root, 'tests/acceptance.mjs', ['F-001']).digest).toBe(first.digest)
})
it('reports missing local and package dependencies before creating a snapshot', () => {
  writeFileSync(join(root, 'tests/acceptance.mjs'), `import '../tools/missing.cjs';\n` + script)
  expect(() => freezeNativeGuiTests('p', root, 'tests/acceptance.mjs', ['F-001'])).toThrow('GUI_NATIVE_DEPENDENCY_MISSING')
  expect(existsSync(join(home, 'gui-native-tests'))).toBe(false)
  writeFileSync(join(root, 'tests/acceptance.mjs'), `import 'bloma-uninstalled-test-package';\n` + script)
  expect(() => nativeTestInputs(root, 'tests/acceptance.mjs')).toThrow('GUI_NATIVE_PACKAGE_MISSING')
})
it('captures explicitly declared dynamic assets and rejects escaping or linked helpers', () => {
  writeFileSync(join(root, 'tests/native-inputs.json'), JSON.stringify({ files: ['fixture.txt'] })); writeFileSync(join(root, 'fixture.txt'), 'fixed input')
  expect(nativeTestInputs(root, 'tests/acceptance.mjs')).toContain('fixture.txt')
  writeFileSync(join(root, 'tests/native-inputs.json'), JSON.stringify({ files: ['../outside.txt'] }))
  expect(() => nativeTestInputs(root, 'tests/acceptance.mjs')).toThrow('GUI_NATIVE_INPUTS_INVALID')
  rmSync(join(root, 'tests/native-inputs.json')); writeFileSync(join(root, 'tests/acceptance.mjs'), `import '../alias/helper.cjs';\n` + script)
  const outside = join(home, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'helper.cjs'), 'module.exports={}')
  symlinkSync(outside, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => nativeTestInputs(root, 'tests/acceptance.mjs')).toThrow('GUI_NATIVE_LINK_UNSUPPORTED')
})
it.each(['commonjs', 'module'])('really imports the frozen project layout and third-party %s helper through a host-owned runtime link', mode => {
  mkdirSync(join(root, 'tools')); mkdirSync(join(root, 'node_modules/local-test-helper'), { recursive: true })
  const extension = mode === 'module' ? 'mjs' : 'cjs'
  writeFileSync(join(root, 'node_modules/local-test-helper/package.json'), JSON.stringify({ name: 'local-test-helper', ...(mode === 'module' ? { exports: { import: './index.mjs' } } : { main: 'index.cjs' }) }))
  writeFileSync(join(root, `node_modules/local-test-helper/index.${extension}`), mode === 'module' ? 'export default {input:"Alice"}' : 'module.exports={input:"Alice"}')
  writeFileSync(join(root, `tools/helper.${extension}`), mode === 'module' ? `export {default} from 'local-test-helper'` : `module.exports=require('local-test-helper')`)
  writeFileSync(join(root, 'tests/acceptance.mjs'), `import helper from '../tools/helper.${extension}';if(helper.input!=='Alice')throw Error('bad helper');\n` + script)
  const native = freezeNativeGuiTests('p', root, 'tests/acceptance.mjs', ['F-001']), workspace = join(home, 'software-debug-data/p/owned'); mkdirSync(workspace, { recursive: true })
  const runtime = prepareNativeTestRuntime('p', native, root, workspace)
  try {
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(runtime.file).href)});console.log('imported')`], { encoding: 'utf8', windowsHide: true }).trim()).toBe('imported')
    runtime.verify(); writeFileSync(runtime.file, 'modified input'); expect(() => runtime.verify()).toThrow('GUI_NATIVE_INPUT_CHANGED')
  } finally { runtime.close() }
  expect(readFileSync(join(root, `node_modules/local-test-helper/index.${extension}`), 'utf8')).toContain('Alice')
})
it('retains legacy snapshots and allows extra cases without lowering existing business assertions', () => {
  const first = freezeNativeGuiTests('p', root, 'tests/acceptance.mjs', ['F-001'])
  writeFileSync(join(root, 'tests/acceptance.mjs'), script.replace(/}$/, `;await test('F-001 extra',async()=>{await expect(page.locator('#name')).toHaveValue('Alice')})}`))
  const next = freezeNativeGuiTests('p', root, 'tests/acceptance.mjs', ['F-001'])
  expect(nativeTestContractChanges(first, next)).toEqual([])
  writeFileSync(join(root, 'tests/acceptance.mjs'), script.replaceAll('Alice', 'Wrong'))
  expect(nativeTestContractChanges(first, freezeNativeGuiTests('p', root, 'tests/acceptance.mjs', ['F-001']))).toContain('case:F-001:F-001 create')
  writeFileSync(join(root, 'tests/acceptance.mjs'), script)
  const sha = (x: string) => createHash('sha256').update(x).digest('hex')
  const legacy = { ...first, layout: undefined, entry: 'acceptance.mjs', files: first.files.map(f => ({ ...f, path: f.path.replace(/^tests\//, '') })) }
  legacy.digest = sha(JSON.stringify(legacy.files)); legacy.contract = sha(JSON.stringify({ entry: legacy.entry, directory: legacy.directory, restart: legacy.restart, cases: legacy.cases, files: legacy.files.map(f => ({ path: f.path, semantic: f.support ?? f.sha256 })) }))
  const destination = join(home, 'gui-native-tests/p', legacy.digest); mkdirSync(destination, { recursive: true }); writeFileSync(join(destination, legacy.entry), script)
  expect(() => validateNativeGuiTests(legacy)).not.toThrow(); expect(frozenNativeGuiEntry('p', legacy, root)).toBe(join(destination, legacy.entry))
  expect(nativeTestContractChanges(legacy, first)).toEqual([])
})
it('preserves the actual bootstrap failure instead of reporting unexecuted business cases generically', () => {
  const native = freezeNativeGuiTests('p', root, 'tests/acceptance.mjs', ['F-001'])
  const result = nativeGuiObservations({ covers: ['F-001'], native_tests: native } as never, [{ code: 1, events: JSON.stringify({ type: 'test:fail', name: 'Bloma native application suite', error: "Cannot find module '../tools/fixture.cjs'" }), trace: '{"interactions":0,"assertions":0,"cases":[]}' }])
  expect(result.status).toBe('unverified'); expect(result.error).toContain('GUI_NATIVE_BOOTSTRAP_FAILED'); expect(result.error).toContain('../tools/fixture.cjs')
})
