import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { renameWithRetry } from './fs-retry'

export function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/**
 * JSON 与文本共用同一原子替换边界。句柄竞争重试耗尽时保留旧索引并上抛，
 * 不直接截断项目、会话或渠道文件，也不留下另一套临时文件恢复语义。
 */
export function writeJsonFile(path: string, value: unknown): void {
  writeTextFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

function basenameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return idx >= 0 ? path.slice(idx + 1) : path
}

export function appendJsonLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf8')
}

/**
 * 文本原子写：参考本地 Proma bf3e98c safe-file.ts，独占随机临时文件后 rename。
 * Windows 短暂句柄竞争沿用平台退避（最多 750ms）；耗尽或真实权限拒绝时
 * 保留原文件并上抛，不回退直接覆盖（设置不能半写后假报保存成功）。
 */
export function writeTextFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmpPath = join(dirname(path), `.${basenameOf(path)}.tmp-${randomBytes(12).toString('hex')}`)
  let descriptor: number | undefined
  let created = false
  try {
    descriptor = openSync(tmpPath, 'wx', 0o600)
    created = true
    writeFileSync(descriptor, content, 'utf8')
    closeSync(descriptor)
    descriptor = undefined
    renameWithRetry(tmpPath, path)
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* 不掩盖原写入错误 */ }
    }
    if (created) {
      try { unlinkSync(tmpPath) } catch { /* 已 rename 或清理失败，不影响原始结果 */ }
    }
  }
}
