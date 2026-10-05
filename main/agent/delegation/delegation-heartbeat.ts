/**
 * 委派进度心跳（2026-10-06 体验批 C；Bloma 特有，挂账「委派等待期深度反馈」的落地）。
 *
 * 设计（对齐 delegation-watch 的注入模式，但**默认开**——纯信息事件零副作用）：
 * - 15s 周期扫描 running 委派（scan source 由 agent-collaboration 尾部注入，防静态环）；
 * - 每个委派读子会话 JSONL（storage/config-paths getAgentSessionPath）：
 *   大小未变 → 沿用上次快照零 IO 读文件；变大 → 读尾部 64KB 解析
 *   最近工具名 + 最后活动时间 + 累计字节数；
 * - 事件经注入式 publisher 发 AGENT_STREAM_EVENT（接线在 ipc.ts，agent 层不上引 entry——R1）；
 * - 委派终结即不在 running 集合 → 自然停发；渲染端迟到心跳不复活已终结状态。
 *
 * 渲染端呈现（DelegationRow）：「最近 write_file · 8 秒前活跃 · 已写 1.2MB」。
 */

import { randomUUID } from 'node:crypto'
import { openSync, readSync, fstatSync, closeSync } from 'node:fs'
import type { AgentEvent } from '../../../shared/types'
import { getAgentSessionPath } from '../../../storage/config-paths'

/** 心跳所需的最小 record 面（DelegationWatchRecord 结构子集，防环）。 */
export interface HeartbeatRecord {
  delegationId: string
  parentSessionId: string
  childSessionId: string
  role: string
}

export interface DelegationHeartbeatSource {
  forEachRunningDelegation: (fn: (record: HeartbeatRecord) => void) => void
}

export interface HeartbeatPayload {
  delegation_id: string
  child_session_id: string
  role: string
  last_tool?: string
  /** 最后一次子会话写盘时刻（epoch ms；由 JSONL 尾行 _createdAt 提取）。 */
  last_activity_ms?: number
  /** 子会话 JSONL 累计字节数（活跃度旁证）。 */
  file_bytes: number
}

const HEARTBEAT_INTERVAL_MS = 15_000
const TAIL_BYTES = 64 * 1024

let source: DelegationHeartbeatSource | undefined
let publisher: ((event: AgentEvent) => void) | undefined
let timer: NodeJS.Timeout | undefined
/** 每委派上次快照：childSessionId → { bytes, payload }（大小未变时零读复用）。 */
const snapshots = new Map<string, { bytes: number; payload: HeartbeatPayload }>()

export function setDelegationHeartbeatSource(next: DelegationHeartbeatSource | null): void {
  source = next ?? undefined
}

/** 一步安装（agent-collaboration 尾部单行调用，R7 行数纪律）：注入源并启动周期扫描。 */
export function installDelegationHeartbeat(next: DelegationHeartbeatSource): void {
  setDelegationHeartbeatSource(next)
  ensureDelegationHeartbeatStarted()
}

export function setDelegationHeartbeatPublisher(next: ((event: AgentEvent) => void) | null): void {
  publisher = next ?? undefined
}

/** 启动周期扫描（幂等；interval unref 不阻退出）。 */
export function ensureDelegationHeartbeatStarted(): void {
  if (timer) return
  timer = setInterval(() => { void tick() }, HEARTBEAT_INTERVAL_MS)
  timer.unref?.()
}

/** 停止并清快照（测试/退出）。 */
export function teardownDelegationHeartbeat(): void {
  if (timer) { clearInterval(timer); timer = undefined }
  snapshots.clear()
}

async function tick(): Promise<void> {
  if (!source || !publisher) return
  const records: HeartbeatRecord[] = []
  try {
    source.forEachRunningDelegation((record) => { records.push(record) })
  } catch {
    return // 扫描源异常静默（下周期再试）
  }
  const seen = new Set<string>()
  for (const record of records) {
    seen.add(record.childSessionId)
    try {
      const payload = inspectChildSession(record)
      if (payload) publisher(buildEvent(record, payload))
    } catch {
      /* 单委派失败不影响其余（下周期重试） */
    }
  }
  // 已终结委派的快照回收
  for (const key of snapshots.keys()) {
    if (!seen.has(key)) snapshots.delete(key)
  }
}

function buildEvent(record: HeartbeatRecord, payload: HeartbeatPayload): AgentEvent {
  return {
    event_id: randomUUID(),
    created_at: new Date().toISOString(),
    session_id: record.parentSessionId,
    type: 'delegation_heartbeat',
    payload: payload as unknown as Record<string, unknown>,
  }
}

/** 读子会话 JSONL 状态（大小未变复用快照；异常返回 undefined 本周期跳过）。 */
export function inspectChildSession(record: HeartbeatRecord): HeartbeatPayload | undefined {
  const path = getAgentSessionPath(record.childSessionId)
  const fd = openSync(path, 'r')
  try {
    const info = fstatSync(fd)
    const bytes = info.size
    const previous = snapshots.get(record.childSessionId)
    if (previous && previous.bytes === bytes) {
      return { ...previous.payload, file_bytes: bytes }
    }
    const tail = readTail(fd, bytes)
    const parsed = parseHeartbeatFromTail(tail, Date.now(), bytes > TAIL_BYTES)
    const payload: HeartbeatPayload = {
      delegation_id: record.delegationId,
      child_session_id: record.childSessionId,
      role: record.role,
      last_tool: parsed.lastTool,
      last_activity_ms: parsed.lastActivityMs,
      file_bytes: bytes,
    }
    snapshots.set(record.childSessionId, { bytes, payload })
    return payload
  } finally {
    closeSync(fd)
  }
}

function readTail(fd: number, fileSize: number): string {
  const length = Math.min(TAIL_BYTES, fileSize)
  const buffer = Buffer.alloc(length)
  readSync(fd, buffer, 0, length, fileSize - length)
  return buffer.toString('utf8')
}

/** 尾部文本解析（纯函数，可单测）：最近工具名 + 最后写盘时刻。
 * firstLineTruncated：仅当确实从文件中间起读（bytes > TAIL_BYTES）时首行不完整才跳过——
 * 整文件读入时首行完整，误跳会吃掉唯一内容行（测试实锤）。 */
export function parseHeartbeatFromTail(tail: string, now: number, firstLineTruncated = true): { lastTool?: string; lastActivityMs?: number } {
  const lines = tail.split('\n')
  if (firstLineTruncated && lines.length > 1) lines.shift()
  let lastTool: string | undefined
  let lastActivityMs: number | undefined
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim()
    if (!line) continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { continue }
    if (lastActivityMs === undefined && typeof (parsed as { _createdAt?: unknown })._createdAt === 'number') {
      lastActivityMs = (parsed as { _createdAt: number })._createdAt
    }
    if (lastTool === undefined) {
      const content = (parsed as { message?: { content?: unknown } }).message?.content
      if (Array.isArray(content)) {
        for (let i = content.length - 1; i >= 0; i--) {
          const block = content[i] as { type?: string; name?: string }
          if (block?.type === 'tool_use' && typeof block.name === 'string') { lastTool = block.name; break }
        }
      }
    }
    if (lastTool !== undefined && lastActivityMs !== undefined) break
  }
  void now // 预留：活跃度换算在渲染端做（last_activity_ms 距当前秒数）
  return { lastTool, lastActivityMs }
}
