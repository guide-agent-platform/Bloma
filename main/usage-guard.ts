import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../storage/config-paths'

/**
 * Usage-Guard 三件套（2026-08-28，费用守卫 P2）——token 估算 + 会话占用率 + 预算守卫。
 *
 * 信源：Proma agent-tool-token-estimator.ts + agent-session-usage.ts（r56 原型 20/20 转正）。
 * Bloma 缺口闭环：渠道不返回 usage 时 loop 只能靠估算器；cache 口径防「只看 input_tokens
 * 低估数十倍」（prompt caching 下真实占用大头在 cache_read）。
 *
 * 边界（诚实记录）：估算器是启发式（±30% 级），只用于守卫/展示，不得用于计费；
 * 占用率依赖渠道返回 usage，undefined → 保守复用路径（不能瞎猜）。
 */

// ── 1. 估算器（CJK-aware 保守估算：宁可误报分块，不可漏报截断） ──────────────

function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df)
  )
}

/** CJK ≈1.5 token/字、ASCII 0.25/字符、其他 0.75——中文每字符开销约 6 倍于 ASCII。 */
export function estimateTokenCount(text: string): number {
  let cjk = 0
  let ascii = 0
  let other = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (isCjkCodePoint(cp)) cjk++
    else if (cp < 128) ascii++
    else other++
  }
  return Math.ceil(cjk * 1.5 + ascii * 0.25 + other * 0.75)
}

// ── 2. 会话占用率尾部反查（cache 口径） ─────────────────────────────────────

export interface UsageTokens {
  input_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** 占用口径 = input + cache_read + cache_creation（与渲染层一致）。 */
export function sumUsedTokens(u: UsageTokens): number {
  return u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
}

/**
 * 从会话 JSONL 尾部反查最后一条带 usage 的消息的占用率。
 * result 优先（命中立即返回，惰性——高频调度安全）、最近 assistant 兜底、损坏行跳过、
 * 全无 usage / 文件缺失 → undefined（未知，调用方走保守路径）。
 */
export function getSessionUsageRatio(jsonlPath: string, contextWindow: number, onParseLine?: (i: number) => void): number | undefined {
  // r53 审查采纳（deepseek+aliyun high）：contextWindow 非法（0/负/NaN/∞）→ 未知，禁止 NaN/∞ 比率污染决策
  if (!(contextWindow > 0) || !Number.isFinite(contextWindow)) return undefined
  let lines: string[]
  try {
    lines = readFileSync(jsonlPath, 'utf-8').split('\n')
  } catch {
    return undefined
  }
  let assistantFallback: UsageTokens | undefined
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    onParseLine?.(i)
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (msg.type === 'result' && msg.usage) {
      // r53 审查采纳（aliyun high）：usage 形状校验——input_tokens 必须为有限数，否则按未知处理
      const u = msg.usage as UsageTokens
      if (typeof u.input_tokens !== 'number' || !Number.isFinite(u.input_tokens)) continue
      const sum = sumUsedTokens(u)
      if (!Number.isFinite(sum)) continue
      return sum / contextWindow
    }
    if (msg.type === 'assistant' && (msg.message as { usage?: UsageTokens } | undefined)?.usage && !assistantFallback) {
      assistantFallback = (msg.message as { usage: UsageTokens }).usage
    }
  }
  return assistantFallback ? sumUsedTokens(assistantFallback) / contextWindow : undefined
}

// ── 3. 预算守卫策略 ────────────────────────────────────────────────────────

const REUSE_MAX_RATIO = 0.8

export type SessionDecision = 'reuse' | 'new-session' | 'reuse-conservative'

/** ≥0.8 → 换新会话（一开始就撞 SDK 自动压缩得不偿失）；unknown → 保守复用。 */
export function decideSessionReuse(ratio: number | undefined): SessionDecision {
  // r53 审查采纳：NaN/∞ 视同未知 → 保守复用（NaN >= 0.8 恒 false 会误判 reuse）
  if (ratio === undefined || !Number.isFinite(ratio)) return 'reuse-conservative'
  return ratio >= REUSE_MAX_RATIO ? 'new-session' : 'reuse'
}

const WRITE_CONTENT_TOKEN_THRESHOLD = 16_000

export type WriteDecision = 'allow' | 'chunk'

/** 大写入预检：估算 ≥16k token 引导分块（Bloma 暂无分块写，先作 warn 信号源）。 */
export function decideWrite(content: string): WriteDecision {
  return estimateTokenCount(content) >= WRITE_CONTENT_TOKEN_THRESHOLD ? 'chunk' : 'allow'
}

/** sessionId 白名单：只允许安全文件名字符（r53 审查采纳：拒绝 ../ 路径穿越）。 */
export function isValidSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(sessionId) && !sessionId.startsWith('.')
}

/** 当前用户会话 JSONL 路径（PROMA_HOME 隔离，供守卫/展示方反查占用率）；非法 id → undefined。 */
export function getBlomaSessionJsonlPath(sessionId: string): string | undefined {
  if (!isValidSessionId(sessionId)) return undefined
  return join(getPromaHome(), 'agent-sessions', `${sessionId}.jsonl`)
}

/** 便捷入口：当前会话占用率（未知 → undefined）。 */
export function getSessionUsageRatioById(sessionId: string, contextWindow: number): number | undefined {
  const p = getBlomaSessionJsonlPath(sessionId)
  if (!p || !existsSync(p)) return undefined
  return getSessionUsageRatio(p, contextWindow)
}
