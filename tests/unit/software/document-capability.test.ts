import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { createToolState } from '../../../main/agent/loop/agent-loop'
import { createSoftwareCollaborationPolicy } from '../../../main/software/collaboration-policy'
import { buildSoftwareAgentTools } from '../../../main/software/agent-tools'
import { prepareDocumentCapability, DOCUMENT_PACKAGES } from '../../../main/software/document-capability'
import { prepareSoftwareRelease, validateSoftwareRelease } from '../../../main/software/release-store'
import { executeSoftwareCommand } from '../../../main/software/command-runtime'
import { observeSoftwareGui } from '../../../main/software/gui-observer'
import type { GuiAcceptanceSuite } from '../../../main/desktop/gui-acceptance'

const require = createRequire(import.meta.url)
const runtime = require('../../../main/templates/tools/document_runtime.cjs')
let home: string, previous: string | undefined, project: ReturnType<typeof createProject>
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-document-cap-')); process.env.PROMA_HOME = home; project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' }) })
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }, 60000)
const ctx = () => ({ projectId: project.project_id, sessionId: 's', requestId: 'r', signal: new AbortController().signal, state: createToolState() })
const tools = () => buildSoftwareAgentTools(project.project_id, 'parent', createSoftwareCollaborationPolicy(project.project_id, project.root_path, 's'))
function data() { const dir = join(home, 'data'); mkdirSync(dir); return dir }

it('parses real PDF, Chinese DOCX/TXT, keeps source identity and rejects forged or cross-document citations', async () => {
  const dir = data()
  for (const name of ['sample.pdf', 'sample.docx', 'broken.pdf']) cpSync(resolve('tests/fixtures/software-import', name), join(dir, name))
  const pdf = await runtime.extractDocument(join(dir, 'sample.pdf'), { dataDir: dir })
  const docx = await runtime.extractDocument(join(dir, 'sample.docx'), { dataDir: dir })
  expect(pdf.blocks[0]).toMatchObject({ page: 1, text: expect.stringContaining('Frozen PDF contract text') })
  expect(docx.blocks[0]).toMatchObject({ page: null, text: expect.stringContaining('Frozen Word contract text') })
  const JSZip = createRequire(require.resolve('mammoth'))('jszip'), zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>中文资料甲：连续函数不一定可导。</w:t></w:r></w:p></w:body></w:document>')
  writeFileSync(join(dir, 'chinese.docx'), await zip.generateAsync({ type: 'nodebuffer' }))
  const chinese = await runtime.extractDocument(join(dir, 'chinese.docx'), { dataDir: dir })
  expect(chinese.blocks[0].text).toContain('连续函数不一定可导')
  writeFileSync(join(dir, 'b.txt'), '资料乙：积分；仅属于乙。')
  const second = await runtime.extractDocument(join(dir, 'b.txt'), { dataDir: dir })
  const hit = runtime.searchDocuments([chinese, second], '连续函数').hits[0]
  expect(runtime.verifyCitation([chinese, second], hit)).toMatchObject({ valid: true, quote: '连续函数' })
  expect(runtime.verifyCitation([chinese, second], { ...hit, quote: '所有连续函数都可导' })).toMatchObject({ valid: false, reason: 'quote_mismatch' })
  expect(runtime.verifyCitation([chinese, second], { ...hit, documentId: second.documentId })).toMatchObject({ valid: false, reason: 'source_not_found' })
  expect(runtime.searchDocuments([second], '连续函数')).toMatchObject({ total: 0, hits: [] })
  const originalId = second.documentId; writeFileSync(join(dir, 'b.txt'), '资料乙：已修改。')
  const changed = await runtime.extractDocument(join(dir, 'b.txt'), { dataDir: dir })
  expect(changed.documentId).not.toBe(originalId)
  expect(runtime.verifyCitation([changed], runtime.searchDocuments([second], '积分').hits[0]).valid).toBe(false)
  await expect(runtime.extractDocument(join(dir, 'broken.pdf'), { dataDir: dir })).rejects.toThrow()
  expect(pdf.blocks[0].text).toContain('Frozen PDF contract text')
})

it('bounds file/text/query inputs and refuses paths outside data while never inventing text', async () => {
  const dir = data(), outside = join(home, 'outside.txt'); writeFileSync(outside, 'private')
  await expect(runtime.extractDocument(outside, { dataDir: dir })).rejects.toThrow('OUTSIDE_DATA_DIR')
  writeFileSync(join(dir, 'empty.txt'), '   ')
  await expect(runtime.extractDocument(join(dir, 'empty.txt'), { dataDir: dir })).rejects.toThrow('NO_TEXT')
  writeFileSync(join(dir, 'bad.txt'), Buffer.from([0xff, 0xfe, 0x80]))
  await expect(runtime.extractDocument(join(dir, 'bad.txt'), { dataDir: dir })).rejects.toThrow()
  writeFileSync(join(dir, 'large.txt'), 'a'.repeat(2 * 1024 * 1024 + 1))
  await expect(runtime.extractDocument(join(dir, 'large.txt'), { dataDir: dir })).rejects.toThrow('TEXT_LIMIT')
  expect(() => runtime.searchDocuments([], '', 1)).toThrow('QUERY_INVALID')
  expect(() => runtime.searchDocuments([], 'x', 0)).toThrow('QUERY_INVALID')
  expect(runtime.verifyCitation([], { quote: '' }).valid).toBe(false)
})

it('preserves existing files, respects package managers and only installs when explicitly requested', async () => {
  const root = project.root_path
  writeFileSync(join(root, 'document_runtime.cjs'), 'user implementation')
  await expect(prepareDocumentCapability(project.project_id, root, ctx().signal)).rejects.toThrow('COMPONENT_CONFLICT')
  expect(readFileSync(join(root, 'document_runtime.cjs'), 'utf8')).toBe('user implementation')
  rmSync(join(root, 'document_runtime.cjs'))
  const execute = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'dependency missing' }))
  const result = await prepareDocumentCapability(project.project_id, root, ctx().signal, false, execute)
  expect(result).toMatchObject({ status: 'environment_blocked', product_verification: 'unverified' })
  expect(execute.mock.calls).toHaveLength(1)
  writeFileSync(join(root, 'package.json'), '{"name":"existing"}'); writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9')
  await expect(prepareDocumentCapability(project.project_id, root, ctx().signal, true, execute)).rejects.toThrow('USE_PROJECT_PACKAGE_MANAGER')
  expect(execute.mock.calls).toHaveLength(2)
  rmSync(join(root, 'pnpm-lock.yaml'))
  let probes = 0
  const installer: typeof executeSoftwareCommand = async input => {
    if (Array.isArray(input.command) && input.command[0] === 'npm') { expect(input.command).toEqual(['npm', 'install', '--save-exact', ...Object.entries(DOCUMENT_PACKAGES).map(([n, v]) => `${n}@${v}`)]); return { code: 0, stdout: '', stderr: '' } }
    return ++probes === 1 ? { code: 1, stdout: '', stderr: 'missing' } : { code: 0, stdout: JSON.stringify(DOCUMENT_PACKAGES), stderr: '' }
  }
  expect(await prepareDocumentCapability(project.project_id, root, ctx().signal, true, installer)).toMatchObject({ status: 'prepared', product_verification: 'unverified' })
})

it('exposes documents and counterexamples on demand without widening scope or granting collaborator preparation', async () => {
  const all = tools(), context = all.find(t => t.name === 'read_production_context')!
  for (const topic of ['documents', 'acceptance-counterexamples', 'existing-project']) {
    const result = await context.execute({ topic }, ctx()); expect(result.isError, result.output).not.toBe(true)
  }
  expect((await all.find(t => t.name === 'prepare_software_capability')!.execute({ capability: 'documents', download_models: true }, ctx())).isError).toBe(true)
  const others = buildSoftwareAgentTools(project.project_id, 'research', createSoftwareCollaborationPolicy(project.project_id, project.root_path, 's'))
  expect(others.some(t => t.name === 'prepare_software_capability')).toBe(false)
  const changes = await all.find(t => t.name === 'inspect_repository')!.execute({ mode: 'changes' }, ctx())
  expect(JSON.parse(changes.output)).toMatchObject({ available: false, reason: 'not_imported' })
})

// Physical copies of real installed packages, including the platform canvas binary;
// product execution must resolve its own dependencies, never a host module link.
function copyPackage(name: string, destination: string, from = require, seen = new Set<string>()) {
  let manifest: string
  try { manifest = from.resolve(name + '/package.json') } catch {
    let directory = dirname(from.resolve(name))
    while (!existsSync(join(directory, 'package.json'))) directory = dirname(directory)
    manifest = join(directory, 'package.json')
  }
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  if (seen.has(pkg.name)) return
  seen.add(pkg.name)
  const target = join(destination, 'node_modules', pkg.name); mkdirSync(dirname(target), { recursive: true }); cpSync(dirname(manifest), target, { recursive: true, dereference: true })
  const scoped = createRequire(manifest)
  for (const dep of Object.keys(pkg.dependencies ?? {})) copyPackage(dep, destination, scoped, seen)
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) { try { scoped.resolve(dep) } catch { continue }; copyPackage(dep, destination, scoped, seen) }
}
it('prepares real product dependencies through public tools and parses from a frozen release in a managed process', async () => {
  const root = project.root_path
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'document-product', dependencies: DOCUMENT_PACKAGES }))
  for (const name of Object.keys(DOCUMENT_PACKAGES)) copyPackage(name, root)
  const result = await tools().find(t => t.name === 'prepare_software_capability')!.execute({ capability: 'documents' }, ctx())
  expect(result.isError, result.output).not.toBe(true)
  expect(JSON.parse(result.output)).toMatchObject({ status: 'prepared', product_verification: 'unverified', dependencies: { mammoth: { version: '1.13.0' } } })
  const dir = data(); for(const name of ['sample.pdf','sample.docx'])cpSync(resolve('tests/fixtures/software-import',name), join(dir,name))
  writeFileSync(join(root, 'app.cjs'), `require('./document_runtime.cjs').extractDocument(require('node:path').join(process.env.APP_DATA_DIR,process.argv[2]||'sample.pdf'),{dataDir:process.env.APP_DATA_DIR}).then(doc=>console.log(doc.blocks[0].text)).catch(e=>{console.error(e);process.exitCode=1})`)
  writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, mode: 'command', command: ['node', 'app.cjs'] }))
  const release = await prepareSoftwareRelease(project.project_id, root)
  const actual = await executeSoftwareCommand({ projectId: project.project_id, root: release.root, dataDir: dir, command: ['node', 'app.cjs'] })
  expect(actual.code, actual.stderr).toBe(0); expect(actual.stdout).toContain('Frozen PDF contract text')
  const word = await executeSoftwareCommand({projectId:project.project_id,root:release.root,dataDir:dir,command:['node','app.cjs','sample.docx']})
  expect(word.code,word.stderr).toBe(0);expect(word.stdout).toContain('Frozen Word contract text')
  await validateSoftwareRelease(project.project_id, release)
  const port = createServer(); await new Promise<void>(done => port.listen(0, '127.0.0.1', done)); const address = port.address()
  if (!address || typeof address === 'string') throw Error('port')
  await new Promise<void>(done => port.close(() => done()))
  cpSync(resolve('tests/fixtures/software-import/document-product.cjs.txt'), join(root, 'server.cjs'))
  writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, ui: 'browser', url: `http://127.0.0.1:${address.port}`, command: ['node', 'server.cjs', String(address.port)] }))
  const browserRelease = await prepareSoftwareRelease(project.project_id, root), temporary = join(home, 'gui'), guiData = join(temporary, 'data')
  mkdirSync(join(guiData, 'input'), { recursive: true })
  const fixtures = ['sample.pdf', 'sample.docx', 'broken.pdf'].map(name => {
    const bytes = readFileSync(resolve('tests/fixtures/software-import', name)); writeFileSync(join(guiData, 'input', name), bytes)
    return { path: `input/${name}`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
  })
  const steps: GuiAcceptanceSuite['steps'] = [
    { id: 'pdf', kind: 'upload', selector: '#file', path: 'input/sample.pdf' },
    { id: 'pdf-text', kind: 'expect', selector: '#text', contains: 'Frozen PDF contract text' },
    { id: 'query', kind: 'fill', selector: '#query', value: 'PDF' }, { id: 'search', kind: 'click', selector: '#search' },
    { id: 'found', kind: 'expect', selector: '#count', equals: '1' },
    { id: 'forge', kind: 'click', selector: '#forged' }, { id: 'reject-forge', kind: 'expect', selector: '#citation', equals: '引用未核验' },
    { id: 'word', kind: 'upload', selector: '#file', path: 'input/sample.docx' },
    { id: 'word-text', kind: 'expect', selector: '#text', contains: 'Frozen Word contract text' },
    { id: 'no-stale-count', kind: 'expect', selector: '#count', equals: '0' },
    { id: 'broken', kind: 'upload', selector: '#file', path: 'input/broken.pdf' },
    { id: 'broken-error', kind: 'expect', selector: '#status', equals: '无法读取' },
    { id: 'retained', kind: 'expect', selector: '#text', contains: 'Frozen Word contract text' },
    { id: 'restart', kind: 'restart' }, { id: 'persisted', kind: 'expect', selector: '#documents option', property: 'count', equals: '2' },
    { id: 'persisted-text', kind: 'expect', selector: '#text', contains: 'Frozen PDF contract text' },
  ]
  const evidence = resolve('run-artifacts/capability-expansion-20261029-ui'); mkdirSync(evidence, { recursive: true })
  const gui = await observeSoftwareGui({ projectId: project.project_id, root: browserRelease.root, launch: browserRelease.launch, temporary,
    screenshotDir: evidence, suite: { version: 1, scope_hash: 'fixed-engineering-fixture', covers: ['F-001'], fixtures, steps }, signal: AbortSignal.timeout(60000) })
  writeFileSync(join(evidence, 'report.json'), JSON.stringify({ gui, paid_requests: 0, scope: 'fixed fixture; real product dependencies, browser upload, parser, source checking and process reopen; not model generation or AI quality' }, null, 2))
  expect(gui.status, JSON.stringify(gui)+(existsSync(join(guiData,'last-error.txt'))?readFileSync(join(guiData,'last-error.txt'),'utf8'):'')).toBe('passed')
  const persisted = JSON.parse(readFileSync(join(guiData, 'documents.json'), 'utf8'))
  expect(persisted).toHaveLength(2)
  await validateSoftwareRelease(project.project_id, browserRelease)
}, 120000)
