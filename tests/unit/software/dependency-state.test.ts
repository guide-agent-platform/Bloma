import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { dependencyFailureCode, dependencyInputVersion, inspectProjectDependencies, isDependencySetup } from '../../../main/software/dependency-state'
import { electronEntry } from '../../../main/software/electron-entry'

const roots: string[] = []
function fixture() { const root = mkdtempSync(join(tmpdir(), 'bloma-deps-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function electron(root: string) {
  const base = join(root, 'node_modules/electron'); mkdirSync(base, { recursive: true }); writeFileSync(join(base, 'package.json'), '{"name":"electron","version":"32.3.3"}')
  return join(base, 'dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
}
it('distinguishes missing packages, partial Electron install and present but unverified binary', () => {
  const root = fixture(); writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { electron: '^32.0.0' } }))
  expect(inspectProjectDependencies(root).electron?.state).toBe('package_missing')
  const exe = electron(root)
  expect(inspectProjectDependencies(root)).toMatchObject({ state: 'metadata_present_unverified', electron: { state: 'binary_missing', version: '32.3.3' } })
  mkdirSync(join(exe, '..'), { recursive: true }); writeFileSync(exe, 'not a runnable binary')
  expect(inspectProjectDependencies(root).electron?.state).toBe('binary_present_unverified')
})
it('reports invalid manifests and invalid installed metadata without running package code', () => {
  const root = fixture(); writeFileSync(join(root, 'package.json'), '{broken')
  expect(inspectProjectDependencies(root).state).toBe('invalid_manifest')
  writeFileSync(join(root, 'package.json'), '{"dependencies":"not-an-object"}')
  expect(inspectProjectDependencies(root).state).toBe('invalid_manifest')
  writeFileSync(join(root, 'package.json'), '{"dependencies":{"fixture":"1"}}'); mkdirSync(join(root, 'node_modules/fixture'), { recursive: true })
  writeFileSync(join(root, 'node_modules/fixture/package.json'), '{broken')
  expect(inspectProjectDependencies(root)).toMatchObject({ invalid: ['fixture'], invalid_count: 1 })
})
it('does not mistake arbitrary scripts for install; identities include manifest and lock changes', () => {
  const root = fixture(); writeFileSync(join(root, 'package.json'), '{}')
  expect(isDependencySetup(['npm', 'ci'])).toBe(true)
  expect(isDependencySetup(['node', 'node_modules/electron/install.js'])).toBe(true)
  expect(isDependencySetup(['npm', 'run', 'install-custom'])).toBe(false)
  expect(isDependencySetup(['node', '-e', 'anything'])).toBe(false)
  const before = dependencyInputVersion(root, ['npm', 'ci']); writeFileSync(join(root, 'package-lock.json'), '{"version":1}')
  expect(dependencyInputVersion(root, ['npm', 'ci'])).not.toBe(before)
  expect(dependencyFailureCode('timeout', 'ETIMEDOUT download')).toBe('DEPENDENCY_DOWNLOAD_ERROR')
  expect(dependencyFailureCode('timeout', '')).toBe('DEPENDENCY_INSTALL_TIMEOUT')
})
it('resolves only exact local Electron aliases without invoking npx or downloading', () => {
  const root = fixture(), exe = electron(root); mkdirSync(join(exe, '..'), { recursive: true }); writeFileSync(exe, 'fixture')
  expect(electronEntry(root, ['npx', 'electron', '.'])).toEqual({ executablePath: exe, args: ['.'] })
  expect(electronEntry(root, ['npx', '--no-install', 'electron', 'main.cjs']).args).toEqual(['main.cjs'])
  expect(() => electronEntry(root, ['npx', 'electron@999', '.'])).toThrow('ELECTRON_DIRECT_ENTRY_REQUIRED')
  expect(() => electronEntry(root, ['npm', 'start'])).toThrow('ELECTRON_DIRECT_ENTRY_REQUIRED')
})
it('explains a partial install rather than claiming all dependencies are missing', () => {
  const root = fixture(); electron(root)
  expect(() => electronEntry(root, ['electron', '.'])).toThrow('npm包已存在')
})
