/**
 * G2 正向参考批跑（T-7 核心链路；websearch 产出 pattern 卡）：
 *
 *   缺口(G1) → DDG 检索(免 key，guide-research 同口径) → 页面提取(预算口径)
 *   → LLM 提炼模式卡(禁整段复制，模式级描述+最小无依赖实现) → license 分级
 *   （types.licenseTierOf 单一事实源）→ **编译级沙箱**（esbuild --bundle 校验；
 *   SANDBOX_SMOKE=1 才真跑 node 冒烟——LLM 生成代码缺省不执行，用户裁定）→
 *   permissive+编译过：入册 verified(sandbox_pass) + 代码 sidecar
 *   (~/.proma/bloma-ref-code/{fp8}/)；否则 candidate 带失败口径（永不注入/物化）；
 *   strong_copyleft 拒绝入册（版权红线）。
 *
 * 外部依赖全部经 deps seam 注入（search/fetchHtml/llm/sandbox），离线全测；
 * CLI --live 仅接通检索与提取（DDG），LLM 提炼由批跑编排层（automation agent）
 * 注入执行——脚本自身不携带渠道凭据逻辑。
 * 用法：node scripts/harvest-references.mjs --gaps <gap.json> [--execute] [--live]
 *      缺省 dry-run 报表，绝不写账本/sidecar。类型声明见 harvest-references.d.mts。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ledgerPath, promaHome, sha256, upsertCard } from './lib/experience-ledger'

/** types.ts 经 esbuild 现场打包复用（与 backfill 同法，零实现漂移）。 */
async function loadTypes(repoRoot) {
  const { build } = await import('esbuild')
  const out = join(repoRoot, '.tmp-harvest-types.mjs')
  await build({
    entryPoints: [join(repoRoot, 'main', 'experience', 'types.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    logLevel: 'silent',
  })
  try {
    return { mod: await import(pathToFileURL(out).href), cleanup: () => rmSync(out, { force: true }) }
  } catch (error) {
    rmSync(out, { force: true })
    throw error
  }
}

export const REFINE_PROMPT = [
  'You are extracting a reusable coding pattern from a web page.',
  'Page content (truncated):',
  '{page}',
  '',
  'Extract the pattern at a conceptual level. Do NOT copy code verbatim.',
  'Return JSON only:',
  '{"capability":"...","language_family":"ts|js|py|universal","api_signature":"...","implementation_summary":"2-3 sentences, no code","reuse_hint":"...","license":"SPDX or unknown","minimal_implementation":"dependency-free ES code implementing api_signature"}',
].join('\n')

/** 确定性编译沙箱：esbuild --bundle 校验最小实现可编译（缺省不执行生成代码）。 */
export function makeCompileSandbox(repoRoot, T) {
  return async function sandbox(_refined, code) {
    const dir = join(repoRoot, `.sandbox-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(dir, { recursive: true })
    const entry = join(dir, 'index.js')
    const started = Date.now()
    try {
      writeFileSync(entry, code, 'utf8')
      const r = spawnSync(
        process.execPath,
        [join(repoRoot, 'node_modules', 'esbuild', 'bin', 'esbuild'), entry, '--bundle', '--format=esm', `--outfile=${join(dir, 'out.js')}`],
        { encoding: 'utf8', timeout: (T.EXPERIENCE_GOVERNANCE && T.EXPERIENCE_GOVERNANCE.SANDBOX_TIMEOUT_MS) || 30000 },
      )
      if (r.status !== 0) {
        return { build_pass: false, smoke_test_pass: undefined, executed_at: started, error: String(r.stderr || (r.error && r.error.message) || `exit ${r.status}`).slice(0, 300) }
      }
      if (process.env.SANDBOX_SMOKE === '1') {
        const s = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 5000 })
        return { build_pass: true, smoke_test_pass: s.status === 0, executed_at: started, ...(s.status === 0 ? {} : { error: String(s.stderr).slice(0, 300) }) }
      }
      return { build_pass: true, smoke_test_pass: undefined, executed_at: started }
    } catch (error) {
      return { build_pass: false, smoke_test_pass: undefined, executed_at: started, error: String((error && error.message) || error).slice(0, 300) }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** 页面 → 模式文本（预算同 web-reference-extractor：title+headings≤6+pre/code≤4×2KB+正文 1.2KB）。 */
export function extractPatternText(html) {
  const s = String(html ?? '')
  const title = (/<title[^>]*>([^<]{1,120})<\/title>/i.exec(s) || [])[1] ?? ''
  const headings = [...s.matchAll(/<h[1-3][^>]*>([^<]{1,160})<\/h[1-3]>/gi)].slice(0, 6).map((m) => m[1].trim())
  const codeBlocks = [...s.matchAll(/<pre[^>]*>([\s\S]{0,2000}?)<\/pre>/gi)].slice(0, 4).map((m) => m[1].replace(/<[^>]+>/g, '').trim())
  const text = s
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 1200)
  return [title, ...headings, text, ...codeBlocks].filter(Boolean).join('\n')
}

/**
 * 单缺口流水线（依赖全注入，可离线测）。verdict ∈
 * verified|candidate|rejected|skipped|failed。
 */
export async function harvestGap(gap, deps) {
  const { T, search, fetchHtml, llm, sandbox, root, dryRun } = deps
  const query = (gap.suggested_queries && gap.suggested_queries[0]) || gap.capability
  let hits
  try {
    hits = await search(query)
  } catch (error) {
    return { verdict: 'failed', reason: `search: ${String(error).slice(0, 120)}` }
  }
  if (!hits || hits.length === 0) return { verdict: 'skipped', reason: 'no_search_results' }

  let page = ''
  let sourceUrl = ''
  for (const hit of hits.slice(0, 3)) {
    try {
      const extracted = extractPatternText(await fetchHtml(hit.url))
      if (extracted.length >= 80) {
        page = extracted.slice(0, 8000)
        sourceUrl = hit.url
        break
      }
    } catch {
      /* 单源失败换下一个 */
    }
  }
  if (!page) return { verdict: 'skipped', reason: 'no_extractable_page' }

  let refined
  try {
    const raw = await llm(REFINE_PROMPT.replace('{page}', page))
    const m = /(\{[\s\S]*\})/.exec(raw ?? '')
    if (!m) return { verdict: 'failed', reason: 'llm_invalid_json' }
    refined = JSON.parse(m[1])
  } catch (error) {
    return { verdict: 'failed', reason: `llm: ${String(error).slice(0, 120)}` }
  }
  if (!refined || !refined.capability || !refined.api_signature) return { verdict: 'failed', reason: 'llm_missing_fields' }

  const tier = T.licenseTierOf(refined.license)
  if (tier === 'strong_copyleft') {
    return { verdict: 'rejected', reason: `strong_copyleft:${refined.license}`, capability: refined.capability, sourceUrl }
  }
  const code = tier === 'permissive' && typeof refined.minimal_implementation === 'string' && refined.minimal_implementation.trim() ? refined.minimal_implementation : null

  let buildPass = false
  let smokePass
  let sandboxError = code ? undefined : 'no_code_skipped_sandbox'
  const executedAt = Date.now()
  if (code) {
    const sb = await sandbox(refined, code)
    buildPass = sb.build_pass
    smokePass = sb.smoke_test_pass
    sandboxError = sb.error
  }

  const lang = ['ts', 'js', 'py', 'universal'].includes(refined.language_family) ? refined.language_family : 'js'
  const body = {
    capability: String(refined.capability).slice(0, 300),
    language_family: lang,
    api_signature: String(refined.api_signature).slice(0, 400),
    implementation_summary: String(refined.implementation_summary ?? '').slice(0, 600),
    files: [],
    license: String(refined.license ?? 'unknown').slice(0, 60),
    license_tier: tier,
    source_url: sourceUrl,
    sandbox_result: { build_pass: buildPass, smoke_test_pass: smokePass, executed_at: executedAt },
    reuse_hint: String(refined.reuse_hint ?? '').slice(0, 300),
  }
  // slug 协议对齐：MODULE_SLUG_PATTERN 只认连字符，keyFromSymptom 下划线须转换（首张 live 卡暴露的集成 bug）
  const tag = `pattern/${lang}/${T.keyFromSymptom(body.capability).replace(/_/g, '-')}`
  const fp = T.computeFingerprint('pattern', body)

  // sidecar 先写、files 随卡一次入册（body.files 单一事实源）
  if (code && buildPass && !dryRun) {
    const codeHash = sha256(code).slice(0, 16)
    const dir = join(root, 'bloma-ref-code', fp.slice(0, 8))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.js'), code, 'utf8')
    writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ capability: body.capability, api_signature: body.api_signature, license: body.license, license_tier: tier, source_url: sourceUrl, reuse_hint: body.reuse_hint, slug: tag.split('/').pop(), code_hash: codeHash }, null, 2), 'utf8')
    body.files = [{ relative_path: 'index.js', content_hash: codeHash }]
  }

  const now = Date.now()
  const card = T.sanitizeCard({
    id: (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : `bf-${now}-${Math.random().toString(36).slice(2)}`,
    schema_version: T.EXPERIENCE_GOVERNANCE.SCHEMA_VERSION,
    kind: 'pattern',
    tag,
    status: code && buildPass ? 'verified' : 'candidate',
    created_at: now,
    updated_at: now,
    recurrence: 1,
    source: { type: 'web_reference', project_hash: 'harvest', timestamp: now },
    fingerprint: fp,
    body,
    seen_projects: ['harvest'],
    ...(code && buildPass ? { verified_by: 'sandbox_pass', last_verified_at: now } : {}),
  })
  if (!dryRun) {
    const res = upsertCard(ledgerPath(root), card)
    if (res === 'skipped') return { verdict: 'skipped', reason: 'already_harvested', capability: body.capability }
  }
  return { verdict: card.status, capability: body.capability, tag: card.tag, license_tier: tier, build_pass: buildPass, sandbox_error: sandboxError, sourceUrl }
}

// —— live 模式缺省实现（仅 --live）——
// 实弹坑（2026-09-07 01:55 本机诊断）：DDG 按 TLS 指纹屏蔽 node fetch（undici 直接
// fetch failed），curl/浏览器可过——live 走 curl 子进程；结果过滤 duckduckgo 广告
// （y.js?ad_domain 系）。与产品 guide-research 的差异：Electron net 栈不被指纹屏蔽。
function curlGet(url, timeoutSec) {
  const r = spawnSync('curl', ['-sL', '--max-time', String(timeoutSec), '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) (bloma-harvest 1.0; educational)', url], {
    encoding: 'utf8',
    timeout: (timeoutSec + 10) * 1000,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (r.status !== 0 || !r.stdout) throw new Error(`curl failed (status=${r.status}) for ${url.slice(0, 80)}`)
  return r.stdout
}

async function liveSearch(query) {
  const html = curlGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, 15)
  return [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) => ({ raw: m[1], title: m[2].replace(/<[^>]+>/g, '').trim() }))
    .filter((x) => !/y\.js\?|ad_domain/i.test(x.raw))
    .slice(0, 5)
    .map((x) => ({ url: decodeURIComponent((/uddg=([^&]+)/.exec(x.raw) || [])[1] || x.raw), title: x.title }))
}
async function liveFetchHtml(url) {
  return curlGet(url, 15).slice(0, 200000)
}

async function main() {
  const argv = process.argv
  const flagVal = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const gapsPath = flagVal('--gaps')
  const execute = argv.includes('--execute')
  const live = argv.includes('--live')
  const root = promaHome(flagVal('--root'))
  const repoRoot = process.env.BLOMA_ROOT || process.cwd()
  if (!gapsPath) {
    console.error('[harvest] 用法：node scripts/harvest-references.mjs --gaps <gap.json> [--execute] [--live] [--max N]')
    process.exit(1)
  }
  const report = JSON.parse(readFileSync(gapsPath, 'utf8'))
  const { T, cleanup } = await loadTypes(repoRoot)
  try {
    const deps = {
      T,
      root,
      dryRun: !execute,
      search: live ? liveSearch : async () => { throw new Error('search seam 未注入：离线请加 --live 或由编排层调用 harvestGap') },
      fetchHtml: live ? liveFetchHtml : async () => '',
      llm: async () => { throw new Error('llm seam 未注入：提炼由批跑编排层（automation agent）执行') },
      sandbox: makeCompileSandbox(repoRoot, T),
    }
    const max = Number(flagVal('--max') || 5)
    const results = []
    for (const gap of (report.gaps || []).slice(0, max)) {
      const r = await harvestGap(gap, deps)
      results.push({ capability: gap.capability, ...r })
      console.log(`[harvest] ${gap.capability} -> ${r.verdict}${r.reason ? ` (${r.reason})` : ''}`)
    }
    console.log(`[harvest] done: verified=${results.filter((x) => x.verdict === 'verified').length} candidate=${results.filter((x) => x.verdict === 'candidate').length} execute=${execute}`)
    if (execute) writeFileSync(join(root, 'harvest-last-report.json'), JSON.stringify(results, null, 2), 'utf8')
  } finally {
    cleanup()
  }
}

if (process.argv[1] && String(process.argv[1]).replace(/\\/g, '/').endsWith('scripts/harvest-references.mjs')) {
  main().catch((error) => {
    console.error('[harvest] failed:', error)
    process.exit(1)
  })
}
