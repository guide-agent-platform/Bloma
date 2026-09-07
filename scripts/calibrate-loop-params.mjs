/**
 * loop 参数标定脚本（闭环治理 PR8，随感 16/41）。
 * （无 shebang：npm 经 `node scripts/…` 调用；且 vitest 导入本模块时 shebang 会被
 *  转换器判为非法 token，曾致 calibrate-loop-params.test.ts 文件级失败——2026-09-02）
 *
 * 输入：{PROMA_HOME:-~/.proma}/agent-workspaces/<slug>/analytics.jsonl（含 default-software-builder）。
 * 只读不改任何配置；输出 stdout 报告表 + {PROMA_HOME}/loop-params-report.json。
 *
 * 统计维度：
 *  ① agent_loop_completed 的 turns 分布（p50/p90/max）→ 建议 maxTurns quick/longterm
 *  ② agent_loop_turn 末轮 input_tokens 分布 → 建议 BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS（PR6 阈值依据）
 *  ③ self_repair_triggered 直方图 → 建议 EDIT_BUDGET_AFTER_TEST_FAILURE
 *  ④ judge_verdict 通过率 → 修复预算有效性
 *
 * 建议为确定性公式（见 analyzeEvents 内注释），口径是「初步建议，人工复核后回填」。
 * 零外部依赖；纯函数（percentile/analyzeEvents）导出供单测复用。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 最近邻秩法百分位：ceil(p/100*n) 取第 k 个（1-based）；空数组返回 undefined。 */
export function percentile(sortedValues, p) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return undefined
  const index = Math.ceil((p / 100) * sortedValues.length) - 1
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))]
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    max: sorted.length > 0 ? sorted[sorted.length - 1] : undefined,
  }
}

/** 判定「通过」口径：pass / ready 视为通过（judge verdict 联合里的正向态）。 */
function isPassVerdict(verdict) {
  return verdict === 'pass' || verdict === 'ready'
}

/**
 * 纯函数：analytic 事件数组（已解析对象）→ 标定报告。
 * 建议：
 *  - maxTurnsQuick = max(24, ceil(p90_turns × 1.2))
 *  - maxTurnsLongterm = max(40, ceil(max_turns × 1.1))
 *  - compactInputTokens = ceil(p90_last_input_tokens / 10000) × 10000（无数据 → null，保留 100k 缺省）
 *  - editBudgetAfterTestFailure = max(3, max_attempt)
 */
export function analyzeEvents(events) {
  const completedTurns = []
  /** session → { maxTurn, tokensOfMaxTurn }（末轮 input_tokens；同轮取最后一条） */
  const lastTurnTokens = new Map()
  const repairHistogram = {}
  let repairMaxAttempt = 0
  let judgeTotal = 0
  let judgePass = 0
  const judgeByVerdict = {}

  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const payload = event.payload ?? {}
    switch (event.event_type) {
      case 'agent_loop_completed': {
        if (typeof payload.turns === 'number' && payload.turns > 0) completedTurns.push(payload.turns)
        break
      }
      case 'agent_loop_turn': {
        const turn = payload.turn
        const tokens = payload.input_tokens
        if (typeof turn !== 'number') break
        const sessionId = typeof event.session_id === 'string' ? event.session_id : ''
        const current = lastTurnTokens.get(sessionId)
        if (!current || turn >= current.maxTurn) {
          // 同轮多条（不该发生）取最后一条；有 tokens 的记录覆盖无 tokens 的
          if (!current || turn > current.maxTurn || typeof tokens === 'number') {
            lastTurnTokens.set(sessionId, { maxTurn: turn, tokens: typeof tokens === 'number' ? tokens : current?.tokens })
          }
        }
        break
      }
      case 'self_repair_triggered': {
        const attempt = payload.attempt
        if (typeof attempt !== 'number' || attempt <= 0) break
        repairHistogram[String(attempt)] = (repairHistogram[String(attempt)] ?? 0) + 1
        if (attempt > repairMaxAttempt) repairMaxAttempt = attempt
        break
      }
      case 'judge_verdict': {
        judgeTotal += 1
        const verdict = typeof payload.verdict === 'string' ? payload.verdict : 'unknown'
        judgeByVerdict[verdict] = (judgeByVerdict[verdict] ?? 0) + 1
        if (isPassVerdict(verdict)) judgePass += 1
        break
      }
      default:
        break
    }
  }

  const loops = { count: completedTurns.length, turns: distribution(completedTurns) }
  const lastInputTokens = distribution(
    [...lastTurnTokens.values()].map((entry) => entry.tokens).filter((tokens) => typeof tokens === 'number'),
  )
  const turnsP90 = loops.turns.p90
  const turnsMax = loops.turns.max
  const suggestions = {
    maxTurnsQuick: Math.max(24, typeof turnsP90 === 'number' ? Math.ceil(turnsP90 * 1.2) : 0),
    maxTurnsLongterm: Math.max(40, typeof turnsMax === 'number' ? Math.ceil(turnsMax * 1.1) : 0),
    compactInputTokens:
      typeof lastInputTokens.p90 === 'number' ? Math.ceil(lastInputTokens.p90 / 10000) * 10000 : null,
    editBudgetAfterTestFailure: Math.max(3, repairMaxAttempt),
  }

  return {
    loops,
    lastInputTokens,
    selfRepair: { histogram: repairHistogram, maxAttempt: repairMaxAttempt },
    judge: { total: judgeTotal, pass: judgePass, passRate: judgeTotal > 0 ? judgePass / judgeTotal : 0, byVerdict: judgeByVerdict },
    suggestions,
  }
}

// ---------------------------------------------------------------------------
// CLI（直接执行时运行；被单测 import 时不触发）
// ---------------------------------------------------------------------------

function readAnalyticsEvents(promaHome) {
  const events = []
  const workspacesRoot = join(promaHome, 'agent-workspaces')
  if (!existsSync(workspacesRoot)) return events
  for (const slug of readdirSync(workspacesRoot, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue
    const path = join(workspacesRoot, slug.name, 'analytics.jsonl')
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        events.push(JSON.parse(trimmed))
      } catch {
        // 损坏行跳过
      }
    }
  }
  return events
}

function renderReport(report, eventCount) {
  const lines = []
  lines.push('# Agent Loop 参数标定报告')
  lines.push('')
  lines.push(`输入事件数：${eventCount}（agent-workspaces/<slug>/analytics.jsonl，只读）`)
  lines.push('')
  lines.push('## ① loop 完成轮次分布（→ maxTurns quick/longterm）')
  lines.push(`样本 ${report.loops.count} 次 | p50=${report.loops.turns.p50 ?? '-'} p90=${report.loops.turns.p90 ?? '-'} max=${report.loops.turns.max ?? '-'}`)
  lines.push(`建议：BLOMA_LOOP_MAX_TURNS_QUICK=${report.suggestions.maxTurnsQuick} / BLOMA_LOOP_MAX_TURNS_LONGTERM=${report.suggestions.maxTurnsLongterm}`)
  lines.push('')
  lines.push('## ② 末轮 input_tokens 分布（→ 竹节压缩阈值，PR6）')
  lines.push(`样本 ${report.lastInputTokens.count} 会话 | p50=${report.lastInputTokens.p50 ?? '-'} p90=${report.lastInputTokens.p90 ?? '-'} max=${report.lastInputTokens.max ?? '-'}`)
  lines.push(`建议：BLOMA_LOOP_COMPACT_AT_INPUT_TOKENS=${report.suggestions.compactInputTokens ?? '（无数据，保留缺省 100000）'}`)
  lines.push('')
  lines.push('## ③ self_repair 触发直方图（→ EDIT_BUDGET_AFTER_TEST_FAILURE）')
  lines.push(
    Object.keys(report.selfRepair.histogram).length > 0
      ? Object.entries(report.selfRepair.histogram).map(([attempt, count]) => `attempt ${attempt}×${count}`).join('、') + `（max=${report.selfRepair.maxAttempt}）`
      : '（无 self_repair_triggered 事件）',
  )
  lines.push(`建议：EDIT_BUDGET_AFTER_TEST_FAILURE=${report.suggestions.editBudgetAfterTestFailure}`)
  lines.push('')
  lines.push('## ④ judge 裁决分布（→ 修复预算有效性）')
  lines.push(`共 ${report.judge.total} 次 | 通过 ${report.judge.pass}（${(report.judge.passRate * 100).toFixed(1)}%）` +
    (Object.keys(report.judge.byVerdict).length > 0
      ? ` | ${Object.entries(report.judge.byVerdict).map(([verdict, count]) => `${verdict}×${count}`).join('、')}`
      : ''))
  lines.push('')
  lines.push('> 建议为确定性公式输出（p90×1.2 / max×1.1 / p90 圆整到万 / max(3, maxAttempt)），人工复核后回填配置。')
  return lines.join('\n')
}

function main() {
  const promaHome = process.env.PROMA_HOME || join(homedir(), '.proma')
  const events = readAnalyticsEvents(promaHome)
  const report = analyzeEvents(events)
  const text = renderReport(report, events.length)
  console.log(text)
  const reportPath = join(promaHome, 'loop-params-report.json')
  writeFileSync(reportPath, `${JSON.stringify({ generated_at: new Date().toISOString(), event_count: events.length, ...report }, null, 2)}\n`, 'utf8')
  console.log(`\n报告已写入：${reportPath}`)
}

const isCliMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isCliMain) main()
