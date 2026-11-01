import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createToolState, type ToolContext } from '../../../main/agent/loop/agent-loop'
import { createProject } from '../../../main/project/project-service'
import { buildSoftwareAgentTools } from '../../../main/software/agent-tools'
import { createSoftwareCollaborationPolicy } from '../../../main/software/collaboration-policy'
import { executeSoftwareCommand } from '../../../main/software/command-runtime'
import { runHostSpeechProbe } from '../../../main/desktop/speech-verification'
import { speechCapabilityBinding } from '../../../main/software/capability-bindings'
import { SPEECH_COMPONENTS } from '../../../main/software/capability-tools'
import { speechModelRoot } from '../../../main/platform/speech/model-manifest'

// Exercise the public tool and real ownership policy; replace only subprocesses,
// decoder and model bytes. No Python, network, model provider or microphone runs.
vi.mock('../../../main/software/command-runtime', async original => ({
  ...await original<typeof import('../../../main/software/command-runtime')>(), executeSoftwareCommand: vi.fn(),
}))
vi.mock('../../../main/desktop/speech-verification', async original => ({
  ...await original<typeof import('../../../main/desktop/speech-verification')>(), runHostSpeechProbe: vi.fn(),
}))
vi.mock('../../../main/platform/speech/model-manifest', async original => {
  const real = await original<typeof import('../../../main/platform/speech/model-manifest')>()
  const asset = (name: string) => ({ name, url: 'https://never-fetched.invalid/' + name, bytes: 3,
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' })
  return { ...real, SPEECH_MODEL_MANIFEST: { model: asset('model.int8.onnx'), tokens: asset('tokens.txt'), vad: asset('silero_vad.onnx') } }
})

let home: string, previous: string | undefined, project: ReturnType<typeof createProject>, policy: ReturnType<typeof createSoftwareCollaborationPolicy>
const parent = 'capability-parent'
const context = (sessionId = parent, signal = new AbortController().signal): ToolContext => ({
  projectId: project.project_id, sessionId, requestId: 'r', signal, state: createToolState(),
})
const tools = () => buildSoftwareAgentTools(project.project_id, 'parent', policy)
const prepare = (ctx = context()) => tools().find(t => t.name === 'prepare_software_capability')!
  .execute({ capability: 'speech', install_dependencies: false }, ctx)
const imported = { python: 'fixture-python', version: '3.13.7', packages: Object.fromEntries(
  ['numpy', 'sherpa_onnx', 'sounddevice'].map(name => [name, { available: true, version: 'fixture', path: 'fixture/' + name }])) }
const report = () => ({ code: 0, stdout: JSON.stringify(imported), stderr: '' })
beforeEach(() => {
  previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-capability-entry-')); process.env.PROMA_HOME = home
  project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' })
  policy = createSoftwareCollaborationPolicy(project.project_id, project.root_path, parent)
  const scripts = join(project.root_path, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin')
  mkdirSync(scripts, { recursive: true }); writeFileSync(join(scripts, process.platform === 'win32' ? 'python.exe' : 'python'), 'fixture only')
  mkdirSync(speechModelRoot(), { recursive: true })
  for (const name of ['model.int8.onnx', 'tokens.txt', 'silero_vad.onnx']) writeFileSync(join(speechModelRoot(), name), 'abc')
  vi.mocked(executeSoftwareCommand).mockReset().mockImplementation(async () => report())
  vi.mocked(runHostSpeechProbe).mockReset().mockResolvedValue({ probe_version: 1, status: 'passed', real_decode_calls: 3,
    tests: [], microphone: { status: 'not_run' } })
})
afterEach(() => {
  if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous
  // Only the test-owned temporary home, including its link targets, is removed.
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

it('prepares speech through the public agent tool and reuses its binding without granting generic .venv writes', async () => {
  const result = await prepare()
  expect(result.isError, result.output).not.toBe(true)
  expect(JSON.parse(result.output)).toMatchObject({ status: 'prepared', microphone: 'not_tested', product_verification: 'unverified' })
  expect(speechCapabilityBinding(project.project_id)?.provider).toBe('python-sensevoice-v1')
  expect(SPEECH_COMPONENTS.every(name => existsSync(join(project.root_path, name)))).toBe(true)
  expect(executeSoftwareCommand).toHaveBeenCalledTimes(1)
  expect(runHostSpeechProbe).toHaveBeenCalledTimes(1)
  expect(vi.mocked(runHostSpeechProbe).mock.calls[0][0]).not.toHaveProperty('microphone')
  expect((await prepare()).isError).not.toBe(true)
  const write = tools().find(t => t.name === 'write_file')!
  await expect(write.execute({ path: '.venv/pyvenv.cfg', content: 'overwrite' }, context())).rejects.toThrow('WRITE_PATH_OUTSIDE_PROJECT')
  expect(() => policy.prepare({ parent: context(), args: { task: 'write env', role: 'implement', writePaths: ['.venv/'] },
    childSessionId: 'child', delegationId: 'd' })).toThrow('WRITE_PATH_OUTSIDE_PROJECT')
})

it('keeps custom speech files intact and reports the actionable conflict before any process or binding', async () => {
  writeFileSync(join(project.root_path, 'speech_runtime.py'), 'user implementation')
  const result = await prepare()
  expect(result.isError).toBe(true); expect(result.output).toContain('CAPABILITY_EXISTING_FILES_PRESERVED')
  expect(readFileSync(join(project.root_path, 'speech_runtime.py'), 'utf8')).toBe('user implementation')
  expect(executeSoftwareCommand).not.toHaveBeenCalled(); expect(runHostSpeechProbe).not.toHaveBeenCalled()
  expect(speechCapabilityBinding(project.project_id)).toBeUndefined()
})

it('authorizes fixed venv creation and dependency installation through the same public entry', async () => {
  rmSync(join(project.root_path, '.venv'), { recursive: true, force: true })
  let installed = false
  vi.mocked(executeSoftwareCommand).mockImplementation(async input => {
    expect(input.projectId).toBe(project.project_id); expect(input.root).toBe(project.root_path)
    if (!Array.isArray(input.command)) throw Error('Expected an argument-array command')
    if (input.command[2] === 'venv') {
      const scripts = join(project.root_path, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin')
      mkdirSync(scripts, { recursive: true }); writeFileSync(join(scripts, process.platform === 'win32' ? 'python.exe' : 'python'), 'fixture only')
      return { code: 0, stdout: '', stderr: '' }
    }
    if (input.command[2] === 'pip') { installed = true; return { code: 0, stdout: '', stderr: '' } }
    return { code: 0, stdout: JSON.stringify({ ...imported, packages: installed ? imported.packages : {} }), stderr: '' }
  })
  const result = await tools().find(t => t.name === 'prepare_software_capability')!.execute({ capability: 'speech' }, context())
  expect(result.isError, result.output).not.toBe(true)
  expect(vi.mocked(executeSoftwareCommand).mock.calls.map(([input]) => input.command)).toEqual([
    ['python', '-I', '-B', '-c', expect.any(String)], ['python', '-m', 'venv', '.venv'],
    ['python', '-I', '-B', '-c', expect.any(String)],
    ['python', '-m', 'pip', 'install', '--disable-pip-version-check', 'numpy==2.5.4', 'sherpa-onnx==1.13.8', 'sounddevice==0.5.6'],
    ['python', '-I', '-B', '-c', expect.any(String)],
  ])
  expect(speechCapabilityBinding(project.project_id)).toBeDefined()
})

it('does not install dependencies when explicitly disabled or bind a failed preparation', async () => {
  vi.mocked(executeSoftwareCommand).mockResolvedValue({ code: 0, stdout: JSON.stringify({ ...imported, packages: {} }), stderr: '' })
  const result = await prepare()
  expect(result.isError).toBe(true); expect(result.output).toContain('CAPABILITY_PACKAGES_MISSING')
  expect(executeSoftwareCommand).toHaveBeenCalledTimes(1); expect(runHostSpeechProbe).not.toHaveBeenCalled()
  expect(speechCapabilityBinding(project.project_id)).toBeUndefined()
  expect(SPEECH_COMPONENTS.some(name => existsSync(join(project.root_path, name)))).toBe(false)
})

it('retains parent identity, writer and frozen-review gates before speech preparation', async () => {
  expect((await prepare(context('child'))).output).toContain('COMMAND_INTEGRATOR_ONLY')
  expect((await prepare({ ...context(), projectId: 'other-project' })).output).toContain('COMMAND_INTEGRATOR_ONLY')
  const lease = policy.prepare({ parent: context(), args: { task: 'bounded edit', role: 'implement', writePaths: ['app.cjs'] }, childSessionId: 'writer', delegationId: 'd' })
  expect((await prepare()).output).toContain('COMMAND_WAIT_FOR_WRITERS'); lease.release()
  const release = policy.freezeReview()
  expect((await prepare()).output).toContain('QUALITY_REVIEW_FROZEN'); release()
  expect(executeSoftwareCommand).not.toHaveBeenCalled(); expect(runHostSpeechProbe).not.toHaveBeenCalled()
  for (const role of ['review', 'implement'] as const) expect(buildSoftwareAgentTools(project.project_id, role, policy).some(t => t.name === 'prepare_software_capability')).toBe(false)
})

it.each(['.venv', process.platform === 'win32' ? '.venv/Scripts' : '.venv/bin', process.platform === 'win32' ? '.venv/Lib/site-packages' : '.venv/lib'])('rejects redirected environment path %s before execution', async path => {
  const target = join(project.root_path, path), outside = join(home, 'outside-project')
  mkdirSync(outside); writeFileSync(join(outside, 'keep.txt'), 'unchanged')
  rmSync(target, { recursive: true, force: true }); mkdirSync(join(target, '..'), { recursive: true })
  symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir')
  const result = await prepare()
  expect(result.isError).toBe(true); expect(result.output).toContain('CAPABILITY_VENV_LINK_UNSUPPORTED')
  expect(executeSoftwareCommand).not.toHaveBeenCalled(); expect(runHostSpeechProbe).not.toHaveBeenCalled()
  expect(speechCapabilityBinding(project.project_id)).toBeUndefined()
  expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('unchanged')
})

it('rechecks environment links after an awaited command before any subsequent install', async () => {
  vi.mocked(executeSoftwareCommand).mockImplementationOnce(async () => {
    const scripts = join(project.root_path, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin'), outside = join(home, 'redirect-after-probe')
    mkdirSync(outside); rmSync(scripts, { recursive: true, force: true })
    symlinkSync(outside, scripts, process.platform === 'win32' ? 'junction' : 'dir')
    return { code: 0, stdout: JSON.stringify({ ...imported, packages: {} }), stderr: '' }
  })
  const result = await tools().find(t => t.name === 'prepare_software_capability')!.execute({ capability: 'speech' }, context())
  expect(result.isError).toBe(true); expect(result.output).toContain('CAPABILITY_VENV_LINK_UNSUPPORTED')
  expect(executeSoftwareCommand).toHaveBeenCalledTimes(1); expect(runHostSpeechProbe).not.toHaveBeenCalled()
  expect(speechCapabilityBinding(project.project_id)).toBeUndefined()
})

it('stops after an awaited probe is cancelled, without installing packages, components or a binding', async () => {
  const controller = new AbortController()
  vi.mocked(executeSoftwareCommand).mockImplementationOnce(async () => {
    controller.abort(); return { code: 0, stdout: JSON.stringify({ ...imported, packages: {} }), stderr: '' }
  })
  const result = await tools().find(t => t.name === 'prepare_software_capability')!.execute({ capability: 'speech' }, context(parent, controller.signal))
  expect(result.isError).toBe(true); expect(executeSoftwareCommand).toHaveBeenCalledTimes(1)
  expect(runHostSpeechProbe).not.toHaveBeenCalled(); expect(speechCapabilityBinding(project.project_id)).toBeUndefined()
  expect(SPEECH_COMPONENTS.some(name => existsSync(join(project.root_path, name)))).toBe(false)
})
