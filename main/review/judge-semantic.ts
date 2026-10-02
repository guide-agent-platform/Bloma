/**
 * MVP 语义审查腿（judge-semantic）——裁判域 LLM 审查，2026-08-26。
 *
 * 与 prd-review（PRD 门的简化版 AC 六维审计）刻意区分：本模块审的是
 * 「生成的产物是否忠实实现了 PRD 的每个功能项」（语义级做偏/做漏/做错），
 * 用户明确不使用 AC 审计方法论——问题域是产物对需求的忠实性，不是文档质量。
 *
 * 定位与边界：
 * - 归裁判域（只判定、不修复、不提修复方案），结果合成进 runJudgeReview 的
 *   既有裁决流（退回计数 / 修复循环 / 让渡），不另立门禁。
 * - 规则先行：judge 规则引擎 return 时本腿不跑（省一次 LLM 调用）——规则
 *   硬伤先修，语义审查只在规则全绿后把关「做没做对」。
 * - 防误杀：不确定 → unverified（不算失败，canvas/动画等非文本实现不误杀）；
 *   证据必须引用产物代码；LLM 失败/无渠道 → 跳过并留痕，绝不阻断交付
 *   （规则约束已把关基础质量，语义腿是增强）。
 *
 * 严重度推导（代码级，不信任模型自报结论）：
 * - P0 功能项 missing / deviated → blocking
 * - P0 partial 或 P1 missing / deviated → major
 * - 其余（P2、unverified）→ 不构成失败，仅入 detail 备查
 */

import type { PrdBackplane, SketchRequirement } from '../coding/sketch-engine'
import { backplaneAiCapabilities, capContractEnabled, renderCapSection, requirementPriority } from '../coding/sketch-engine'
import type { SDKQuery } from '../orchestration/orchestrator'
import type { JudgeConstraint } from './judge-engine'
import { runDelegatedReview } from './review-delegation'
import { adversarialReviewEnabled, runAdversarialSemanticReview } from './adversarial-review'
import { ANTIDEGRADE_JUDGE_RULES, antidegradeEnabled } from './judge-antidegrade'
import type { AgentEvent } from '../../shared/types'

// =========================================================================
// 类型
// =========================================================================

export type SemanticStatus = 'implemented' | 'partial' | 'missing' | 'deviated' | 'unverified'

export interface SemanticFinding {
  requirement_id: string
  status: SemanticStatus
  evidence: string
}

export interface SemanticJudgeResult {
  /** 合成进 JudgeVerdict.hard_constraints 的约束（null = 跳过，不影响裁决） */
  constraint: JudgeConstraint | null
  findings: SemanticFinding[]
  skipped: boolean
  skipReason?: 'no_channel' | 'llm_failed'
  /** 未跳过时的执行方式：adversarial = 攻防轮次（C3）；delegation = 委派子 agent（可视化）；direct = 平台直连 */
  via?: 'adversarial' | 'delegation' | 'direct'
  /** C3 攻防元信息（via=adversarial 时在场：轮次与被反驳项，可观测面） */
  adversarial?: { rounds: number; refuted: string[] }
}

/** 产物文本截断上限（防超长产物撑爆审查请求；截断在 prompt 中如实标注） */
const ARTIFACT_CHAR_LIMIT = 24_000

/** 语义裁判 system prompt（非 AC：审「产物是否忠实实现需求」）。 */
export const SEMANTIC_JUDGE_SYSTEM_PROMPT = [
  '你是裁判（Judge），审查一份生成的软件产物是否忠实实现了产品需求。只判定，不修复，不许提修复方案。',
  '',
  // P5 术语纪律（2026-09-04）：与 loop/Defender 同源词表，措辞按裁判角色微调；
  // 只约束叙述用词，JSON 字段名/枚举值不动（硬约束：契约字段零变更）
  '【术语纪律】判定叙述与 evidence 文案使用以下规范词，禁止同义漂移（不得混用右侧同义词）：' +
  '功能项（非"需求点/feature"）、断言（非"验收点"）、场景（非"用例/test case"）、' +
  '探针（非"测试脚本/自动化测试"）、骨架（非"模板项目/脚手架"）、背板（非"PRD 文档/需求文档"）、' +
  '修复轮（非"重试/返工"）。JSON 字段与枚举值不变，只约束文字表述。',
  '',
  '【判定对象】每个功能项逐条判定实现状态：',
  '- implemented：已实现（给出产物代码证据）',
  '- partial：只实现了一部分（说明缺了什么）',
  '- missing：产物中完全没有对应实现',
  '- deviated：实现了但明显偏离需求（说明偏成什么了）',
  '- unverified：无法从代码判断（如纯 canvas/动画/视觉类实现）——宁可 unverified，不要猜',
  '',
  '【规则】',
  '- 每条判定必须引用产物代码证据（片段或关键标识）；无证据不得判 missing/deviated',
  '- 判 missing/deviated 前先全文搜索同义实现（中文/英文、驼峰/下划线变体）',
  // W6（2026-09-18 裁判三连退实锤）：行为等价豁免——PRD 措辞含实现机制（如 F-010 写
  // 「浏览器 localStorage」）而产物以等价或更优机制（后端 data/ 持久化）实现同一可观察
  // 行为（重开仍在）时判 implemented；措辞纪律已在 PRD 生成侧治本，此条是双保险。
  '- 功能项措辞含实现机制（如存储方式/技术选型）而产物以等价或更优机制实现了同一可观察行为时，判 implemented 并在 evidence 注明机制差异，不因机制不符判 deviated',
  '- 不评论代码风格、性能、美观——只关心「需求有没有被忠实实现」',
  '- 测试报告仅供参考（全过不代表语义没偏），以你读到的代码为准',
  '',
  '【输出】严格 JSON，不要 markdown 围栏，不要任何多余文字：',
  '{"findings":[{"requirement_id":"F-001","status":"implemented","evidence":"产物中的关键代码片段或标识"}]}',
].join('\n')

/**
 * 语义裁判 system prompt 装配（Phase 3 B4）：开关 off 返回内置常量（字节级现状）；
 * on 时追加反退化规则三条（CRUD≠能力完成/证据不足不得判 implemented/无需求依据控件判 deviated）。
 * export：供单测与后续注入点复用。
 */
export function buildSemanticJudgeSystemPrompt(): string {
  return antidegradeEnabled() ? `${SEMANTIC_JUDGE_SYSTEM_PROMPT}\n\n${ANTIDEGRADE_JUDGE_RULES}` : SEMANTIC_JUDGE_SYSTEM_PROMPT
}

/**
 * 语义审查主入口：LLM 逐功能项判定 → 代码级推导约束。
 * 永不抛错（增强腿）；无渠道 / LLM 失败 → skipped。
 */
export async function runSemanticJudgeReview(opts: {
  backplane: PrdBackplane
  artifact: string
  testSummary?: string
  query: SDKQuery
  env: Record<string, string> | undefined
  sessionId: string
  signal?: AbortSignal
  /** 委派可视化（2026-08-26）：三者齐备时优先委派（子 agent 用只读工具自查产物），否则直连 */
  projectId?: string
  requestId?: string
  publish?: (event: AgentEvent) => void
}): Promise<SemanticJudgeResult> {
  const { backplane, artifact, testSummary, query, env, sessionId, signal } = opts
  if (!env) {
    return { constraint: null, findings: [], skipped: true, skipReason: 'no_channel' }
  }
  // T-6：经验库已于 2026-10-02 整体退役（账本零 verified 卡，注入恒空串）。
  // errorSection 保留空串占位，两路组装均以空段过滤，行为字节级不变。
  const errorSection = ''
  // ① 委派审查（默认，协作过程 DelegationFeed 可视化）：子 agent 用只读工具自行查证
  //    产物，不再受 24k 内联截断限制
  if (opts.projectId && opts.requestId && opts.publish) {
    // ①' C3 攻防轮次（BLOMA_ADVERSARIAL_REVIEW on 且攻/防渠道就绪）：异族攻击者→防御者
    //    →争议复核（攻击者合计 ≤2 轮）；任何不就绪/失败均诚实降级单委派（下方 ①）。
    if (adversarialReviewEnabled()) {
      const adversarial = await runAdversarialSemanticReview({
        goal: `裁判语义审查产物 vs PRD：${backplane.name ?? '未命名项目'}`,
        baseTask: buildDelegatedJudgeTask(backplane, testSummary, errorSection),
        system: buildSemanticJudgeSystemPrompt(),
        requirements: backplane.requirements ?? [],
        query,
        env,
        sessionId,
        projectId: opts.projectId,
        requestId: opts.requestId,
        publish: opts.publish,
      })
      if (adversarial.ok && adversarial.findings) {
        return {
          constraint: deriveConstraint(adversarial.findings, backplane.requirements ?? []),
          findings: adversarial.findings,
          skipped: false,
          via: 'adversarial',
          adversarial: { rounds: adversarial.rounds ?? 1, refuted: adversarial.refuted ?? [] },
        }
      }
      console.warn('[judge-semantic] 攻防轮次不就绪/失败，降级单委派:', adversarial.failure)
    }
    const delegated = await runDelegatedReview({
      goal: `裁判语义审查产物 vs PRD：${backplane.name ?? '未命名项目'}`,
      task: buildDelegatedJudgeTask(backplane, testSummary, errorSection),
      system: buildSemanticJudgeSystemPrompt(),
      query,
      env,
      sessionId,
      projectId: opts.projectId,
      requestId: opts.requestId,
      publish: opts.publish,
    })
    if (delegated.ok && delegated.finalText) {
      try {
        const findings = parseSemanticFindings(delegated.finalText, backplane.requirements ?? [])
        return { constraint: deriveConstraint(findings, backplane.requirements ?? []), findings, skipped: false, via: 'delegation' }
      } catch {
        console.error('[judge-semantic] 委派审查输出不可解析，回退直连')
      }
    }
  }
  // ② 直连（内联产物，截断 24k）
  try {
    const findings = await judgeViaLlm({ backplane, artifact, testSummary, query, env, sessionId, signal, errorSection })
    return { constraint: deriveConstraint(findings, backplane.requirements ?? []), findings, skipped: false, via: 'direct' }
  } catch (error) {
    console.error('[judge-semantic] LLM 语义审查失败，跳过（不影响裁决）:', error)
    return { constraint: null, findings: [], skipped: true, skipReason: 'llm_failed' }
  }
}

/** 委派版任务：PRD 内联 + 产物改为子 agent 自查（只读工具，物理不可改）。 */
function buildDelegatedJudgeTask(backplane: PrdBackplane, testSummary?: string, errorSection?: string): string {
  const requirements = backplane.requirements ?? []
  // Phase 2 M1：能力契约段（开关 off/无 CAP → 空串零注入，字节级现状）；
  // 与 loop 锚定/确认卡同源 renderCapSection——三处消费同一份。
  const capSection = capContractEnabled() ? renderCapSection(backplaneAiCapabilities(backplane)) : ''
  const lines = [
    '【任务】审查生成的软件产物是否忠实实现了 PRD 的每个功能项。',
    '',
    '【PRD 功能项】（P0=核心必须 / P1=重要 / P2=加分）',
    ...requirements.map(
      (item) =>
        `- ${item.id} [${requirementPriority(item)}] ${item.description}${
          item.behavior_assertions?.length ? `（验收：${item.behavior_assertions.join('；')}）` : ''
        }`,
    ),
    ...(capSection ? ['', capSection, '', '【能力契约判定】命中 CAP 的功能项：局部测试通过不算完成，必须按各条「验收证据」核查；命中「不算完成」清单的实现判 deviated 并引用证据。'] : []),
    '',
    '【产物】在本项目根目录：index.html 与 src/ 下的 js/css。用 read_file / list_files / grep 自行查证（只读，绝不修改任何文件），逐项对照后按【输出】格式给出严格 JSON。',
  ]
  if (testSummary) lines.push('', `【测试报告摘要】${testSummary}（仅供参考，以你读到的代码为准）`)
  if (errorSection) lines.push('', errorSection)
  return lines.join('\n')
}

/** LLM 判定轮：内联 PRD 功能项（含优先级与断言）+ 产物代码 + 测试摘要。 */
async function judgeViaLlm(opts: {
  backplane: PrdBackplane
  artifact: string
  testSummary?: string
  query: SDKQuery
  env: Record<string, string>
  sessionId: string
  signal?: AbortSignal
  /** T-6 经验库【常见错法】段（空串=不注入，现状字节级） */
  errorSection?: string
}): Promise<SemanticFinding[]> {
  const requirements = opts.backplane.requirements ?? []
  // Phase 2 M1：能力契约段（与委派路径/loop 锚定同源；off/无 CAP 零注入）
  const capSection = capContractEnabled() ? renderCapSection(backplaneAiCapabilities(opts.backplane)) : ''
  const truncated = opts.artifact.length > ARTIFACT_CHAR_LIMIT
  const prompt = [
    buildSemanticJudgeSystemPrompt(),
    '',
    ...(opts.errorSection ? [opts.errorSection, ''] : []),
    '【PRD 功能项】（P0=核心必须 / P1=重要 / P2=加分）',
    ...requirements.map(
      (item) =>
        `- ${item.id} [${requirementPriority(item)}] ${item.description}${
          item.behavior_assertions?.length ? `（验收：${item.behavior_assertions.join('；')}）` : ''
        }`,
    ),
    ...(capSection ? ['', capSection, '', '【能力契约判定】命中 CAP 的功能项：局部测试通过不算完成，必须按各条「验收证据」核查；命中「不算完成」清单的实现判 deviated 并引用证据。'] : []),
    '',
    `【产物代码】${truncated ? `（超长已截断至前 ${ARTIFACT_CHAR_LIMIT} 字符）` : ''}`,
    truncated ? opts.artifact.slice(0, ARTIFACT_CHAR_LIMIT) : opts.artifact,
    '',
    opts.testSummary ? `【测试报告摘要】${opts.testSummary}` : '【测试报告摘要】（无）',
    '',
    '现在逐条判定，按【输出】格式给出 JSON。',
  ].join('\n')

  const texts: string[] = []
  for await (const message of opts.query(prompt, {
    env: opts.env,
    signal: opts.signal ?? new AbortController().signal,
    sessionId: opts.sessionId,
    maxTokens: 640000,
    temperature: 0.1,
  })) {
    if (message.type !== 'assistant' || !message.message) continue
    for (const block of message.message.content) {
      if (block.type === 'text' && block.text) texts.push(block.text)
    }
  }
  return parseSemanticFindings(texts.join(''), requirements)
}

/** 稳健解析：白名单状态校验；未知功能项 id 丢弃（模型幻觉防御）。 */
export function parseSemanticFindings(text: string, requirements: SketchRequirement[]): SemanticFinding[] {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('SEMANTIC_JUDGE_PARSE_FAILED: 输出中无 JSON 对象')
  let parsed: { findings?: unknown }
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as { findings?: unknown }
  } catch {
    throw new Error('SEMANTIC_JUDGE_PARSE_FAILED: JSON 解析失败')
  }
  const statuses = new Set(['implemented', 'partial', 'missing', 'deviated', 'unverified'])
  const knownIds = new Set(requirements.map((item) => item.id))
  const findings: SemanticFinding[] = []
  for (const raw of Array.isArray(parsed.findings) ? parsed.findings : []) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const requirementId = String(item.requirement_id ?? '')
    const status = String(item.status ?? '')
    if (!knownIds.has(requirementId) || !statuses.has(status)) continue
    const evidence = typeof item.evidence === 'string' ? item.evidence.trim().slice(0, 160) : ''
    // 证据纪律（M-6 附带）：missing/deviated 无证据 → 降级 unverified——LLM 幻觉的
    // missing 不能无证据直接 blocking（误杀方向）；implemented/partial/unverified 不强制证据
    const safeStatus =
      !evidence && (status === 'missing' || status === 'deviated') ? ('unverified' as const) : (status as SemanticStatus)
    findings.push({
      requirement_id: requirementId,
      status: safeStatus,
      evidence,
    })
  }
  return findings
}

/** 代码级推导约束：P0 missing/deviated→blocking；P0 partial / P1 missing/deviated→major。 */
export function deriveConstraint(findings: SemanticFinding[], requirements: SketchRequirement[]): JudgeConstraint | null {
  const priorityById = new Map(requirements.map((item) => [item.id, requirementPriority(item)]))
  const blocking: string[] = []
  const major: string[] = []
  const notes: string[] = []
  for (const finding of findings) {
    const priority = priorityById.get(finding.requirement_id) ?? 'P2'
    if (finding.status === 'implemented') continue
    if (finding.status === 'unverified') {
      notes.push(`${finding.requirement_id} 无法从代码判断（待人工确认）`)
      continue
    }
    const label = `${finding.requirement_id} ${statusLabel(finding.status)}`
    if (priority === 'P0' && (finding.status === 'missing' || finding.status === 'deviated')) {
      blocking.push(label)
    } else if (priority === 'P0' || priority === 'P1') {
      major.push(label)
    } else {
      notes.push(label)
    }
  }
  const failed = blocking.length > 0 || major.length > 0
  const parts: string[] = []
  if (blocking.length > 0) parts.push(`核心功能未实现/做偏：${blocking.join('、')}`)
  if (major.length > 0) parts.push(`重要功能不完整：${major.join('、')}`)
  if (notes.length > 0) parts.push(`（备注：${notes.join('；')}）`)
  return {
    name: '语义忠实性（裁判审查）',
    passed: !failed,
    detail: failed
      ? `产物与需求有出入：${parts.filter((part) => !part.startsWith('（')).join('；')}${notes.length > 0 ? `；${notes.join('；')}` : ''}`
      : parts.length > 0 ? `功能实现与需求对齐${parts.join('')}` : '功能实现与需求对齐',
  }
}

function statusLabel(status: SemanticStatus): string {
  switch (status) {
    case 'missing':
      return '未实现'
    case 'deviated':
      return '做偏了'
    case 'partial':
      return '只实现一部分'
    default:
      return status
  }
}
