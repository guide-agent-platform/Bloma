/**
 * G1 缺口报告（T-7 正向参考批跑的进料驱动）：
 * 回答「检索该找什么」——从两类既有事实推导缺口，而非拍脑袋关键词：
 * - 面 A：官方模块库已认定的能力域（main/templates/official-modules/<group>/<slug>/module.json），
 *   账本里无对应 verified pattern → 补等价模式卡缺口；
 * - 面 B：账本中达消费阈的 anti_pattern tag（错误经验），无对应 pattern →
 *   缺正向参照的错误域（用户裁定：错误驱动检索）。
 * 输出 JSON（gaps + suggested_queries 确定性组装）。
 *
 * 用法：node scripts/gap-report.mjs [--root <PROMA_HOME>] [--json <out-path>]
 * 纯读脚本，无副作用（除 --json 显式写报表文件）。
 * 类型声明见 gap-report.d.mts（供 vitest 直测，先例 calibrate-loop-params）。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function normalizeCap(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export function loadOfficialModules(modulesDir) {
  const out = []
  if (!existsSync(modulesDir)) return out
  for (const group of readdirSync(modulesDir)) {
    const groupDir = join(modulesDir, group)
    for (const slug of readdirSync(groupDir)) {
      const manifest = join(groupDir, slug, 'module.json')
      if (!existsSync(manifest)) continue
      try {
        const m = JSON.parse(readFileSync(manifest, 'utf8'))
        if (m && m.slug) out.push({ slug: m.slug, name: m.name ?? m.slug, categories: m.categories ?? [], summary: m.summary ?? '' })
      } catch {
        /* 脏 manifest 跳过 */
      }
    }
  }
  return out
}

export function loadLedgerView(ledgerPath) {
  const byId = new Map()
  if (!existsSync(ledgerPath)) return byId
  for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const c = JSON.parse(line)
      if (c && c.id) byId.set(c.id, c)
    } catch {
      /* 坏行跳过 */
    }
  }
  return byId
}

function capabilityTokens(card) {
  const parts = [String(card.tag ?? '').split('/').pop() ?? '']
  if (card.kind === 'pattern' && card.body && card.body.capability) parts.push(card.body.capability)
  return parts.map(normalizeCap).filter(Boolean)
}

export function buildGapReport({ root, modulesDir }) {
  const envHome = (process.env.PROMA_HOME ?? '').trim()
  const promaHome = root || (envHome && envHome !== 'undefined' && envHome !== 'null' ? envHome : join(homedir(), '.proma'))
  const cards = [...loadLedgerView(join(promaHome, 'bloma-experience.jsonl')).values()].filter((c) => c.status !== 'retired')
  const verifiedPatterns = cards.filter((c) => c.kind === 'pattern' && c.status === 'verified')
  // 误报隔离卡不进缺口统计消费面（与 main/experience isFalsePositiveQuarantined 谓词同语义）
  const consumableAntis = cards.filter((c) => c.kind === 'anti_pattern' && !c.body?.suspected_false_positive && (c.status === 'verified' || (c.recurrence ?? 1) >= 2))
  const covered = new Set(verifiedPatterns.flatMap(capabilityTokens))

  const gaps = []
  // 面 A：官方模块能力域无 verified pattern
  const modules = modulesDir ? loadOfficialModules(modulesDir) : []
  for (const m of modules) {
    const key = normalizeCap(m.slug)
    if (covered.has(key)) continue
    const words = m.slug.replace(/-/g, ' ')
    gaps.push({
      kind: 'official_capability_without_pattern',
      capability: m.slug,
      related_templates: m.categories,
      suggested_queries: [`typescript ${words} implementation pattern`, `${words} best practice vanilla js`],
    })
  }
  // 面 B：达阈错误 tag 无对应正向参考（同 key 去重；misc 无信息量忽略）
  const patternTagKeys = new Set(verifiedPatterns.map((p) => normalizeCap(String(p.tag ?? '').split('/').pop())))
  const seenErr = new Set()
  for (const a of consumableAntis) {
    const last = normalizeCap(String(a.tag ?? '').split('/').pop())
    if (!last || last === 'misc' || seenErr.has(last)) continue
    seenErr.add(last)
    const hasRef = covered.has(last) || [...patternTagKeys].some((k) => k.length > 2 && (k.includes(last) || last.includes(k)))
    if (hasRef) continue
    gaps.push({
      kind: 'error_tag_without_pattern',
      capability: last,
      related_templates: [
        ...new Set(
          consumableAntis
            .filter((x) => normalizeCap(String(x.tag ?? '').split('/').pop()) === last)
            .map((x) => String(x.tag ?? '').split('/')[0] ?? 'unknown'),
        ),
      ],
      suggested_queries: [`how to correctly handle ${last.replace(/_/g, ' ')} vanilla javascript`, `${last.replace(/_/g, ' ')} common mistakes`],
    })
  }
  return {
    generated_at: new Date().toISOString(),
    root: promaHome,
    verified_patterns: verifiedPatterns.length,
    consumable_anti_tags: seenErr.size,
    total_gaps: gaps.length,
    gaps,
  }
}

function main() {
  const report = buildGapReport({
    root: process.argv.includes('--root') ? process.argv[process.argv.indexOf('--root') + 1] : undefined,
    modulesDir: join(process.env.BLOMA_ROOT || process.cwd(), 'main', 'templates', 'official-modules'),
  })
  console.log(`[gap-report] verified_patterns=${report.verified_patterns} gaps=${report.total_gaps}`)
  for (const g of report.gaps.slice(0, 15)) console.log(`  - [${g.kind}] ${g.capability} → ${g.suggested_queries[0]}`)
  const jsonFlag = process.argv.indexOf('--json')
  if (jsonFlag >= 0 && process.argv[jsonFlag + 1]) {
    writeFileSync(process.argv[jsonFlag + 1], JSON.stringify(report, null, 2), 'utf8')
    console.log(`[gap-report] 报表写入 ${process.argv[jsonFlag + 1]}`)
  }
}

if (process.argv[1] && String(process.argv[1]).replace(/\\/g, '/').endsWith('scripts/gap-report.mjs')) {
  main()
}
