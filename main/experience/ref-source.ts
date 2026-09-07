import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { MODULE_SLUG_PATTERN, type OfficialModule } from '../module-library'
import type { TemplateType } from '../../shared/types'
import { licenseTierOf } from './types'

/**
 * G4 正向参考消费源：统一账本里 verified pattern 卡 + 代码 sidecar
 * （`~/.proma/bloma-ref-code/{fp8}/`，G2 批跑产物）→ `OfficialModule[]`，
 * 交给官方模块同一渲染/地图管道（C-1 约束：消费必须走 prepareModuleLibrary
 * 地图注入这条真实驱动链，Agent 侧零新逻辑）。
 *
 * 独立开关 `BLOMA_REF_LIBRARY`（缺省 **off**，C-2 纪律：纯环境变量、不进配置面；
 * 与 BLOMA_EXPERIENCE/BLOMA_MODULES 正交）。
 *
 * 准入政策（全部确定性判定，不信任卡内自报 tier，以 license 字符串现算为准）：
 * - 仅 `kind=pattern && status=verified && sandbox_result.build_pass=true`；
 * - 语言仅 js/universal（产物 vanilla ESM 约束，ts/py 卡 v1 不物化）；
 * - permissive：README+index.js（sidecar 缺码 → 整卡排除）；
 * - weak_copyleft/unknown：仅 README（模式描述复用，不带码=不物化代码）；
 * - strong_copyleft：不物化（G2 入册已拦，双保险）；
 * - 同 slug 冲突保 updated_at 新者；README 懒生成（含 capability/摘要/出处/许可
 *   ——外部来源合规痕迹随目录走）。
 * 任何 IO/解析异常 → warn + 空列表，绝不阻断生成主链。
 */

const LOG = '[experience]'

export function refLibraryEnabled(): boolean {
  const raw = process.env.BLOMA_REF_LIBRARY
  if (!raw) return false
  const v = raw.trim().toLowerCase()
  return v === '1' || v === 'on' || v === 'true'
}

interface RefLedgerCard {
  id?: string
  kind?: string
  tag?: string
  status?: string
  updated_at?: number
  fingerprint?: string
  body?: {
    capability?: string
    language_family?: string
    api_signature?: string
    implementation_summary?: string
    license?: string
    source_url?: string
    reuse_hint?: string
    sandbox_result?: { build_pass?: boolean }
  }
}

function loadLedger(ledgerFile: string): RefLedgerCard[] {
  const byId = new Map<string, RefLedgerCard>()
  if (!existsSync(ledgerFile)) return []
  for (const line of readFileSync(ledgerFile, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const c = JSON.parse(line) as RefLedgerCard
      if (c && c.id) byId.set(c.id, c)
    } catch {
      /* 坏行跳过（与运行时账本读取语义一致） */
    }
  }
  return [...byId.values()]
}

function ensureReadme(sidecarDir: string, card: RefLedgerCard): void {
  const readme = join(sidecarDir, 'README.md')
  if (existsSync(readme)) return
  mkdirSync(sidecarDir, { recursive: true })
  const b = card.body ?? {}
  const text = [
    `# ${b.capability ?? card.tag ?? 'reference pattern'}`,
    '',
    b.implementation_summary ?? '',
    b.api_signature ? `接口：\`${b.api_signature}\`` : '',
    b.reuse_hint ? `复用提示：${b.reuse_hint}` : '',
    '',
    `许可：${b.license ?? 'unknown'}（外部参考，先 read 后模仿改编，勿整段复制）`,
    b.source_url ? `来源：${b.source_url}` : '',
    `账本卡：${card.fingerprint ?? ''}（经验库 verified pattern）`,
  ]
    .filter(Boolean)
    .join('\n')
  writeFileSync(readme, text, 'utf8')
}

export function listRefPatternModules(type: TemplateType, homeRoot: string = getPromaHome()): OfficialModule[] {
  if (!refLibraryEnabled()) return []
  try {
    const candidates: Array<{ slug: string; updatedAt: number; mod: OfficialModule }> = []
    for (const card of loadLedger(join(homeRoot, 'bloma-experience.jsonl'))) {
      if (card.kind !== 'pattern' || card.status !== 'verified') continue
      const body = card.body
      if (!body || body.sandbox_result?.build_pass !== true) continue
      if (body.language_family !== 'js' && body.language_family !== 'universal') continue
      const slug = String(card.tag ?? '').split('/').pop() ?? ''
      if (!MODULE_SLUG_PATTERN.test(slug)) continue
      const tier = licenseTierOf(body.license)
      if (tier === 'strong_copyleft') continue
      const fp8 = String(card.fingerprint ?? '').slice(0, 8)
      if (!fp8) continue
      const sidecarDir = join(homeRoot, 'bloma-ref-code', fp8)
      const codePath = join(sidecarDir, 'index.js')
      if (tier === 'permissive' && !existsSync(codePath)) continue // 参考实现缺失 → 不带码卡价值低，v1 排除
      const files: OfficialModule['files'] = []
      ensureReadme(sidecarDir, card)
      files.push({ path: 'README.md', role: '模式说明/出处/许可' })
      if (tier === 'permissive') {
        files.push({ path: 'index.js', role: `参考实现（编译沙箱已通过）：${body.api_signature ?? ''}` })
      }
      candidates.push({
        slug,
        updatedAt: card.updated_at ?? 0,
        mod: {
          slug,
          name: String(body.capability ?? slug).slice(0, 120),
          categories: [type],
          version: 1,
          summary: String(body.implementation_summary ?? '').slice(0, 200),
          whenToUse: String(body.reuse_hint ?? '').slice(0, 200),
          whenNotToUse: '外部检索参考——许可与出处以本目录 README 为准，参考模仿不整段复制',
          files,
          baseDir: sidecarDir,
          source: 'ref',
        },
      })
    }
    const bySlug = new Map<string, { slug: string; updatedAt: number; mod: OfficialModule }>()
    for (const c of candidates) {
      const existing = bySlug.get(c.slug)
      if (!existing || c.updatedAt > existing.updatedAt) bySlug.set(c.slug, c)
    }
    return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug)).map((c) => c.mod)
  } catch (error) {
    console.warn(`${LOG} ref module load failed:`, (error as Error)?.message)
    return []
  }
}
