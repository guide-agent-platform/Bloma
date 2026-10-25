import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { softwareVerificationFingerprint } from '../../../main/desktop/verification-fingerprint'
import { saveSourceCheckpoint, restoreSourceFiles, sourceCheckpointChanges } from '../../../main/software/source-checkpoints'
import { debugWorkspace } from '../../../main/software/debug-workspace'
let home: string, previous: string | undefined, project: ReturnType<typeof createProject>
beforeEach(() => {
  previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-source-checkpoint-')); process.env.PROMA_HOME = home
  project = createProject({ request_id: 'create', mode: 'longterm' }, { workflowVersion: 'software-v1' })
  writeFileSync(join(project.root_path, 'index.html'), '<h1>Observed</h1>')
  writeFileSync(join(project.root_path, 'app.js'), 'console.log("observed")')
  mkdirSync(join(project.root_path, 'data')); writeFileSync(join(project.root_path, 'data', 'user.json'), '{"notes":"user value"}')
})
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
const version = () => softwareVerificationFingerprint(project.root_path)!
it('recovers the exact selected code files, archives overwritten bytes, and retains data and added files', () => {
  const source = version(), saved = saveSourceCheckpoint(project.project_id, 's', project.root_path, source)
  expect(saved.id).toBe(source)
  writeFileSync(join(project.root_path, 'index.html'), '<h1>Half changed</h1>')
  writeFileSync(join(project.root_path, 'extra.js'), 'new unselected work')
  writeFileSync(join(project.root_path, 'data', 'user.json'), '{"notes":"new user value"}')
  const before = version(), changes = sourceCheckpointChanges(project.project_id, 's', project.root_path, source)
  expect(changes.changes).toEqual(expect.arrayContaining([{ path: 'index.html', kind: 'modified' }, { path: 'extra.js', kind: 'added' }]))
  const result = restoreSourceFiles(project.project_id, 's', project.root_path, source, before, ['index.html'])
  expect(result).toMatchObject({ restored: ['index.html'], verification: 'not_run', complete_source_match: false })
  expect(readFileSync(join(project.root_path, 'index.html'), 'utf8')).toBe('<h1>Observed</h1>')
  expect(readFileSync(join(project.root_path, 'extra.js'), 'utf8')).toBe('new unselected work')
  expect(readFileSync(join(project.root_path, 'data', 'user.json'), 'utf8')).toContain('new user value')
  expect(readFileSync(join(result.backup, '0.blob'), 'utf8')).toBe('<h1>Half changed</h1>')
  expect(JSON.parse(readFileSync(join(result.backup, 'restore.json'), 'utf8')).state).toBe('complete')
})
it('rejects concurrent changes, foreign scope, invalid paths and corrupt backup content before touching source', () => {
  const source = version(); saveSourceCheckpoint(project.project_id, 's', project.root_path, source)
  writeFileSync(join(project.root_path, 'index.html'), 'current edit')
  expect(() => restoreSourceFiles(project.project_id, 's', project.root_path, source, source, ['index.html'])).toThrow('CURRENT_CHANGED')
  const current = version()
  expect(() => restoreSourceFiles(project.project_id, 'foreign', project.root_path, source, current, ['index.html'])).toThrow()
  expect(() => restoreSourceFiles(project.project_id, 's', project.root_path, source, current, ['../outside.js'])).toThrow()
  expect(() => restoreSourceFiles(project.project_id, 's', project.root_path, source, current, ['data/user.json'])).toThrow('NOT_IN_CHECKPOINT')
  const base = join(debugWorkspace(project.project_id, 's'), 'source-checkpoints'), metadata = JSON.parse(readFileSync(join(base, source + '.json'), 'utf8'))
  const entry = metadata.files.find((file: { path: string }) => file.path === 'index.html')
  writeFileSync(join(base, entry.hash + '.blob'), 'tampered')
  expect(() => restoreSourceFiles(project.project_id, 's', project.root_path, source, current, ['index.html'])).toThrow('BLOB_CHANGED')
  expect(readFileSync(join(project.root_path, 'index.html'), 'utf8')).toBe('current edit')
})
it('rolls back already replaced files when a later write fails, while preserving the failure archive', () => {
  const source = version(); saveSourceCheckpoint(project.project_id, 's', project.root_path, source)
  writeFileSync(join(project.root_path, 'index.html'), 'partial html'); writeFileSync(join(project.root_path, 'app.js'), 'partial js')
  const current = version(); let calls = 0
  expect(() => restoreSourceFiles(project.project_id, 's', project.root_path, source, current, ['index.html', 'app.js'], {
    replace(file, bytes) { if (++calls === 2) throw Error('simulated second-file lock'); writeFileSync(file, bytes) },
  })).toThrow('SOURCE_RESTORE_FAILED')
  expect(readFileSync(join(project.root_path, 'index.html'), 'utf8')).toBe('partial html')
  expect(readFileSync(join(project.root_path, 'app.js'), 'utf8')).toBe('partial js')
  expect(version()).toBe(current)
})
it('refuses linked project inputs without reading or changing their destination', () => {
  const outside = join(home, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'secret.js'), 'untouched')
  symlinkSync(outside, join(project.root_path, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => saveSourceCheckpoint(project.project_id, 's', project.root_path, 'a'.repeat(64))).toThrow('STALE')
  expect(readFileSync(join(outside, 'secret.js'), 'utf8')).toBe('untouched')
  expect(existsSync(join(outside, '.git'))).toBe(false)
})
