import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { createRequire } from 'node:module'
import { buildDriverEnv, execFileDriverSpawn, resolveDriverVenvCommand } from '../desktop/process-driver'
import { managedRuntime, managedRuntimeDirectories } from './runtime-bindings'

/** Project execution policy, NOT an OS sandbox. Arguments are passed directly;
 * Windows package-manager shims are resolved to their Node entry, never cmd /c. */
export function projectDirectory(root: string, requested = '.'): string {
  const base = realpathSync(root), target = realpathSync(resolve(base, requested))
  const rel = relative(base, target)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('COMMAND_CWD_OUTSIDE_PROJECT')
  return target
}

export function validateSoftwareCommand(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 128 || value.some(x => typeof x !== 'string' || x.includes('\0'))
    || value.join('').length > 64000 || !value[0].trim()) throw new Error('COMMAND_INVALID_ARGUMENTS')
  const command = value as string[], name = basename(command[0]).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()
  if (/[|&<>\r\n]/.test(command[0])) throw new Error('COMMAND_EXECUTABLE_REQUIRED')
  if (['sudo', 'runas', 'format', 'diskpart', 'reg', 'regedit', 'shutdown', 'reboot', 'bcdedit', 'msiexec', 'schtasks'].includes(name)
    || name === 'git' && ['push', 'clean'].includes(command[1]?.toLowerCase())
    || ['npm', 'pnpm', 'yarn'].includes(name) && (command.some(x => ['--global', '-g'].includes(x)) || ['publish', 'login', 'logout', 'config', 'unpublish'].includes(command[1]?.toLowerCase()))
    || ['cmd', 'powershell', 'pwsh', 'sh', 'bash'].includes(name) && /(?:Remove-Item|Remove-Computer|Set-ExecutionPolicy|Invoke-WebRequest.+\|\s*(?:iex|Invoke-Expression)|\brm\s+-rf|\bdel\s+\/[sq])/i.test(command.join(' '))) {
    throw new Error('COMMAND_REQUIRES_SEPARATE_AUTHORIZATION: 系统修改、外发发布或破坏性清理不属于普通项目构建')
  }
  return [...command]
}

function pathExecutable(name: string): string | undefined {
  if (isAbsolute(name)) return existsSync(name) ? name : undefined
  try {
    if (process.platform === 'win32') return execFileSync('where.exe', [name], { encoding: 'utf8', windowsHide: true, timeout: 3000 })
      .split(/\r?\n/).find(file => file.trim() && existsSync(file.trim()))?.trim()
    for (const directory of (process.env.PATH ?? '').split(':')) {
      const file = join(directory, name); if (existsSync(file)) return file
    }
  } catch { /* a missing tool is reported before execution */ }
  return undefined
}

export function softwareEnvironment(projectId: string, dataDir?: string): Record<string, string> {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error('ENVIRONMENT_PROJECT_ID_INVALID')
  const toolsHome = join(getPromaHome(), 'software-environments', projectId)
  const home = dataDir ? join(dirname(dataDir), 'environment-home') : toolsHome
  for (const directory of [home, join(home, 'appdata'), join(home, 'localappdata'), dataDir ?? join(home, 'test-data')]) mkdirSync(directory, { recursive: true })
  const clean = buildDriverEnv({ env_whitelist: [] } as never, process.env), directories = managedRuntimeDirectories(projectId)
  return { ...clean, ...(directories.length ? { PATH: [...directories, clean.PATH ?? clean.Path ?? ''].join(process.platform === 'win32' ? ';' : ':') } : {}),
    BLOMA_RUNTIME_PROJECT: projectId,
    HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'),
    APP_DATA_DIR: dataDir ?? join(home, 'test-data'), BROWSER: 'none', CI: '1',
    npm_config_cache: join(toolsHome, 'npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false',
    PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1', PYTHONDONTWRITEBYTECODE: '1' }
}

export function resolveSoftwareCommand(root: string, value: unknown, environment: Record<string, string>): { command: string[]; env: Record<string, string> } {
  let command = validateSoftwareCommand(value)
  const name = basename(command[0]).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()
  const env = { ...environment }
  const runtimeProject = environment.BLOMA_RUNTIME_PROJECT
  const node = runtimeProject ? managedRuntime(runtimeProject, 'node')?.executable : undefined
  if (['python', 'python3'].includes(name)) {
    const original = command[0]
    command = resolveDriverVenvCommand(command, root)
    if (command[0] === original && ['python', 'python3'].includes(original) && runtimeProject) command[0] = managedRuntime(runtimeProject, 'python')?.executable ?? pathExecutable(original) ?? command[0]
  }
  if (name === 'node') {
    const executable = (command[0] === 'node' ? node : undefined) ?? pathExecutable(command[0]) ?? (command[0] === 'node' ? process.execPath : undefined)
    if (!executable) throw new Error('COMMAND_NODE_UNAVAILABLE')
    command[0] = executable
    if (process.versions.electron && executable === process.execPath) env.ELECTRON_RUN_AS_NODE = '1'
  } else if (['npm', 'npx'].includes(name)) {
    let script: string | undefined
    try { script = join(dirname(createRequire(import.meta.url).resolve('npm/package.json')), 'bin', name === 'npm' ? 'npm-cli.js' : 'npx-cli.js') } catch {}
    if (!script || !existsSync(script)) throw new Error('BUNDLED_NPM_UNAVAILABLE: 当前Bloma安装缺少开发工具，请修复运行包')
    const executable = node ?? pathExecutable('node') ?? process.execPath
    command = [executable, script, ...command.slice(1)]
    if (process.versions.electron && executable === process.execPath) env.ELECTRON_RUN_AS_NODE = '1'
  } else if (process.platform === 'win32' && ['pnpm', 'yarn'].includes(name)) {
    const shim = pathExecutable(command[0])
    if (!shim) throw new Error(`COMMAND_PACKAGE_MANAGER_UNAVAILABLE: ${name}`)
    const entry = { npm: 'npm/bin/npm-cli.js', npx: 'npm/bin/npx-cli.js', pnpm: 'pnpm/bin/pnpm.cjs', yarn: 'yarn/bin/yarn.js' }[name]!
    const candidates = [join(dirname(shim), 'node_modules', entry), join(dirname(shim), '..', 'lib', 'node_modules', entry)]
    const script = candidates.find(existsSync)
    if (!script) throw new Error(`COMMAND_PACKAGE_MANAGER_ENTRY_UNAVAILABLE: ${name}；可用node直接执行已安装的包管理器入口`)
    const executable = node ?? pathExecutable('node') ?? process.execPath
    command = [executable, script, ...command.slice(1)]
    if (process.versions.electron && executable === process.execPath) env.ELECTRON_RUN_AS_NODE = '1'
  } else if (command[0].includes('/') || command[0].includes('\\')) {
    const candidate = resolve(root, command[0])
    if (!existsSync(candidate)) throw new Error('COMMAND_EXECUTABLE_MISSING')
    command[0] = realpathSync(candidate)
  }
  if (/\.(?:bat|cmd)$/i.test(command[0])) throw new Error('COMMAND_USE_EXECUTABLE_OR_NODE_ENTRY: 不通过隐式cmd执行脚本')
  return { command, env }
}

export async function executeSoftwareCommand(input: { root: string; projectId: string; command: unknown; cwd?: string; timeoutMs?: number; signal?: AbortSignal; dataDir?: string }) {
  input.signal?.throwIfAborted()
  const cwd = projectDirectory(input.root, input.cwd)
  const resolved = resolveSoftwareCommand(input.root, input.command, softwareEnvironment(input.projectId, input.dataDir))
  const timeoutMs = input.timeoutMs ?? 120000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw new Error('COMMAND_TIMEOUT_INVALID')
  return execFileDriverSpawn({ ...resolved, cwd, timeoutMs, signal: input.signal })
}
