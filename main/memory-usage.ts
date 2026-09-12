import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getPromaHome } from '../storage/config-paths'
import { fingerprintMemoryText } from './memory-revocation'

/**
 * 记忆使用埋点 sidecar（2026-09-12 记忆栈审计裁定 S-2；与撤销名单**分文件**）。
 *
 * 作用：给「记忆可见性 UI」（下一批）提供 `last_used_at` —— 每条记忆**最后一次被注入**的时间与次数。
 *
 * 关键设计（与裁定一致）：
 * - **只存归一化指纹，不存原文**（与撤销名单同一身份口径：`fingerprintMemoryText`）——
 *   sidecar 本身不得成为第二份记忆副本；
 * - 与 `bloma-revocation-index.json` **分文件**：撤销名单是低频写的安全机制，本件是高频写的
 *   UI 元数据；同文件会让高频写放大安全机制的损坏概率（详见 revocation-and-cross-session.md §3）；
 * - **防抖落盘**（1s，参照 project-map.ts 的 1s 防抖）：注入渲染每轮调用，写盘合并；
 * - **fail-open**：本件只影响 UI 显示，损坏/丢失一律不阻断生成、也不影响注入（与撤销名单的
 *   fail-closed 语义相反，务必区分）；
 * - 删除范围：删除/撤销时应同时清理对应条目（`forgetMemoryUsage`），由删除入口一并调用
 *   （UI/IPC 入口落地时接线，见 revocation-and-cross-session.md §5）。
 */

export const USAGE_FILE = 'bloma-memory-usage.json'
/** 防抖窗口（与 project-map 的 REFRESH_DEBOUNCE_MS 同量级） */
export const USAGE_WRITE_DEBOUNCE_MS = 1000

interface UsageEntry {
  /** 最后一次被注入的 Unix ms */
  last_used_at: number
  /** 累计注入次数 */
  count: number
}

export interface UsageIndex {
  entries: Map<string, UsageEntry>
  /** false = 文件存在但损坏（UI 可提示"使用记录不可读"）；**不影响注入** */
  readable: boolean
}

export function getUsageIndexPath(): string {
  return join(getPromaHome(), USAGE_FILE)
}

function readEntries(path: string): { entries: Map<string, UsageEntry>; readable: boolean } {
  try {
    if (!existsSync(path)) return { entries: new Map(), readable: true }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { entries?: Record<string, UsageEntry> }
    const entries = new Map<string, UsageEntry>()
    for (const [fp, value] of Object.entries(parsed?.entries ?? {})) {
      if (!value || typeof value.last_used_at !== 'number') continue
      entries.set(fp, { last_used_at: value.last_used_at, count: typeof value.count === 'number' ? value.count : 1 })
    }
    return { entries, readable: true }
  } catch {
    return { entries: new Map(), readable: false }
  }
}

/** 读取使用记录（缺失 = 空且 readable；损坏 = readable=false，仍可写入重建）。 */
export function loadMemoryUsage(path: string = getUsageIndexPath()): UsageIndex {
  return readEntries(path)
}

/** 待写缓冲（进程内）；落盘后清空。 */
const pending = new Map<string, UsageEntry>()
let timer: ReturnType<typeof setTimeout> | null = null

/**
 * 记录"这些记忆本轮被注入"（入参是**原始/净化文本**，内部只存指纹）。
 * 防抖落盘；任何异常静默（UI 元数据不得影响生成与注入）。
 */
export function recordMemoryUsage(texts: string[], now: number = Date.now()): void {
  try {
    for (const text of texts) {
      if (!text) continue
      const fp = fingerprintMemoryText(text)
      const prev = pending.get(fp)
      pending.set(fp, { last_used_at: now, count: (prev?.count ?? 0) + 1 })
    }
    if (pending.size === 0) return
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      flushMemoryUsage()
    }, USAGE_WRITE_DEBOUNCE_MS)
    // 不因待写缓冲拖住进程退出（测试/短生命周期进程）
    if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref()
  } catch {
    // 静默：埋点失败不影响主链
  }
}

/** 立即落盘（测试、退出前收尾；返回是否成功）。 */
export function flushMemoryUsage(path: string = getUsageIndexPath()): boolean {
  try {
    if (pending.size === 0) return true
    const current = readEntries(path)
    const merged = current.entries
    for (const [fp, entry] of pending) {
      const prev = merged.get(fp)
      merged.set(fp, { last_used_at: entry.last_used_at, count: (prev?.count ?? 0) + entry.count })
    }
    mkdirSync(dirname(path), { recursive: true })
    const payload = { version: 1, updated_at: new Date().toISOString(), entries: Object.fromEntries(merged) }
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
    pending.clear()
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    return true
  } catch {
    return false
  }
}

/** 删除/撤销时清理对应条目的使用记录（进删除范围；由删除入口与 revokeMemoryText 一并调用）。 */
export function forgetMemoryUsage(texts: string[], path: string = getUsageIndexPath()): boolean {
  try {
    const current = readEntries(path)
    for (const text of texts) {
      const fp = fingerprintMemoryText(text)
      pending.delete(fp)
      current.entries.delete(fp)
    }
    mkdirSync(dirname(path), { recursive: true })
    const payload = { version: 1, updated_at: new Date().toISOString(), entries: Object.fromEntries(current.entries) }
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

/** 该记忆最后一次被注入的时间（无记录返回 undefined）。 */
export function getLastUsedAt(text: string, path: string = getUsageIndexPath()): number | undefined {
  const fp = fingerprintMemoryText(text)
  const fromPending = pending.get(fp)
  if (fromPending) return fromPending.last_used_at
  return readEntries(path).entries.get(fp)?.last_used_at
}

/** 测试用：清空待写缓冲与定时器（不落盘）。 */
export function resetMemoryUsageForTests(): void {
  pending.clear()
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
