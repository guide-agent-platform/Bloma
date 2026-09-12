import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getPromaHome } from '../storage/config-paths'
import { escapeMemoryDelimiters } from './memory-sanitize'

/**
 * 记忆撤销名单（2026-09-12 记忆栈审计裁定 §8；D0）。
 *
 * 解决什么：记忆被注入后会**落进会话 JSONL**（agent-loop.ts「JSONL 落注入后文本——审计=模型
 * 实际所见」），而 session-recall 索引的正是那批转录 → 只删源文件的话，同一段文本仍可被
 * 跨会话检索召回并再次注入（删除旁路）。撤销名单是**只读侧排除**的单一裁决点：所有注入面
 * 渲染时校验，命中即跳过，不改写转录、不删审计。
 *
 * 关键设计（与 v6.2 冻结版一致）：
 * - 存**归一化指纹**（sha256 前 32 hex），不存原文——否则「删除」等于把文本搬进名单；
 * - 归一化口径 = `escapeMemoryDelimiters`（与注入侧净化同源），保证"转义前删、转义后匹配"；
 * - 路径 `~/.proma/bloma-revocation-index.json`（全局，与 bloma-experience.jsonl 同级：
 *   跨会话语录是全局的，指纹也必须全局覆盖）；
 * - **缺失 = 空名单（readable=true）**；**存在但损坏/读不出 = fail-closed（readable=false）**，
 *   受覆盖层整体不注入（不是「这块不注入」——名单读不出时无法判断哪些条目被撤销）；
 * - 不设开关（安全路径不做开关，见指令总原则）；写入原子（tmp + rename）。
 */

export const REVOCATION_FILE = 'bloma-revocation-index.json'

/** 指纹上限（增长清理；超限丢最旧）。数值待产品/安全批准（见 whitespace-values.md）。 */
export const MAX_FINGERPRINTS = 5000

export interface RevocationIndex {
  fingerprints: Set<string>
  /** false = 文件存在但损坏/不可读 → 受覆盖层 fail-closed（整体不注入）。 */
  readable: boolean
}

export function getRevocationIndexPath(): string {
  return join(getPromaHome(), REVOCATION_FILE)
}

/**
 * 文本 → 归一化指纹（sha256 前 32 hex）。归一化口径必须与注入侧净化同源，
 * 否则"删除时的原文"与"注入时的净化文本"对不上，撤销会静默失效。
 */
export function fingerprintMemoryText(text: string): string {
  return createHash('sha256').update(escapeMemoryDelimiters(text)).digest('hex').slice(0, 32)
}

/** 读取名单：缺失 → 空且 readable；损坏 → readable=false（fail-closed 信号）。 */
export function loadRevocationIndex(path: string = getRevocationIndexPath()): RevocationIndex {
  try {
    if (!existsSync(path)) return { fingerprints: new Set(), readable: true }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { fingerprints?: unknown }
    const raw = Array.isArray(parsed?.fingerprints) ? parsed.fingerprints : []
    const fingerprints = new Set(raw.filter((item): item is string => typeof item === 'string' && item.length > 0))
    return { fingerprints, readable: true }
  } catch {
    return { fingerprints: new Set(), readable: false }
  }
}

/** 该层是否必须整体不注入（名单不可读 = fail-closed）。 */
export function revocationBlocksLayer(index: RevocationIndex): boolean {
  return !index.readable
}

/** 单条文本是否被撤销（名单不可读时返回 true，属 fail-closed 语义，调用方应配合 revocationBlocksLayer 使用）。 */
export function isMemoryTextRevoked(text: string, index: RevocationIndex): boolean {
  if (!index.readable) return true
  return index.fingerprints.has(fingerprintMemoryText(text))
}

/** 追加一条撤销指纹（幂等，原子写）。返回是否写入成功；失败静默（调用方按需记录）。 */
export function revokeMemoryText(text: string, path: string = getRevocationIndexPath()): boolean {
  try {
    const index = loadRevocationIndex(path)
    const fp = fingerprintMemoryText(text)
    // 名单损坏时以本次写入重建（不因一个坏文件丢掉本次撤销指令）
    const next = new Set(index.readable ? index.fingerprints : [])
    if (index.readable && next.has(fp)) return true
    next.add(fp)
    const list = [...next].slice(-MAX_FINGERPRINTS)
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(
      tmp,
      `${JSON.stringify({ version: 1, updated_at: new Date().toISOString(), fingerprints: list }, null, 2)}\n`,
      'utf8',
    )
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}
