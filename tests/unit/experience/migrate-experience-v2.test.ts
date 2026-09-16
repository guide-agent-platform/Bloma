import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { foldedFingerprints, readLifecycleRows } from '../../../main/experience/event-log'

/**
 * F 系列 W2.2（Phase 10 承接）：存量隔离迁移脚本 E2E（spawn 真 node 跑真脚本）。
 * 拍板 D1：同账本追加治理行不改写旧行；幂等靠 migration_completed 行。
 */

const SCRIPT = join(process.cwd(), 'scripts', 'migrate-experience-v2.mjs')

function run(home: string, ...extra: string[]): string {
  return execFileSync('node', [SCRIPT, ...extra], { env: { ...process.env, PROMA_HOME: home }, encoding: 'utf8' })
}

function seedLedger(home: string): void {
  mkdirSync(home, { recursive: true })
  const cards = [
    // R2 灵感 pattern 卡 ×2（→ reclassified）
    JSON.stringify({ id: 'i1', schema_version: 1, kind: 'pattern', tag: 'pattern/idea/a', status: 'candidate', created_at: 1, updated_at: 1, recurrence: 1, source: { type: 'market' }, fingerprint: 'fp-idea-a', body: { capability: 'idea', implementation_summary: '卡片式灵感' } }),
    JSON.stringify({ id: 'i2', schema_version: 1, kind: 'pattern', tag: 'pattern/idea/b', status: 'candidate', created_at: 1, updated_at: 1, recurrence: 1, source: { type: 'market' }, fingerprint: 'fp-idea-b', body: { capability: 'idea', implementation_summary: '语音灵感' } }),
    // GWT/异常 anti_pattern 卡 ×2（→ quarantined）
    JSON.stringify({ id: 'g1', schema_version: 1, kind: 'anti_pattern', tag: 'coding/gwt/x', status: 'candidate', created_at: 1, updated_at: 1, recurrence: 1, source: { type: 'gwt_failure' }, fingerprint: 'fp-gwt-x', body: { stage: 'testing', symptom: '断言未过', trigger_condition: 't', root_cause: { stage: 'testing', description: '断言未过', method: 'rule', confidence: 1 }, test_checklist: [], review_checklist: [], severity: 2 } }),
    JSON.stringify({ id: 'a1', schema_version: 1, kind: 'anti_pattern', tag: 'unknown/outcome/timeout', status: 'candidate', created_at: 1, updated_at: 1, recurrence: 1, source: { type: 'abnormal' }, fingerprint: 'fp-timeout', body: { stage: 'coding', symptom: '超时', trigger_condition: 't', root_cause: { stage: 'coding', description: '超时', method: 'rule', confidence: 1 }, test_checklist: [], review_checklist: [], severity: 2 } }),
  ]
  writeFileSync(join(home, 'bloma-experience.jsonl'), cards.join('\n') + '\n', 'utf8')
}

describe('migrate-experience-v2 存量隔离（W2.2）', () => {
  it('分类写入治理行（pattern→reclassified、其余→quarantined）；折叠视图生效；幂等重跑', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-mig-'))
    const prevHome = process.env.PROMA_HOME
    process.env.PROMA_HOME = home
    try {
    seedLedger(home)
    const out1 = run(home)
    expect(out1).toContain('reclassified 2 / quarantined 2')

    // 治理行落账本（4 条目标行 + 1 条 migration_completed）
    const rows = readLifecycleRows()
    const mine = rows.filter((r) => r.migration_id === 'v2-isolation-20260916')
    expect(mine).toHaveLength(5)
    expect(mine.filter((r) => r.kind === 'card_reclassified')).toHaveLength(2)
    expect(mine.filter((r) => r.kind === 'card_quarantined')).toHaveLength(2)
    expect(mine.some((r) => r.kind === 'migration_completed')).toBe(true)

    // 折叠视图：四张 v1 卡全部离开消费面
    const folded = foldedFingerprints()
    for (const fp of ['fp-idea-a', 'fp-idea-b', 'fp-gwt-x', 'fp-timeout']) expect(folded.has(fp)).toBe(true)

    // 幂等：重跑直接退出，治理行不增
    const out2 = run(home)
    expect(out2).toContain('幂等退出')
    expect(readLifecycleRows().filter((r) => r.migration_id === 'v2-isolation-20260916')).toHaveLength(5)

    // dry-run 不写
    const home2 = mkdtempSync(join(tmpdir(), 'proma-mig2-'))
    seedLedger(home2)
    const out3 = run(home2, '--dry-run')
    expect(out3).toContain('dry-run')
    expect(existsSync(join(home2, 'bloma-experience.jsonl'))).toBe(true)
    } finally {
      if (prevHome === undefined) delete process.env.PROMA_HOME
      else process.env.PROMA_HOME = prevHome
    }
  })
})
