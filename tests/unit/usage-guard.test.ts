import { restorePromaHome } from '../support/proma-home-guard'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  estimateTokenCount,
  sumUsedTokens,
  getSessionUsageRatio,
  getSessionUsageRatioById,
  decideSessionReuse,
  decideWrite,
} from '../../main/usage-guard'

/**
 * Usage-Guard 三件套（2026-08-28，费用守卫 P2，r56 原型 20/20 转正）：
 * 1. estimateTokenCount——CJK-aware 保守估算（中文 ≈1.5 token/字，ASCII 0.25/字符）
 * 2. getSessionUsageRatio——JSONL 尾部惰性反查 cache 口径占用率（只看 input_tokens 会低估数十倍）
 * 3. decideSessionReuse / decideWrite——预算决策（阈值含 0.8；unknown 保守复用；≥16k 引导分块）
 */

let tmp: string
const win = 200_000

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'usage-guard-test-'))
  process.env.PROMA_HOME = tmp
})

afterEach(() => {
  restorePromaHome(process.env.PROMA_HOME)
})

function jsonl(name: string, lines: unknown[]): string {
  const p = join(tmp, name)
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf-8')
  return p
}

describe('estimateTokenCount（CJK 保守估算）', () => {
  it('[S4-AGENT-040] 中文 100 字 ≈150；ASCII 100 字符 =25；CJK 开销 6 倍于 ASCII', () => {
    expect(estimateTokenCount('中'.repeat(100))).toBe(150)
    expect(estimateTokenCount('a'.repeat(100))).toBe(25)
    // 100 字量级下系数比精确 6 倍（短串 ceil 取整会扰动比值）
    expect(estimateTokenCount('中'.repeat(100)) / estimateTokenCount('a'.repeat(100))).toBe(6)
  })

  it('[S4-AGENT-041] 空串安全；CJK 扩展区（代理对 U+20000）按 CJK 计', () => {
    expect(estimateTokenCount('')).toBe(0)
    expect(estimateTokenCount(String.fromCodePoint(0x20000))).toBe(2)
  })
})

describe('sumUsedTokens（cache 口径）', () => {
  it('[S4-AGENT-042] input 2000 + cache_read 90000 + cache_creation 8000 = 100000（只看 input 低估 50 倍）', () => {
    expect(sumUsedTokens({ input_tokens: 2000, cache_read_input_tokens: 90000, cache_creation_input_tokens: 8000 })).toBe(100000)
  })
})

describe('getSessionUsageRatio（尾部惰性反查）', () => {
  it('[S4-AGENT-043] result 优先：(2000+90000+8000)/200000=0.5（cache 口径）', () => {
    const p = jsonl('b.jsonl', [
      { type: 'user', message: { content: '历史噪声' } },
      { type: 'assistant', message: { usage: { input_tokens: 1000, cache_read_input_tokens: 5000 } } },
      { type: 'user', message: { content: '继续' } },
      { type: 'result', subtype: 'success', usage: { input_tokens: 2000, cache_read_input_tokens: 90000, cache_creation_input_tokens: 8000 } },
    ])
    expect(getSessionUsageRatio(p, win)).toBe(0.5)
  })

  it('[S4-AGENT-044] 无 result 回退最近 assistant：6000/200000=0.03', () => {
    const p = jsonl('b2.jsonl', [
      { type: 'user', message: { content: 'x' } },
      { type: 'assistant', message: { usage: { input_tokens: 3000, cache_read_input_tokens: 3000 } } },
    ])
    expect(getSessionUsageRatio(p, win)).toBe(0.03)
  })

  it('[S4-AGENT-045] 全无 usage → undefined；文件不存在 → undefined 不抛；损坏行跳过', () => {
    const p3 = jsonl('b3.jsonl', [{ type: 'user', message: { content: 'no usage' } }])
    expect(getSessionUsageRatio(p3, win)).toBeUndefined()
    expect(getSessionUsageRatio(join(tmp, 'nope.jsonl'), win)).toBeUndefined()
    const p4 = join(tmp, 'b4.jsonl')
    writeFileSync(p4, '{bad json\n' + JSON.stringify({ type: 'result', usage: { input_tokens: 10000 } }), 'utf-8')
    expect(getSessionUsageRatio(p4, win)).toBe(0.05)
  })

  it('[S4-AGENT-046] 惰性解析：1001 行文件命中尾行只解析 1 行（高频调度安全）', () => {
    const lines: unknown[] = []
    for (let i = 0; i < 1000; i++) lines.push({ type: 'user', message: { content: `noise ${i}` } })
    lines.push({ type: 'result', usage: { input_tokens: 100000 } })
    const p = jsonl('c.jsonl', lines)
    let parsed = 0
    const ratio = getSessionUsageRatio(p, win, () => {
      parsed++
    })
    expect(ratio).toBe(0.5)
    expect(parsed).toBe(1)
  })
})

describe('r53 多厂商审查采纳修复', () => {
  it('[S4-AGENT-051] contextWindow 非法（0/负/NaN）→ undefined；ratio NaN → reuse-conservative（deepseek+aliyun high 收敛）', () => {
    const p = jsonl('ctx0.jsonl', [{ type: 'result', usage: { input_tokens: 100 } }])
    expect(getSessionUsageRatio(p, 0)).toBeUndefined()
    expect(getSessionUsageRatio(p, -5)).toBeUndefined()
    expect(getSessionUsageRatio(p, Number.NaN)).toBeUndefined()
    expect(decideSessionReuse(Number.NaN)).toBe('reuse-conservative')
    expect(decideSessionReuse(Number.POSITIVE_INFINITY)).toBe('reuse-conservative')
  })

  it('[S4-AGENT-052] usage 形状非法（input_tokens 缺失/非数）→ undefined（aliyun high：防 NaN 污染）', () => {
    const bad1 = jsonl('bad1.jsonl', [{ type: 'result', usage: { cache_read_input_tokens: 100 } }])
    const bad2 = jsonl('bad2.jsonl', [{ type: 'result', usage: { input_tokens: 'lots' } }])
    expect(getSessionUsageRatio(bad1, win)).toBeUndefined()
    expect(getSessionUsageRatio(bad2, win)).toBeUndefined()
  })

  it('[S4-AGENT-053] sessionId 路径穿越拒绝（aliyun high：../ 逃逸 PROMA_HOME → undefined）', () => {
    expect(getSessionUsageRatioById('../evil', win)).toBeUndefined()
    expect(getSessionUsageRatioById('a/b', win)).toBeUndefined()
    expect(getSessionUsageRatioById('', win)).toBeUndefined()
  })
})

describe('预算决策', () => {
  it('[S4-AGENT-047] 复用决策：0.79→reuse；0.8（含）→new-session；unknown→reuse-conservative', () => {
    expect(decideSessionReuse(0.79)).toBe('reuse')
    expect(decideSessionReuse(0.8)).toBe('new-session')
    expect(decideSessionReuse(0.5)).toBe('reuse')
    expect(decideSessionReuse(undefined)).toBe('reuse-conservative')
  })

  it('[S4-AGENT-048] 大写入：100k 中文→chunk；10k ASCII→allow；10667 中文=16000.5 边界→chunk', () => {
    expect(decideWrite('中'.repeat(100_000))).toBe('chunk')
    expect(decideWrite('a'.repeat(10_000))).toBe('allow')
    expect(decideWrite('中'.repeat(10_667))).toBe('chunk')
  })
})

describe('PROMA_HOME 隔离兜底', () => {
  it('[S4-AGENT-049] 守卫在空目录环境零异常（真实接线由 agent-loop 测试覆盖）', () => {
    expect(existsSync(join(process.env.PROMA_HOME ?? '', 'agent-sessions'))).toBe(false)
    expect(decideWrite('x')).toBe('allow')
  })
})
