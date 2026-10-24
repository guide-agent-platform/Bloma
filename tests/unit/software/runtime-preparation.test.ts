import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { prepareSoftwareRuntime } from '../../../main/software/runtime-manager'
import { fileDigest } from '../../../main/software/release-store'
import { executeSoftwareCommand } from '../../../main/software/command-runtime'
import { buildSoftwareAgentTools } from '../../../main/software/agent-tools'
import { createSoftwareCollaborationPolicy } from '../../../main/software/collaboration-policy'
import { createToolState } from '../../../main/agent/loop/agent-loop'

let home: string, previous: string | undefined, project: ReturnType<typeof createProject>
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-runtime-unit-')); process.env.PROMA_HOME = home;
  project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' }) })
afterEach(() => { vi.restoreAllMocks(); if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
it.skipIf(process.platform !== 'win32' || process.arch !== 'x64')('reuses a genuine cached executable offline, checks project engines and refuses tampered bytes without fallback', async () => {
  const executable = join(home, 'software-runtimes/test/node.exe'), catalog = join(home, 'software-runtimes/catalog')
  mkdirSync(join(home, 'software-runtimes/test'), { recursive: true }); mkdirSync(catalog)
  copyFileSync(process.execPath, executable)
  writeFileSync(join(catalog, `node-${process.versions.node}-${process.platform}-${process.arch}.json`), JSON.stringify({ kind: 'node', version: process.versions.node,
    executable, sha256: await fileDigest(executable), platform: process.platform, arch: process.arch, request: process.versions.node, source: 'test-only copied real host executable', license: 'test fixture', at: new Date().toISOString() }))
  writeFileSync(join(project.root_path, 'package.json'), JSON.stringify({ engines: { node: process.versions.node } }))
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('offline'))
  expect((await prepareSoftwareRuntime(project.project_id, project.root_path, 'node')).reused).toBe(true)
  expect(fetch).not.toHaveBeenCalled()
  const result = await executeSoftwareCommand({ projectId: project.project_id, root: project.root_path, command: ['node', '-p', 'process.execPath'] })
  expect(result.code, result.stderr).toBe(0); expect(result.stdout.trim()).toBe(executable)
  writeFileSync(executable, 'changed runtime')
  await expect(executeSoftwareCommand({ projectId: project.project_id, root: project.root_path, command: ['node', '-p', '1'] })).rejects.toThrow('MANAGED_RUNTIME_CHANGED')
  expect(existsSync(join(home, 'software-environments', project.project_id, 'runtimes.json'))).toBe(true)
})
it('exposes the preparation schema only to the parent and rejects bad arguments before preparation', async () => {
  const policy = createSoftwareCollaborationPolicy(project.project_id, project.root_path, 's')
  const parent = buildSoftwareAgentTools(project.project_id, 'parent', policy), child = buildSoftwareAgentTools(project.project_id, 'implement', policy)
  expect(child.some(tool => tool.name === 'prepare_software_environment')).toBe(false)
  const tool = parent.find(tool => tool.name === 'prepare_software_environment')!
  const ctx = { projectId: project.project_id, sessionId: 's', requestId: 'r', signal: new AbortController().signal, state: createToolState() }
  expect((await tool.execute({ runtime: 'system-installer' }, ctx)).isError).toBe(true)
  expect((await tool.execute({ runtime: 'node', version: 'not-a-version' }, ctx)).output).toMatch(/NODE_VERSION_REQUEST_INVALID|MANAGED_RUNTIME_PLATFORM_UNSUPPORTED/)
  expect(readFileSync(join(process.cwd(), 'main/templates/tools/extract_runtime_archive.ps1'), 'utf8')).toContain('[.][.]')
})
