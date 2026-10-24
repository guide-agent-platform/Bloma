import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { importSoftwareProject, importedProjectContext } from '../../../main/software/import-project'
import { executeSoftwareCommand } from '../../../main/software/command-runtime'
import { deleteProject } from '../../../main/project/project-service'

let home: string, previous: string | undefined, source: string
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-import-test-')); process.env.PROMA_HOME = join(home, 'host'); source = join(home, 'original'); mkdirSync(source) })
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
const git = (...args: string[]) => execFileSync('git', args, { cwd: source, windowsHide: true, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim()
it('imports an existing dirty Git repository, fixes a cross-module defect in the copy and leaves original content/index/branch intact even after project deletion', async () => {
  git('init', '-b', 'main'); mkdirSync(join(source, 'lib'))
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'existing-project', scripts: { test: 'node test.cjs' } }))
  writeFileSync(join(source, 'lib/math.cjs'), 'exports.add=(a,b)=>a+b+1')
  writeFileSync(join(source, 'app.cjs'), 'exports.result=require("./lib/math.cjs").add(2,3)')
  writeFileSync(join(source, 'test.cjs'), 'require("node:assert/strict").equal(require("./app.cjs").result,5)')
  writeFileSync(join(source, 'README.md'), 'initial README')
  git('add', '.'); git('-c', 'user.name=Test User', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial real repository')
  writeFileSync(join(source, 'README.md'), 'user staged work'); git('add', 'README.md')
  writeFileSync(join(source, 'README.md'), 'user staged work plus unstaged addition'); writeFileSync(join(source, 'user-work.txt'), 'untracked user work')
  mkdirSync(join(source, 'node_modules')); writeFileSync(join(source, 'node_modules/ignored-runtime.js'), 'do not copy development dependencies')
  const status = git('status', '--porcelain=v1'), head = git('rev-parse', 'HEAD'), index = readFileSync(join(source, '.git/index'))
  const project = await importSoftwareProject(source, 'longterm'), copied = project.root_path
  expect(project.imported_source).toMatchObject({ path: source, branch: 'main', head, dirty: true })
  expect(readFileSync(join(copied, 'README.md'), 'utf8')).toBe('user staged work plus unstaged addition')
  expect(readFileSync(join(copied, 'user-work.txt'), 'utf8')).toBe('untracked user work')
  expect(existsSync(join(copied, 'node_modules'))).toBe(false)
  expect(importedProjectContext(project.project_id)).toMatchObject({ existing_project: true, user_dirty: true })
  const before = await executeSoftwareCommand({ projectId: project.project_id, root: copied, command: ['npm', 'test'] })
  expect(before.code).not.toBe(0)
  writeFileSync(join(copied, 'lib/math.cjs'), 'exports.add=(a,b)=>a+b')
  const after = await executeSoftwareCommand({ projectId: project.project_id, root: copied, command: ['npm', 'test'] })
  expect(after.code, after.stderr).toBe(0)
  expect(git('status', '--porcelain=v1')).toBe(status); expect(git('rev-parse', 'HEAD')).toBe(head)
  expect(readFileSync(join(source, '.git/index')).equals(index)).toBe(true)
  expect(readFileSync(join(source, 'lib/math.cjs'), 'utf8')).toContain('a+b+1')
  deleteProject({ request_id: 'd', project_id: project.project_id })
  expect(existsSync(join(source, 'README.md'))).toBe(true); expect(git('branch', '--show-current')).toBe('main')
}, 90000)
it('imports an ordinary directory without adding a template, and rejects a source containing the managed destination', async () => {
  writeFileSync(join(source, 'existing.py'), 'print("existing file")')
  const project = await importSoftwareProject(source, 'quick')
  expect(readFileSync(join(project.root_path, 'existing.py'), 'utf8')).toContain('existing file')
  expect(existsSync(join(project.root_path, 'app.py'))).toBe(false)
  await expect(importSoftwareProject(home, 'quick')).rejects.toThrow('IMPORT_SOURCE_CONTAINS_DESTINATION')
  mkdirSync(join(source, '.git'))
  await expect(importSoftwareProject(source, 'quick')).rejects.toThrow('IMPORT_GIT_METADATA_UNAVAILABLE')
})
