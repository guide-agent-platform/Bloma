import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

export function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/**
 * 原子写（全链路审查 P1-3 修复，2026-10-01）：tmp 写入 + rename 原子替换。
 * 旧 writeFileSync 直接覆盖在写入瞬间崩溃/断电会留半截 JSON——会话索引
 * （bloma-agent-sessions.json）损坏后 readSessions 每次抛 SyntaxError，
 * listSessions/loadMessages/runAgent 全链瘫痪且无自愈。tmp+rename 保证任意
 * 时刻磁盘上要么是完整旧文件、要么是完整新文件。rename 失败（个别杀毒/句柄
 * 竞争场景 EPERM）回退直接写——保底语义等同旧行为，不比旧世界更差。
 */
export function writeJsonFile(path: string, value: unknown): void {
  const payload = `${JSON.stringify(value, null, 2)}\n`
  mkdirSync(dirname(path), { recursive: true })
  const tmpPath = join(dirname(path), `.${basenameOf(path)}.tmp-${randomBytes(4).toString('hex')}`)
  try {
    writeFileSync(tmpPath, payload, 'utf8')
    renameSync(tmpPath, path)
  } catch {
    try {
      writeFileSync(path, payload, 'utf8')
    } finally {
      try {
        if (existsSync(tmpPath)) renameSync(tmpPath, `${tmpPath}.abandoned`)
      } catch {
        /* 清理失败不影响主流程（tmp 在同目录，随目录清理） */
      }
    }
  }
}

function basenameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return idx >= 0 ? path.slice(idx + 1) : path
}

export function appendJsonLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf8')
}
