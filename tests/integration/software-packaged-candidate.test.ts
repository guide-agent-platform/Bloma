import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { createProject } from '../../main/project/project-service'
import { parseGuiSuite } from '../../main/desktop/gui-acceptance'
import { prepareSoftwareRelease, validateSoftwareRelease } from '../../main/software/release-store'
import { observeSoftwareGui } from '../../main/software/gui-observer'
import { qualifySoftwareArtifact } from '../../main/software/artifact-qualification'
import { readPrdBackplane } from '../../main/project/prd-store'

const source = process.env.SOFTWARE_PACKAGED_FIXTURE
const enabled = Boolean(source && existsSync(join(source, 'Calculator.exe'))) && process.platform === 'win32'
let home: string, previous: string | undefined, project: ReturnType<typeof createProject>
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-package-')); process.env.PROMA_HOME = home;
  project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' }) })
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous;
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }) }, 30000)
it.skipIf(!enabled)('executes a relocated actual packaged calculator, binds packaged resources, and keeps clean-machine qualification unverified', async () => {
  const root = project.root_path, packaged = join(root, 'product')
  cpSync(source!, packaged, { recursive: true })
  writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, command: ['product/Calculator.exe'], artifact: 'product/Calculator.exe', ui: 'electron', window_title: '计算器' }))
  const release = await prepareSoftwareRelease(project.project_id, root)
  expect(release.external_files).toEqual([]); expect(existsSync(join(release.root, 'node_modules'))).toBe(false)
  const temporary = join(home, 'observer'); mkdirSync(temporary)
  const suite = parseGuiSuite({ version: 1, scope_hash: 'f'.repeat(64), covers: ['F-001'], steps: [
    { id: 'two', kind: 'click', selector: '#key-2' }, { id: 'plus', kind: 'click', selector: '#key-plus' }, { id: 'three', kind: 'click', selector: '#key-3' },
    { id: 'equals', kind: 'click', selector: '#key-equals' }, { id: 'answer', kind: 'expect', selector: '#result', equals: '5' } ] })
  const result = await observeSoftwareGui({ projectId: project.project_id, root: release.root, launch: release.launch, suite, temporary, signal: AbortSignal.timeout(60000) })
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'passed' })
  const brief = readPrdBackplane(project.project_id); brief.lean_brief = { version: 1, ui: 'required', distribution: 'portable', source_session_id: 's', source_sha256: '' }
  const qualification = await qualifySoftwareArtifact(release.root, brief)
  expect(qualification).toMatchObject({ kind: 'portable_candidate', status: 'environment_blocked', clean_environment: 'unverified' })
  const resource = join(release.root, 'product/resources/app/renderer/index.html'), original = readFileSync(resource, 'utf8')
  writeFileSync(resource, original + '\n<!-- changed packaged resource -->')
  await expect(validateSoftwareRelease(project.project_id, release)).rejects.toThrow('RELEASE_BYTES_CHANGED')
  mkdirSync(join(process.cwd(), 'run-artifacts'), { recursive: true })
  writeFileSync(join(process.cwd(), 'run-artifacts/software-packaged-candidate-acceptance.json'), JSON.stringify({ entry: 'relocated Calculator.exe', gui: result, qualification, runtime_files: release.runtime.files.length,
    boundary: '同一开发机上的实际成品迁移验证；不是干净机器、安装升级或跨机器验收。原历史项目只读，未更新其交付标志。' }, null, 2))
}, 180000)
