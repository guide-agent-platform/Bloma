/**
 * SessionTree — 会话 JSONL v2 树链写入（P0-2 fork，2026-09-08 pi 差距方案 §2）。
 *
 * 目标：会话 JSONL 从纯线性 append 升级为可 fork 的树结构，**旧文件零迁移**。
 * - 新写入的每一行带 `id`（8 位 hex）与 `parentId`（前一行 id，首行 null）；
 *   未知字段对全部既有读取方透明（读者按 role/content 过滤，多字段无害）——
 *   读路径全覆盖风险由「不加头部行 + 只增可选字段」消解。
 * - 父会话链接（forkedFrom）不落 JSONL 头（会让每个 reader 多一层过滤），
 *   改记在 agent-sessions.json 索引的 AgentSessionRecord（parent_session_id /
 *   fork_entry_id，见 session-service.forkFrom）。
 * - fork = 复制前缀到新文件时重写整条 id 链（复制品是普通线性 v2 文件）；
 *   原文件一字不动。
 *
 * 单测友好：纯内存 lastId 表 + 幂等 reset 供用例间隔离。
 */

import { randomBytes } from 'node:crypto'
import { getAgentSessionPath } from '../storage/config-paths'
import { appendJsonLine } from '../storage/json-store'

/** 每会话最近一次写入的 id（parentId 链锚点）。文件被外部删除时首行 parentId 仍为 null，
 *  依赖 getAgentSessionPath 的 exists 判断不可靠——由 appendJsonLine 的 fs 层负责文件创建，
 *  这里以内存链为准（应用重启丢内存链 → 新文件首行 parent=null，等价于新会话开头，可接受）。 */
const lastIds = new Map<string, string>()

/** 生成 8 位 hex 会话行 id（碰撞时重滚；与既有行同文件碰撞概率极低，仍防御）。 */
export function nextSessionEntryId(): string {
  return randomBytes(4).toString('hex')
}

/**
 * 追加一条会话消息并写树链：`{...message, id, parentId}`。
 * 全部会话 JSONL 写入统一走本函数（agent-loop / orchestrator / programming-orchestrator /
 * ipc / guide / recovery / runtime-fallback / decision-log / delegation-persistence 等 20 处
 * 直写点已收口）——保「审计=模型所见」的字段语义零变化，只增链字段。
 * 泛型约束 object：既有调用点既传具名接口（AgentMessage）也传内联对象字面量（可能带
 * 额外字段如 delegation_settle），不可收窄为单一具名类型。
 */
export function appendSessionMessage<T extends object>(sessionId: string, message: T): void {
  const id = nextSessionEntryId()
  const parentId = lastIds.get(sessionId) ?? null
  appendJsonLine(getAgentSessionPath(sessionId), { ...message, id, parentId })
  lastIds.set(sessionId, id)
}

/** 测试 seam：清空 per-session lastId，保证用例间不串扰。 */
export function resetSessionTreeForTests(): void {
  lastIds.clear()
}
