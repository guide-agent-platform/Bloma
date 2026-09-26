/**
 * 文件写 lease（2026-09-26 运行审计 P1-06：宿主机级写隔离）。
 *
 * 审计原文：「同一项目最多可并行运行多个子 Agent；文件写锁、路径 lease、强制
 * revision/CAS 不完整，主要依赖提示词要求『不要同时修改同一文件』」。
 *
 * 本模块提供进程内租约（Bloma 子会话与父会话同进程，进程内 Map 即可覆盖宿主级
 * 冲突；跨进程/独立 worktree 隔离挂账）：
 * - 写盘临界区（校验通过后 → writeFileSync → 版本登记）持有租约，写完即释放；
 * - 已有他人持有的未过期租约 → 拒绝并返回 WRITE_LEASE_CONFLICT（教育文案提示
 *   先读后写/避免并行改同文件）；
 * - 租约 TTL 兜底（工具异常未释放时自动过期回收，不永久卡死写路径）。
 *
 * 设计取舍：不做「长持有」写锁（那会把并行委派变成串行队列，且模型长时间思考
 * 期间持锁无意义）——只在真正的写盘临界区互斥，冲突面恰好是「两个写者同时落盘」。
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolContext } from '../loop/agent-loop'

/** 租约 TTL：写盘临界区通常毫秒级，TTL 只做异常泄漏兜底。 */
const LEASE_TTL_MS = 30_000

interface WriteLease {
  holder: string
  at: number
}

/** projectId → 相对路径 → 租约（进程内单例）。 */
const leasesByProject = new Map<string, Map<string, WriteLease>>()

export type WriteLeaseResult = { ok: true } | { ok: false; holder: string }

function pruneExpired(map: Map<string, WriteLease>, now: number): void {
  for (const [rel, lease] of map) {
    if (now - lease.at > LEASE_TTL_MS) map.delete(rel)
  }
}

/**
 * 获取写租约。holder 建议传 ctx.toolCallId（并行子会话各调用唯一）；同 holder
 * 重复获取视为重入成功（同一调用内不会重复获取，防御性放开）。
 */
export function acquireWriteLease(projectId: string, rel: string, holder: string): WriteLeaseResult {
  const now = Date.now()
  let map = leasesByProject.get(projectId)
  if (!map) {
    map = new Map()
    leasesByProject.set(projectId, map)
  }
  pruneExpired(map, now)
  const existing = map.get(rel)
  if (existing && existing.holder !== holder) return { ok: false, holder: existing.holder }
  map.set(rel, { holder, at: now })
  return { ok: true }
}

/** 释放写租约（写盘完成 / 异常路径 finally 调用）。 */
export function releaseWriteLease(projectId: string, rel: string, holder: string): void {
  const map = leasesByProject.get(projectId)
  if (!map) return
  const existing = map.get(rel)
  if (existing && existing.holder === holder) map.delete(rel)
}

/** 释放某 holder 的全部租约（loop 收尾兜底；测试隔离用）。 */
export function releaseLeasesForHolder(holder: string): void {
  for (const map of leasesByProject.values()) {
    for (const [rel, lease] of map) {
      if (lease.holder === holder) map.delete(rel)
    }
  }
}

/** 测试专用：清空全部租约。 */
export function clearWriteLeasesForTests(): void {
  leasesByProject.clear()
}

/** 冲突教育文案（宿主级拒绝，非模型自律）。 */
export function writeLeaseConflictMessage(rel: string, holder: string): string {
  return [
    `WRITE_LEASE_CONFLICT：${rel} 正被另一个并行写者占用（持有者 ${holder.slice(0, 12)}…），本次写入已拒绝——避免两个会话同时改同一文件造成互相覆盖。`,
    '处理方式：① 若该文件属于别的独立子任务，改由它负责写，你只消费结果；② 等你负责的其他文件写完后再回来重试；③ 若确需同一文件，请串行（不要在同一批里并发委派同一文件的修改）。',
  ].join('\n')
}

// =========================================================================
// 文件版本戳与提交点写入（自 agent-tools 下沉：R7 行数守线 + 语义内聚）
// =========================================================================


/** 文件版本戳 = mtimeMs+size 十六进制（同一 loop 内足够区分「读后已被改」）。 */
export function fileRevisionOf(absPath: string): string {
  try {
    const stat = statSync(absPath)
    return `${stat.mtimeMs.toString(16)}-${stat.size.toString(16)}`
  } catch {
    return 'unknown'
  }
}

/** 会话内文件版本记录（惰性初始化；缺省 undefined = 功能未启用前的旧 state 兼容）。 */
export function fileRevisionsOf(ctx: ToolContext): Map<string, string> {
  if (!ctx.state.file_revisions) ctx.state.file_revisions = new Map()
  return ctx.state.file_revisions
}

export type CommitWriteResult = { ok: true } | { ok: false; code: 'STALE_READ' | 'WRITE_LEASE_CONFLICT'; output: string }

/**
 * 提交点写入（P1-06）：CAS 版本校验（含语法校验 await 窗口内的外部修改）→ 写租约
 * 临界区 → 落盘 → 版本登记。旧口径 revision 校验在异步校验之前、且可选参数缺省
 * 不校验——本原语把校验移到写盘前一刻并默认以会话版本为基准。
 */
export function commitFileWrite(input: {
  projectId: string
  root: string
  rel: string
  finalContent: string
  ctx: ToolContext
  expectedRevision?: string
}): CommitWriteResult {
  const abs = join(input.root, input.rel)
  const committedRevision = input.expectedRevision ?? fileRevisionsOf(input.ctx).get(input.rel)
  if (committedRevision && existsSync(abs)) {
    const currentRev = fileRevisionOf(abs)
    if (currentRev !== committedRevision) {
      return {
        ok: false,
        code: 'STALE_READ',
        output: `STALE_READ：${input.rel} 在你读取/上次写入后已被修改（基准版本 ${committedRevision}，当前 ${currentRev}）。请重新 read_file 后再修改，禁止凭旧内容覆盖。`,
      }
    }
  }
  const leaseHolder = input.ctx.toolCallId ?? input.ctx.sessionId
  const lease = acquireWriteLease(input.projectId, input.rel, leaseHolder)
  if (!lease.ok) {
    return { ok: false, code: 'WRITE_LEASE_CONFLICT', output: writeLeaseConflictMessage(input.rel, lease.holder) }
  }
  try {
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, input.finalContent, 'utf8')
  } finally {
    releaseWriteLease(input.projectId, input.rel, leaseHolder)
  }
  fileRevisionsOf(input.ctx).set(input.rel, fileRevisionOf(abs))
  return { ok: true }
}
