import { existsSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'

export function isLocalElectronAlias(command: readonly string[]): boolean {
  const name = basename(command[0] ?? '').replace(/\.(cmd|exe|bat)$/i, '').toLowerCase()
  return name === 'npx' && (command[1] === 'electron' || command[1] === '--no-install' && command[2] === 'electron')
}

/** Resolve local aliases without executing npx, downloading a runtime, or
 * treating the packaged Bloma executable as a generic Electron runtime. */
export function electronEntry(root: string, command: readonly string[]): { executablePath: string; args: string[] } {
  let [head, ...args] = command
  const wrapper = basename(head ?? '').replace(/\.(cmd|exe|bat)$/i, '').toLowerCase()
  if (wrapper === 'npx') {
    if (!isLocalElectronAlias(command)) throw Error('ELECTRON_DIRECT_ENTRY_REQUIRED: 仅支持本地npx electron入口；带版本或复杂包装命令请声明实际Electron可执行文件。')
    if (args[0] === '--no-install') args = args.slice(1)
    head = 'electron'; args = args.slice(1)
  } else if (['npm', 'pnpm', 'yarn'].includes(wrapper)) {
    throw Error('ELECTRON_DIRECT_ENTRY_REQUIRED: 不解析任意包管理器脚本；LAUNCH.command填写项目Electron与实际应用路径，或已打包exe。')
  }
  if (!head) throw Error('ELECTRON_DIRECT_ENTRY_REQUIRED: 缺少实际应用入口')
  if (head === 'electron') head = join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
  const executablePath = isAbsolute(head) ? head : resolve(root, head)
  if (!existsSync(executablePath)) throw Error(existsSync(join(root, 'node_modules/electron/package.json'))
    ? 'ELECTRON_EXECUTABLE_MISSING: Electron npm包已存在，但声明的二进制入口缺失；检查入口路径与该包安装日志，只恢复缺失部分。'
    : 'ELECTRON_EXECUTABLE_MISSING: 声明的入口不存在；检查工程依赖是否安装，或使用实际打包入口。')
  if (!args.length && basename(executablePath).toLowerCase() === 'electron.exe') args = ['.']
  return { executablePath, args }
}
