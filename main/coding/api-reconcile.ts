/**
 * 前端⇄路由⇄契约三方静态对账（Phase 9 W1.3，2026-09-12；B 站播放器案 214397c3）。
 *
 * 案发形态：loop 写了前端 bilibili.js 调 /api/bili/view、/api/bili/playurl，但
 * server/routes/ 目录不存在（plan 清单 5 文件全前端）；interface_spec 为空 →
 * api-contract 无契约豁免 → 终验 9/9 假绿交付，用户实测完全无法播放。
 *
 * 本模块在终验时做纯静态三方对账（无需预览运行、无网络请求，磁盘确定性）：
 *   反向（主检查）：前端源码引用的 /api/<前缀> ⇄ server/routes/ 挂载前缀
 *     —— 引用前缀无路由文件 → 失败（前端发明 API 后端缺失，B 站案主死因）
 *   正向：interface_spec 端点前缀 ⇄ 路由前缀 —— 契约端点无路由实现 → 失败
 *     （占位端点 /api/external 除外：它是「必须有服务端代理」的兜底信号，
 *      实际子路径由 loop 对齐业务，只参与「路由目录整体缺失」判定）
 *
 * 豁免前缀：/api/llm（平台内置代理，static-server 原生挂载）、/_bloma/（B1 健康端点）。
 * SPA fallback 返回 HTML 200 的假阳性属探测层问题，归 api-contract 的语义检查，
 * 静态对账不受影响。
 *
 * 开关 BLOMA_API_RECONCILE（缺省 off = 字节级现状）。失败以 GwtFailureSummary
 * 并入 runGwtWithApiContract（与 L0 门禁、api-contract 同款合并位）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GwtFailureSummary } from '../verification/test-legacy'

/** 平台内置端点前缀：产物服务器原生挂载，不要求 server/routes/ 文件。 */
const BUILTIN_PREFIXES = new Set(['llm'])

/** W1.2 派生的占位端点：不参与正向红判（见文件头）。 */
const PLACEHOLDER_PREFIX = 'external'

/** 开关：off = 调用方零注入（字节级现状）。 */
export function apiReconcileEnabled(): boolean {
  return process.env.BLOMA_API_RECONCILE === '1' || process.env.BLOMA_API_RECONCILE === 'true'
}

/** 收集目录下全部 .js 文件的挂载前缀（bili.js → 'bili'）；目录不存在 → 空集。 */
export function listRoutePrefixes(projectRoot: string): Set<string> {
  const dir = join(projectRoot, 'server', 'routes')
  if (!existsSync(dir)) return new Set()
  try {
    return new Set(
      readdirSync(dir)
        .filter((f) => f.endsWith('.js'))
        .map((f) => f.replace(/\.js$/, '')),
    )
  } catch {
    return new Set()
  }
}

/** 扫描前端源码中的 /api/<前缀> 引用。只读 src/ 与 index.html；排除只读参考目录、
 *  dist 构建产物与 server/ 自身（后端文件引用自身不算前端调用）。 */
export function collectFrontendApiPrefixes(projectRoot: string): Set<string> {
  const prefixes = new Set<string>()
  const API_REF_RE = /['"`/]api\/([a-z0-9_-]+)/g
  const visit = (dir: string): void => {
    let entries: Array<{ name: string; isDirectory: () => boolean }> = []
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory: () => boolean }>
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'official-modules' || e.name === 'ref-modules' || e.name === 'node_modules') continue
        visit(full)
      } else if (e.name.endsWith('.js') || e.name === 'index.html') {
        let text = ''
        try {
          text = readFileSync(full, 'utf8')
        } catch {
          continue
        }
        for (const m of text.matchAll(API_REF_RE)) prefixes.add(m[1])
      }
    }
  }
  visit(join(projectRoot, 'src'))
  const indexHtml = join(projectRoot, 'index.html')
  if (existsSync(indexHtml)) {
    try {
      for (const m of readFileSync(indexHtml, 'utf8').matchAll(API_REF_RE)) prefixes.add(m[1])
    } catch {
      /* 读失败按无引用处理 */
    }
  }
  return prefixes
}

/** 三方对账主入口：返回失败清单（空数组 = 对账通过或开关 off）。
 *  specPrefixes 传 interface_spec 端点的前缀集合（调用方从背板提取）。 */
export function reconcileApiUsage(input: {
  projectRoot: string
  specPrefixes?: string[]
}): GwtFailureSummary[] {
  if (!apiReconcileEnabled()) return []
  const routePrefixes = listRoutePrefixes(input.projectRoot)
  const frontendPrefixes = collectFrontendApiPrefixes(input.projectRoot)
  const failures: GwtFailureSummary[] = []

  // 反向：前端引用 ⇄ 路由（B 站案主死因：引用 bili、路由空集）
  for (const prefix of [...frontendPrefixes].sort()) {
    if (BUILTIN_PREFIXES.has(prefix)) continue
    if (!routePrefixes.has(prefix)) {
      failures.push({
        scenario: `API 对账（反向）：/api/${prefix}`,
        reason: `前端代码引用了 /api/${prefix}，但 server/routes/ 下没有对应路由文件（${prefix}.js）——只交付前端外壳，能力不存在。请在 server/routes/${prefix}.js 实现路由（CJS 模块格式，样例见 _example.js），或移除前端调用`,
      })
    }
  }

  // 正向：契约端点 ⇄ 路由（占位 external 除外；无路由目录时 external 也红——
  // 外部服务需求必须有服务端代理，一行路由都不写即为缺失）
  const hasRoutesDir = routePrefixes.size > 0
  for (const prefix of [...(input.specPrefixes ?? [])].sort()) {
    if (BUILTIN_PREFIXES.has(prefix)) continue
    if (prefix === PLACEHOLDER_PREFIX && hasRoutesDir) continue
    if (!routePrefixes.has(prefix)) {
      failures.push({
        scenario: `API 对账（正向）：/api/${prefix}`,
        reason: `interface_spec 声明了 /api/${prefix}，但 server/routes/ 下没有对应路由文件（${prefix}.js）——契约端点未实现`,
      })
    }
  }
  return failures
}

/** W1.4 静态媒体源检查（B 站案第三死因：外链直连 CSP+防盗链双拦）：产物源码中
 *  硬编码的外链媒体源（<video src="https://…、.src = 'https://…）→ 失败；
 *  外链必须经 server/routes/ 同源代理。运行时变量赋值（src = apiResult.url）静态
 *  扫不到，由【媒体纪律】提示词层与媒体健康探针兜底。同 BLOMA_API_RECONCILE 开关
 *  （终验静态对账族）。 */
export function checkMediaSourceDiscipline(projectRoot: string): GwtFailureSummary[] {
  if (!apiReconcileEnabled()) return []
  const failures: GwtFailureSummary[] = []
  // 字面量外链媒体源：HTML 属性（video/audio/source 的 src="https://…）或 JS 字符串赋值（.src = 'https://…）
  const EXTERNAL_MEDIA_RE = /(?:<(?:video|audio|source)[^>]+src=["']|\.src\s*=\s*["'])(https?:\/\/[^"']+)/g
  const visit = (dir: string): void => {
    let entries: Array<{ name: string; isDirectory: () => boolean }> = []
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory: () => boolean }>
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'official-modules' || e.name === 'ref-modules' || e.name === 'node_modules') continue
        visit(full)
      } else if (e.name.endsWith('.js') || e.name.endsWith('.html')) {
        let text = ''
        try {
          text = readFileSync(full, 'utf8')
        } catch {
          continue
        }
        for (const m of text.matchAll(EXTERNAL_MEDIA_RE)) {
          failures.push({
            scenario: '媒体源纪律（外链直连）',
            reason: `硬编码外链媒体源 ${m[1].slice(0, 60)}——CSP 只放同源且第三方 CDN 多有 Referer 防盗链，直连必败；改为 server/routes/ 同源代理转发`,
          })
        }
      }
    }
  }
  visit(join(projectRoot, 'src'))
  const indexHtml = join(projectRoot, 'index.html')
  if (existsSync(indexHtml)) {
    try {
      for (const m of readFileSync(indexHtml, 'utf8').matchAll(EXTERNAL_MEDIA_RE)) {
        failures.push({
          scenario: '媒体源纪律（外链直连）',
          reason: `硬编码外链媒体源 ${m[1].slice(0, 60)}——CSP 只放同源且第三方 CDN 多有 Referer 防盗链，直连必败；改为 server/routes/ 同源代理转发`,
        })
      }
    } catch {
      /* 读失败按无命中处理 */
    }
  }
  return failures
}
