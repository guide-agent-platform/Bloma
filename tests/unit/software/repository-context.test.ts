import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { buildSoftwareAgentTools } from '../../../main/software/agent-tools'
import { createSoftwareCollaborationPolicy } from '../../../main/software/collaboration-policy'
import { buildRepositoryContextTool, repositoryFileFacts } from '../../../main/software/repository-context'
import { createToolState } from '../../../main/agent/loop/agent-loop'
import { softwareVerificationFingerprint, verificationFingerprint } from '../../../main/desktop/verification-fingerprint'

let home: string, previous: string | undefined, project: ReturnType<typeof createProject>
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-repository-')); process.env.PROMA_HOME = home;
  project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' }) })
// The large-repository case removes 5100 actual files on Windows. Keep the
// behavior assertions intact and budget cleanup separately from the test body.
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }, 60000)
const ctx = () => ({ projectId: project.project_id, sessionId: 's', requestId: 'r', signal: new AbortController().signal, state: createToolState() })
it('reuses content-bound declaration/import facts and invalidates same-size edits even when mtime is restored', async () => {
  const root = project.root_path, file = join(root, 'module.ts')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' }, engines: { node: '>=22' } })); writeFileSync(join(root, 'uv.lock'), 'version=1')
  writeFileSync(file, 'import { read } from "./a"\nexport function alpha() {}')
  expect(repositoryFileFacts(project.project_id, root, 'module.ts')).toMatchObject({ reused: false, declaration_candidates: [{ name: 'alpha', kind: 'function', line: 2 }], import_candidates: [{ target: './a', line: 1 }] })
  expect(repositoryFileFacts(project.project_id, root, 'module.ts').reused).toBe(true)
  const before = statSync(file), version = softwareVerificationFingerprint(root)
  writeFileSync(file, readFileSync(file, 'utf8').replace('alpha', 'bravo')); utimesSync(file, before.atime, before.mtime)
  expect(repositoryFileFacts(project.project_id, root, 'module.ts')).toMatchObject({ reused: false, declaration_candidates: [{ name: 'bravo' }] })
  expect(softwareVerificationFingerprint(root)).not.toBe(version)
  const tool = buildRepositoryContextTool(project.project_id)
  const overview = JSON.parse((await tool.execute({ mode: 'overview' }, ctx())).output)
  expect(overview.scripts.test).toBe('node --test'); expect(overview.manifests).toContain('uv.lock')
  expect((await tool.execute({ mode: 'file', path: '../outside.ts' }, ctx())).isError).toBe(true)
})
it('finds deeply nested source and fingerprints more than the legacy 5000-file budget without treating dependencies as source', async () => {
  const root = project.root_path, deep = 'packages/a/src/logic/nested/components/deep-module.ts'
  mkdirSync(join(root, 'packages/a/src/logic/nested/components'), { recursive: true }); writeFileSync(join(root, deep), 'export function deepTarget() {return 42}')
  mkdirSync(join(root, 'many')); for (let i = 0; i < 5100; i++) writeFileSync(join(root, 'many', `${i}.ts`), `export const v${i}=1`)
  mkdirSync(join(root, '.venv/Lib'), { recursive: true }); writeFileSync(join(root, '.venv/Lib/dependency.py'), 'not project source')
  expect(verificationFingerprint(root)).toBeUndefined(); expect(softwareVerificationFingerprint(root)).toMatch(/^[a-f0-9]{64}$/)
  const tools = buildSoftwareAgentTools(project.project_id, 'parent', createSoftwareCollaborationPolicy(project.project_id, root, 's'))
  expect((await tools.find(tool => tool.name === 'list_files')!.execute({ path: '.' }, ctx())).isError).not.toBe(true)
  const found = await tools.find(tool => tool.name === 'find')!.execute({ pattern: '**/deep-module.ts' }, ctx())
  expect(found.output).toContain(deep)
  const search = await tools.find(tool => tool.name === 'inspect_repository')!.execute({ mode: 'search', query: 'deepTarget', path: 'packages' }, ctx())
  expect(JSON.parse(search.output)).toMatchObject({ hits: [{ path: deep, line: 1 }], skipped_large_files: 0, truncated: false })
}, 90000)
it('keeps read/CAS protection while allowing software repair edits under the shared task budget', async () => {
  const root = project.root_path, tools = buildSoftwareAgentTools(project.project_id, 'parent', createSoftwareCollaborationPolicy(project.project_id, root, 's')), context = ctx()
  context.state.test_failed = true; writeFileSync(join(root, 'repair.txt'), 'revision-0')
  for (let i = 0; i < 5; i++) {
    await tools.find(tool => tool.name === 'read_file')!.execute({ path: 'repair.txt' }, context)
    const edited = await tools.find(tool => tool.name === 'edit_file')!.execute({ path: 'repair.txt', old_string: `revision-${i}`, new_string: `revision-${i + 1}` }, context)
    expect(edited.isError, edited.output).not.toBe(true); expect(edited.budgetExhausted).not.toBe(true)
  }
  expect(readFileSync(join(root, 'repair.txt'), 'utf8')).toBe('revision-5')
})
