import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

function json(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return
  if (statSync(file).size > 2 * 1024 * 1024) throw Error('DEPENDENCY_MANIFEST_TOO_LARGE')
  const value = JSON.parse(readFileSync(file, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('DEPENDENCY_MANIFEST_INVALID')
  return value
}

/** Presence is an installation diagnostic, never a dependency/behaviour PASS.
 * Read metadata only; do not load project packages or run their lifecycle code. */
export function inspectProjectDependencies(root: string) {
  try {
    const manifest = json(join(root, 'package.json'))
    if (!manifest) return { state: 'not_declared' as const }
    for (const key of ['dependencies', 'devDependencies']) {
      const value = manifest[key]
      if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw Error('DEPENDENCY_MANIFEST_INVALID')
    }
    const declared = { ...(manifest.dependencies as Record<string, unknown> ?? {}), ...(manifest.devDependencies as Record<string, unknown> ?? {}) }
    const names = Object.keys(declared).sort()
    if (names.some(name => !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name) || name.split('/').some(x => x === '.' || x === '..') || typeof declared[name] !== 'string')) throw Error('DEPENDENCY_MANIFEST_INVALID')
    if (names.length > 1000) throw Error('DEPENDENCY_MANIFEST_TOO_LARGE')
    const missing: string[] = [], invalid: string[] = []
    for (const name of names) {
      try { if (!json(join(root, 'node_modules', name, 'package.json'))) missing.push(name) }
      catch { invalid.push(name) }
    }
    const electronDeclared = names.includes('electron')
    let electron: { state: string; version?: string; next?: string } | undefined
    if (electronDeclared) {
      const installed = !missing.includes('electron') && !invalid.includes('electron')
      const executable = join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
      const present = installed && existsSync(executable) && statSync(executable).isFile()
      electron = { state: present ? 'binary_present_unverified' : installed ? 'binary_missing' : 'package_missing',
        ...(installed ? { version: String(json(join(root, 'node_modules/electron/package.json'))?.version ?? '') } : {}),
        ...(!present ? { next: installed ? 'npm包已存在但Electron二进制未就绪；先检查安装日志、缓存和下载连接，仅恢复该包安装，不重复整包安装。' : '按项目锁文件安装依赖；安装退出码不代表Electron二进制已就绪。' } : {}) }
    }
    return { state: missing.length || invalid.length ? 'packages_incomplete' : 'metadata_present_unverified', declared: names.length,
      missing: missing.slice(0, 20), missing_count: missing.length, invalid: invalid.slice(0, 20), invalid_count: invalid.length, electron,
      verification: '仅元数据与二进制存在性；不证明版本兼容、依赖完整或程序可运行。' }
  } catch (error) { return { state: 'invalid_manifest' as const,
    error: error instanceof Error && error.message.startsWith('DEPENDENCY_') ? error.message : 'DEPENDENCY_MANIFEST_INVALID' } }
}

export function isDependencySetup(command: unknown): boolean {
  if (!Array.isArray(command) || !command.every(x => typeof x === 'string')) return false
  const name = basename(command[0] ?? '').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()
  return name === 'npm' && ['install', 'i', 'ci'].includes(command[1])
    || name === 'node' && /(?:^|[\\/])node_modules[\\/]electron[\\/]install\.js$/.test(command[1] ?? '')
}

export function dependencyInputVersion(root: string, command: unknown): string {
  const hash = createHash('sha256').update(JSON.stringify(command))
  for (const name of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json']) {
    const file = join(resolve(root), name)
    if (existsSync(file)) hash.update(name).update(readFileSync(file))
  }
  return hash.digest('hex')
}

export function dependencyFailureCode(kind: string, output: string): string {
  if (/EACCES|EPERM/.test(output)) return 'DEPENDENCY_PERMISSION_ERROR'
  if (/EINTEGRITY|checksum.*mismatch/i.test(output)) return 'DEPENDENCY_INTEGRITY_ERROR'
  if (/ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ECONNREFUSED|CERT_|certificate/i.test(output)) return 'DEPENDENCY_DOWNLOAD_ERROR'
  return kind === 'timeout' ? 'DEPENDENCY_INSTALL_TIMEOUT' : 'DEPENDENCY_INSTALL_FAILED'
}
