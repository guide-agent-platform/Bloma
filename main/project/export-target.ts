import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

/** 名称只生成一个 Windows 可用的子目录段；显示名与稳定项目根不变。 */
export function sanitizeExportFolderName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().replace(/[. ]+$/g, '')
  if (!cleaned) return '未命名项目'
  // Windows 设备名即使带扩展名也不能用作普通目录。
  return /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(cleaned) ? `项目-${cleaned}` : cleaned
}

/**
 * 导出目标必须是用户选定目录的子目录。参考本地 Proma bf3e98c
 * project-instruction-resolver.ts 的 relative + realpath 校验，适配为输出目录。
 */
export function resolveProjectExportTarget(destination: string, name: string): string {
  const root = resolve(destination)
  const target = join(root, sanitizeExportFolderName(name))
  const assertChild = (parent: string, child: string): void => {
    const rel = relative(parent, child)
    if (!rel || rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../') || isAbsolute(rel)) {
      throw new Error('VALIDATION_ERROR: project export target must stay inside the selected directory')
    }
  }
  assertChild(root, target)
  assertExportPathNotLink(target)
  if (existsSync(target)) {
    assertChild(realpathSync(root), realpathSync(target))
  }
  return target
}

/** 已有导出包中的链接也不能让递归复制写入包外（目录 junction 与文件 symlink 均拒绝）。 */
export function assertExportPathNotLink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error('VALIDATION_ERROR: project export must not overwrite a symbolic link')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}
