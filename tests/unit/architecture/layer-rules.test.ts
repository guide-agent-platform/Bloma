/**
 * 层规则测试（PR2 立规批）——六层架构的机器强制。
 *
 * 层秩（数字越大越底层，依赖只准向下）：
 *   0 entry          main 根级（仅 index/ipc/csp）
 *   1 orchestration  main/orchestration/**
 *   2 domain         main/{guide,coding,review,experience,project,verification,delivery,model,kernel,iteration}/**
 *   3 agent          main/agent/**（Agent 运行时，零领域知识目标）
 *   4 platform       main/platform/**（基础设施 + upstream 上游贴面）
 *   5 shared         shared/**
 *
 * 规则：
 *   R1 rank(importer) ≤ rank(target)（只向下；类型导入豁免——不构成运行时耦合。
 *      该规则同时覆盖「agent 零领域」「platform 零上层」两个目标）
 *   R8 main 根级只允许 index.ts/ipc.ts/csp.ts
 *   R9 全仓零「过渡桩」（R4 归位遗留形态）
 *   同层跨组（如 domain 内 coding→project）不设硬规则：domain 子域协作是设计的
 *   正常内部结构；深度耦合在 PR3/PR4 拆解时按 R1 白名单的消减节奏治理。
 *
 * R1 白名单与实际违规做集合精确相等断言：新增违规即红（防增），违规消失也红
 * （强制摘条目，机械落实「白名单只减不增」）。不匹配时全量差异写入同目录
 * layer-violations-report.txt（vitest 会截断长错误消息）。
 */
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { join, dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const REPORT = fileURLToPath(new URL('./layer-violations-report.txt', import.meta.url))

const DOMAIN_GROUPS = [
  'guide', 'coding', 'review', 'experience', 'project', 'verification',
  'delivery', 'model', 'kernel', 'iteration',
] as const
const TOP_RANK: Record<string, number> = {
  orchestration: 1,
  agent: 3,
  platform: 4,
}

/** 层秩：repoRel 为「无扩展名路径」；isDir=true 时视为目录（main/<top> 目录属于 top 层） */
function layerRank(repoRel: string, isDir: boolean): { rank: number; group: string } | null {
  const toPosix = (p: string) => p.split('\\').join('/')
  const rel = toPosix(repoRel)
  if (rel === 'main') return { rank: 0, group: 'entry' } // main 根目录下的文件 = entry
  if (rel.startsWith('main/')) {
    const rest = rel.slice('main/'.length)
    const parts = rest.split('/')
    if (parts.length === 1 && !isDir) return { rank: 0, group: 'entry' } // main 根级文件
    const top = parts[0]
    if (top in TOP_RANK) return { rank: TOP_RANK[top], group: top }
    if ((DOMAIN_GROUPS as readonly string[]).includes(top)) return { rank: 2, group: top }
    return null // templates/prompts 等非代码目录
  }
  if (rel.startsWith('shared/')) return { rank: 5, group: 'shared' }
  return null
}

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', 'dist-main', '.git'].includes(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walkTs(p, acc)
    else if (/\.(ts|tsx|mts|cts)$/.test(name) && !/\.d\./.test(name)) acc.push(p)
  }
  return acc
}

const IMPORT_RE = /^import\s+(type\s+)?(?:[^'"]*?\bfrom\s+)?['"]([^'"]+)['"]/gm
const DYNAMIC_RE = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g

function toPosix(p: string) { return p.split('\\').join('/') }

function collectViolations(): string[] {
  const out: string[] = []
  const scanRoots = [join(REPO, 'main'), join(REPO, 'shared')]
  const files = scanRoots.flatMap((r) => (existsSync(r) ? walkTs(r) : []))
  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    // Windows 路径先统一转 posix 再求相对（posix.relative 不认反斜杠，混用产出垃圾路径）
    const fileRepoDir = posix.normalize(posix.relative(toPosix(REPO), toPosix(dirname(file))))
    const fromLayer = layerRank(fileRepoDir, true)
    if (!fromLayer) continue
    const specs: Array<{ spec: string; typeOnly: boolean }> = []
    for (const m of src.matchAll(IMPORT_RE)) specs.push({ spec: m[2], typeOnly: !!m[1] })
    for (const m of src.matchAll(DYNAMIC_RE)) specs.push({ spec: m[1], typeOnly: false })
    for (const { spec, typeOnly } of specs) {
      if (!spec.startsWith('.')) continue
      if (typeOnly) continue // 类型导入豁免
      const resolved = posix.normalize(posix.join(fileRepoDir, spec))
      const noExt = resolved.replace(/\.(js|mjs|cjs|ts|tsx|mts|cts)$/, '')
      const toLayer = layerRank(noExt, false) ?? layerRank(resolved, false)
      if (!toLayer) continue
      if (fromLayer.rank > toLayer.rank) out.push(`R1|${fileRepoDir} -> ${noExt}`)
    }
  }
  return [...new Set(out)].sort()
}

/**
 * R1 白名单（PR2 基线种子，35 条，按主题分组）。
 * 消减方法：修掉对应耦合后删除条目；集合精确相等断言保证「只减不增」。
 */
const WHITELIST = new Set<string>([
  // ── 主题一：agent/tools 工具面直接 import 领域能力（PR4 tool-handlers 注入反转的目标战场）
  'R1|main/agent/tools -> main/coding/api-contract',
  'R1|main/agent/tools -> main/coding/artifact-ui-gate',
  'R1|main/agent/tools -> main/coding/dist-rebuild',
  'R1|main/agent/tools -> main/coding/preview-browser',
  'R1|main/agent/tools -> main/coding/preview-runtime',
  'R1|main/agent/tools -> main/delivery/sandbox',
  'R1|main/agent/tools -> main/project/document-engine',
  'R1|main/agent/tools -> main/project/project-map',
  'R1|main/agent/tools -> main/project/project-service',
  'R1|main/agent/tools -> main/verification/evidence-cache',
  'R1|main/agent/tools -> main/verification/gwt-runner',
  'R1|main/agent/tools -> main/verification/gwt-service',
  'R1|main/agent/tools -> main/verification/security-scan',
  // ── 主题二：agent/loop 收口/上下文构建引用领域件（PR3 拆 programming-orchestrator 时一并评估归属）
  'R1|main/agent/loop -> main/coding/output-integrity',
  'R1|main/agent/loop -> main/coding/preview-browser',
  'R1|main/agent/loop -> main/kernel/llm-call',
  'R1|main/agent/loop -> main/model/prd-backplane',
  'R1|main/agent/loop -> main/project/decision-log',
  'R1|main/agent/loop -> main/project/document-engine',
  'R1|main/agent/loop -> main/project/learnings-log',
  'R1|main/agent/loop -> main/project/project-service',
  // ── 主题三：agent/prompting 表达层引用 PRD/需求领域件（表达适配层的固有耦合，PR4 评估上提或下沉）
  'R1|main/agent/prompting -> main/coding/sketch-engine',
  'R1|main/agent/prompting -> main/coding/sketch-engine-llm',
  'R1|main/agent/prompting -> main/guide/guide-agent-service',
  'R1|main/agent/prompting -> main/guide/prd-engine-llm',
  'R1|main/agent/prompting -> main/guide/requirement-enricher',
  'R1|main/agent/prompting -> main/guide/requirement-normalizer',
  'R1|main/agent/prompting -> main/model/prd-backplane',
  'R1|main/agent/prompting -> main/project/project-templates',
  // ── 主题四：platform 反向依赖 domain（真违规，治理方向=事件化或函数下沉；PR3 治理）
  'R1|main/platform/llm -> main/project/decision-log',
  'R1|main/platform/mcp -> main/project/project-service',
  'R1|main/platform/sessions -> main/project/project-service',
  'R1|main/platform/shell -> main/project/project-service',
  // ── 主题五：上游贴面适配（loop-query 是薄适配层，允许引用本仓运行时件；保持与上游 diff 最小）
  'R1|main/platform/upstream/providers -> main/agent/loop/thinking-log',
  // ── 主题六：domain 反向依赖 orchestration（PR4 治理：改事件化或回调注入，禁止新增）
  'R1|main/coding/stages -> main/orchestration/recovery-service',
  'R1|main/guide -> main/orchestration/dialogue-router',
])

describe('layer-rules 层规则（PR2 立规批）', () => {
  it('R8: main 根级只允许 index.ts / ipc.ts / csp.ts', () => {
    const rootTs = readdirSync(join(REPO, 'main'))
      .filter((f) => /\.ts$/.test(f) && !/\.d\.ts$/.test(f))
      .sort()
    expect(rootTs).toEqual(['csp.ts', 'index.ts', 'ipc.ts'])
  })

  it('R9: 全仓零「过渡桩」', () => {
    const files = walkTs(join(REPO, 'main')).concat(walkTs(join(REPO, 'shared')))
    const stubs = files.filter((f) => {
      const s = readFileSync(f, 'utf8')
      return s.includes('过渡桩') || (/^export \* from /m.test(s) && s.split('\n').length <= 6)
    })
    expect(stubs, `残留桩: ${stubs.join(', ')}`).toEqual([])
  })

  it('R7: 单文件 ≤800 行——超标须白名单登记（只减不增）', () => {
    const OVERSIZE_WHITELIST = new Set([
      // PR4 拆解目标：guide-agent-service（澄清/PRD 流/市调三缝）、orchestrator（意图路由/状态机/落盘）、
      // agent-tools（tool-handlers 注入反转时拆组）、ipc（按通道族模块化）、prd-review（六维审查逐维拆）、
      // document-engine（文档同步与背板读写分离）。
      // 长期豁免：generate（runMvpViaAgentLoop 主循环内聚）、agent-loop（loop 生命周期商内聚）。
      'main/guide/guide-agent-service.ts',
      'main/orchestration/orchestrator.ts',
      'main/coding/stages/generate.ts',
      'main/agent/loop/agent-loop.ts',
      'main/agent/tools/agent-tools.ts',
      'main/ipc.ts',
      'main/review/prd-review.ts',
      'main/project/document-engine.ts',
      // 契约层类型聚合：shared/types 是四层契约的唯一真相源，长期豁免（如需治理按域拆 types/ 子目录）
      'shared/types.ts',
    ])
    const oversize: string[] = []
    for (const file of walkTs(join(REPO, 'main')).concat(walkTs(join(REPO, 'shared')))) {
      const count = readFileSync(file, 'utf8').split('\n').length
      if (count > 800) {
        const rel = toPosix(file).replace(toPosix(REPO), '').replace(/^\//, '')
        if (!OVERSIZE_WHITELIST.has(rel)) oversize.push(`${rel} (${count} 行)`)
      }
    }
    expect(oversize.sort(), `新增超标文件须先登记 OVERSIZE_WHITELIST：\n${oversize.join('\n')}`).toEqual([])
  })

  it('R1: 依赖只向下（类型导入豁免）——违规集合与白名单精确相等（只减不增）', () => {
    const actual = collectViolations()
    const expected = [...WHITELIST].sort()
    const added = actual.filter((x) => !WHITELIST.has(x))
    const removed = expected.filter((x) => !actual.includes(x))
    if (added.length || removed.length) {
      const report = [
        `# 层规则违规 vs 白名单差异（生成于测试失败时；修完后删除本文件）`,
        `新增违规（须修复或登记理由后加白名单）:`,
        ...added.map((x) => `  + ${x}`),
        ``,
        `已消失违规（请从 WHITELIST 删除对应条目，落实只减不增）:`,
        ...removed.map((x) => `  - ${x}`),
      ].join('\n')
      writeFileSync(REPORT, report)
      throw new Error(
        `层规则违规与白名单不一致（+${added.length} / -${removed.length}），全量差异见 ${REPORT}`,
      )
    }
    expect(actual.length).toBe(expected.length)
  })
})
