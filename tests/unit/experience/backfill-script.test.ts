import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * T-3 冷启动回灌脚本 E2E（spawn 真 node 跑真脚本，真 fixture）：
 * - 三类来源（learnings 异常/修复结局 + test-report 失败摘要）成卡；note kind 不进
 * - 跨项目同指纹合并 recurrence=2 / seen_projects=2
 * - 重跑幂等（skipped 全量，账本行数不变）
 * - 脱敏：家目录路径不落账本
 * - --dry-run 不写账本
 */

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'proma-backfill-'))
  const p1 = join(root, 'agent-workspaces', 'ws', 'documents', 'p1')
  const p2 = join(root, 'agent-workspaces', 'ws', 'documents', 'p2')
  mkdirSync(p1, { recursive: true })
  mkdirSync(p2, { recursive: true })
  writeFileSync(
    join(p1, 'learnings.jsonl'),
    [
      JSON.stringify({ recorded_at: '2026-09-01T00:00:00Z', kind: 'loop_outcome', text: 'Loop 结束（turn_limit，24 轮）' }),
      JSON.stringify({ recorded_at: '2026-09-01T01:00:00Z', kind: 'note', text: '普通备注不成卡' }),
      JSON.stringify({ recorded_at: '2026-09-01T02:00:00Z', kind: 'repair_outcome', text: '修复轮（第 1 轮）异常终止：渠道不可用 at C:\\Users\\alice\\x\\y.ts' }),
    ].join('\n') + '\n',
    'utf8',
  )
  writeFileSync(
    join(p2, 'learnings.jsonl'),
    JSON.stringify({ recorded_at: '2026-09-03T00:00:00Z', kind: 'loop_outcome', text: 'Loop 结束（turn_limit，24 轮）' }) + '\n',
    'utf8',
  )
  writeFileSync(
    join(p1, 'test-report.json'),
    JSON.stringify({ total_count: 2, passed_count: 1, failed_count: 1, failure_summary: [{ scenario: 'F-005 输入关键词显示匹配', reason: '断言未通过 capture-input 未命中' }] }),
    'utf8',
  )
  return root
}

function runScript(args: string[]): string {
  return execFileSync(process.execPath, ['scripts/backfill-error-cards.mjs', ...args], {
    encoding: 'utf8',
    cwd: process.cwd(),
  })
}

function view(ledgerPath: string) {
  const rows = new Map<string, { tag: string; recurrence: number; seen: number; raw: string }>()
  if (!existsSync(ledgerPath)) return rows
  for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const c = JSON.parse(line)
    rows.set(c.id, { tag: c.tag, recurrence: c.recurrence, seen: (c.seen_projects ?? []).length, raw: line })
  }
  return rows
}

describe('backfill-error-cards.mjs', () => {
  it('dry-run 不写账本；commit 成卡 + 跨项目合并 + note 不成卡', () => {
    const root = makeFixture()
    const ledger = join(root, 'bloma-experience.jsonl')
    const dryOut = runScript(['--root', root, '--dry-run'])
    expect(dryOut).toContain('signals=4')
    expect(existsSync(ledger)).toBe(false)

    const out = runScript(['--root', root])
    expect(out).toContain('写入')
    const rows = view(ledger)
    expect([...rows.values()].some((r) => r.tag.startsWith('unknown/outcome/timeout') && r.recurrence === 2 && r.seen === 2)).toBe(true)
    expect([...rows.values()].some((r) => r.tag.startsWith('coding/gwt/'))).toBe(true)
    expect([...rows.values()].some((r) => r.tag.startsWith('unknown/outcome/unexpected_exit'))).toBe(true) // repair_outcome 异常终止
    expect(readFileSync(ledger, 'utf8')).not.toContain('普通备注')
  })

  it('重跑幂等：全量 skip，账本压缩视图不变', () => {
    const root = makeFixture()
    const ledger = join(root, 'bloma-experience.jsonl')
    runScript(['--root', root])
    const first = view(ledger)
    const second = runScript(['--root', root])
    expect(second).toContain('无新数据（幂等）')
    const after = view(ledger)
    expect([...after.values()].map((r) => `${r.tag}:${r.recurrence}`)).toEqual([...first.values()].map((r) => `${r.tag}:${r.recurrence}`))
  })

  it('脱敏：家目录用户名不出现在账本任何行', () => {
    const root = makeFixture()
    runScript(['--root', root])
    const raw = readFileSync(join(root, 'bloma-experience.jsonl'), 'utf8')
    expect(raw).not.toContain('alice')
    expect(raw).toContain('{path}/y.ts')
  })
})
