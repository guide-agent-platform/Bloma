import { randomUUID } from 'node:crypto'
import {
  EXPERIENCE_GOVERNANCE,
  experienceEnabled,
  computeFingerprint,
  hashProjectRef,
  keyFromSymptom,
  sanitizeCard,
  type AntiPatternBody,
  type CardEnvelope,
  type ExperienceCard,
} from './types'
import { registerCandidateCard, updateCardAttribution } from './experience-service'
import { attributeRootCause } from './root-cause-attributor'
import { appendProjectLearning } from '../learnings-log'
import type { GwtTestResult } from '../gwt-service'
import type { BuildGateResult } from '../coding/build-gate'
import type { JudgeVerdict } from '../review/judge-engine'
import type { SemanticFinding } from '../review/judge-semantic'

/**
 * 错误卡采集层（T-1）：把四类失败信号组装成 anti_pattern 候选卡。
 *
 * 设计约束：
 * - 组装器全部**纯函数**（无 I/O、不 import service 写路径），写入由 quiet 入口
 *   `recordFailureCards` 统一走 fire-and-forget（`void promise`，warn 不抛）；
 * - 不进 shared/types.ts（repair-loop D1 同款：main 进程内部结构，不跨 IPC）；
 * - 每张错误卡**同时镜像进项目 learnings**（kind:'error_pattern'），下轮 fresh loop
 *   经【历史经验】段自动可见——全局账本（跨项目）与项目 learnings（本项目）各走
 *   各的治理，写点一次落两处；
 * - tag 自动规则（确定性、可评审）：`{stage}/{domain}/{key}`，key 取 symptom 归一后
 *   前两个 ≥3 字母词（snake_case）；分类法定型前 tag 空间允许粗（T-4/归因与
 *   skill 层试跑会收敛它）。
 *
 * root_cause 初值 = 表面阶段 + rule/1.0；T-4 归因精化时覆盖。
 */

export interface ObserveCtx {
  projectId: string
  sessionId?: string
  /** 单轮组装上限（防 failure_summary 爆炸灌账本）；缺省 5 */
  maxCards?: number
}

function now() {
  return Date.now()
}

function envelope(
  kind: 'anti_pattern',
  tag: string,
  body: AntiPatternBody,
  source: CardEnvelope['source'],
): ExperienceCard {
  const ts = now()
  const id = randomUUID()
  return {
    id,
    schema_version: EXPERIENCE_GOVERNANCE.SCHEMA_VERSION,
    kind,
    tag,
    status: 'candidate',
    created_at: ts,
    updated_at: ts,
    recurrence: 1,
    source,
    fingerprint: computeFingerprint(kind, body),
    body,
  } as ExperienceCard
}

function initialRootCause(stage: string, symptom: string): AntiPatternBody['root_cause'] {
  return { stage, description: symptom, method: 'rule', confidence: 1 }
}

// =========================================================================
// 纯组装器（4 类信号 → 卡；返回前必经 sanitizeCard）
// =========================================================================

/** GWT 失败 → 每场景一张卡（最多 maxCards）。观察阶段 coding（行为做错）。 */
export function buildCardsFromGwtTestResult(testResult: GwtTestResult, ctx: ObserveCtx): ExperienceCard[] {
  const cards: ExperienceCard[] = []
  for (const failure of testResult.failure_summary.slice(0, ctx.maxCards ?? 5)) {
    const symptom = `GWT 场景「${failure.scenario}」未通过：${failure.reason}`
    const stage = 'coding' as const
    const body: AntiPatternBody = {
      stage,
      symptom,
      trigger_condition: `按场景「${failure.scenario}」执行行为断言时`,
      root_cause: initialRootCause(stage, symptom),
      test_checklist: [`重验场景「${failure.scenario}」的行为断言`],
      review_checklist: ['检查该断言涉及的事件绑定/状态更新/渲染路径是否真实生效'],
      severity: 2,
    }
    cards.push(
      sanitizeCard(
        envelope('anti_pattern', `coding/gwt/${keyFromSymptom(failure.reason || failure.scenario)}`, body, {
          type: 'gwt_failure',
          project_hash: hashProjectRef(ctx.projectId),
          timestamp: now(),
          session_id: ctx.sessionId,
        }),
      ),
    )
  }
  return cards
}

/** build-gate 失败 → 单卡。观察阶段 build_gate（根因多半在 coding，归因覆盖）。 */
export function buildCardFromBuildGateFailure(buildGate: BuildGateResult, ctx: ObserveCtx): ExperienceCard | null {
  if (buildGate.status !== 'failed') return null
  const detail = (buildGate.detail ?? '').slice(0, 400)
  const symptom = `构建门禁未通过：${detail || 'esbuild 校验失败'}`
  const stage = 'build_gate' as const
  const body: AntiPatternBody = {
    stage,
    symptom,
    trigger_condition: 'MVP 产物做验证性构建（esbuild 模块图校验）时',
    root_cause: initialRootCause(stage, symptom),
    test_checklist: ['产物入口与 import 图谱可被独立打包'],
    review_checklist: ['检查跨文件 import 路径/扩展名/循环依赖'],
    severity: 3,
  }
  return sanitizeCard(
    envelope('anti_pattern', `build_gate/bundle/${keyFromSymptom(detail || 'bundle')}`, body, {
      type: 'build_gate_failure',
      project_hash: hashProjectRef(ctx.projectId),
      timestamp: now(),
      session_id: ctx.sessionId,
    }),
  )
}

/** 语义审查发现 → 聚合单卡（finding 为空返回 null，计划 §3.1.1 语义）。 */
export function buildCardFromSemanticFindings(input: {
  findings: SemanticFinding[]
  stage: AntiPatternBody['stage']
  projectHash: string
  sessionId?: string
}): ExperienceCard | null {
  if (input.findings.length === 0) return null
  const top = input.findings[0]
  const symptom = `语义审查（${top.status}）${top.requirement_id}：${top.evidence}`
  const body: AntiPatternBody = {
    stage: input.stage,
    symptom,
    trigger_condition: '产物对照 PRD 功能项做语义忠实性审查时',
    root_cause: initialRootCause(input.stage, symptom),
    test_checklist: input.findings.map((f) => `复查功能项 ${f.requirement_id}（${f.status}）`).slice(0, 5),
    review_checklist: ['逐功能项核对做没做对（做偏/做漏/做错）'],
    severity: input.findings.some((f) => f.status === 'missing' || f.status === 'deviated') ? 3 : 2,
  }
  return sanitizeCard(
    envelope('anti_pattern', `${input.stage}/semantics/${keyFromSymptom(symptom)}`, body, {
      type: 'semantic_findings',
      project_hash: input.projectHash,
      timestamp: now(),
      session_id: input.sessionId,
    }),
  )
}

/** 异常结局 → 单卡。timeout=1 / interrupt=2 / unexpected_exit=3（计划 §3.1.2 断言）。 */
export function buildCardFromAbnormalOutcome(input: {
  outcomeType: 'timeout' | 'interrupt' | 'unexpected_exit'
  description: string
  projectHash: string
  sessionId?: string
}): ExperienceCard {
  const stage = 'unknown' as const
  const severity = input.outcomeType === 'unexpected_exit' ? 3 : input.outcomeType === 'interrupt' ? 2 : 1
  const symptom = `异常结局（${input.outcomeType}）：${input.description}`
  const body: AntiPatternBody = {
    stage,
    symptom,
    trigger_condition: '长任务执行至预算/时限边界时',
    root_cause: initialRootCause(stage, symptom),
    test_checklist: ['为同类任务准备残局恢复路径（不假装交付）'],
    review_checklist: ['检查该结局是否被如实上报（无谎报完成）'],
    severity,
  }
  return sanitizeCard(
    envelope('anti_pattern', `unknown/outcome/${input.outcomeType}`, body, {
      type: input.outcomeType === 'timeout' ? 'timeout_interrupt' : 'abnormal_outcome',
      project_hash: input.projectHash,
      timestamp: now(),
      session_id: input.sessionId,
    }),
  )
}

/** 裁判退回 → 聚合单卡（blocking 级；症状=用户可见摘要+硬伤清单）。 */
export function buildCardFromJudgeReturn(verdict: JudgeVerdict, ctx: ObserveCtx): ExperienceCard {
  const failed = verdict.hard_constraints.filter((item) => !item.passed)
  const symptom = `裁判退回：${verdict.user_visible_summary}`
  const stage = 'coding' as const
  const body: AntiPatternBody = {
    stage,
    symptom,
    trigger_condition: '终验（GWT/构建/安全/语义）后裁判裁决时',
    root_cause: initialRootCause(stage, symptom),
    test_checklist: failed.map((item) => `复核硬约束 ${item.name}`).slice(0, 5),
    review_checklist: ['对照未通过硬约束逐条排查产物'],
    severity: 3,
  }
  return sanitizeCard(
    envelope('anti_pattern', `coding/judge/${keyFromSymptom(symptom)}`, body, {
      type: 'semantic_findings',
      project_hash: hashProjectRef(ctx.projectId),
      timestamp: now(),
      session_id: ctx.sessionId,
    }),
  )
}

// =========================================================================
// quiet 写入入口（写点唯一使用的门面；绝不抛）
// =========================================================================

async function persistAntiPattern(card: ExperienceCard, ctx: ObserveCtx): Promise<void> {
  let registered: ExperienceCard | null = null
  try {
    registered = await registerCandidateCard(card)
  } catch (error) {
    console.warn('[experience] register failed, skipping:', (error as Error)?.message)
  }
  // T-4 归因精化：规则层零成本同步跑（无 llmCall 不触网），等值幂等不加行；
  // 窗口折叠命中的已有卡同样精化（旧卡可能是初值 unknown）
  if (registered && registered.kind === 'anti_pattern') {
    try {
      const refined = await attributeRootCause(registered)
      if (
        refined.stage !== registered.body.root_cause.stage ||
        refined.confidence !== registered.body.root_cause.confidence
      ) {
        await updateCardAttribution(registered.id, refined)
      }
    } catch (error) {
      console.warn('[experience] attribution refine failed, keeping initial:', (error as Error)?.message)
    }
  }
  try {
    if (card.kind !== 'anti_pattern') return
    appendProjectLearning(ctx.projectId, {
      kind: 'error_pattern',
      text: `[${card.tag}@${card.body.stage}] ${card.body.symptom} → 规避：${card.body.trigger_condition}`,
      meta: { tag: card.tag, card_id: card.id },
    })
  } catch {
    // learnings 镜像失败不影响账本（各自静默）
  }
}

/**
 * 写点门面：从终验/裁判信号批量组卡并 fire-and-forget 落账本 + learnings 镜像。
 * 调用方形如：`void recordFailureCards({ projectId, sessionId }, { testResult, buildGate })`
 */
export function recordFailureCards(
  ctx: ObserveCtx,
  signals: {
    testResult?: GwtTestResult
    buildGate?: BuildGateResult
    judgeVerdict?: JudgeVerdict
    abnormal?: { outcomeType: 'timeout' | 'interrupt' | 'unexpected_exit'; description: string }
    /** C3（2026-09-09）：裁判反退化 findings（B4 detectAntidegrade 输出）→ 负经验卡 */
    antidegrade?: Array<{ code: string; detail: string }>
  },
): void {
  // C-2 纪律：开关 off = 零副作用（含 learnings 镜像——不加 gate 会污染现状字节级承诺）
  if (!experienceEnabled()) return
  try {
    const cards: ExperienceCard[] = []
    if (signals.testResult) cards.push(...buildCardsFromGwtTestResult(signals.testResult, ctx))
    if (signals.buildGate) {
      const gateCard = buildCardFromBuildGateFailure(signals.buildGate, ctx)
      if (gateCard) cards.push(gateCard)
    }
    if (signals.judgeVerdict && signals.judgeVerdict.verdict === 'return') {
      cards.push(buildCardFromJudgeReturn(signals.judgeVerdict, ctx))
    }
    if (signals.abnormal) {
      cards.push(
        buildCardFromAbnormalOutcome({
          outcomeType: signals.abnormal.outcomeType,
          description: signals.abnormal.description,
          projectHash: hashProjectRef(ctx.projectId),
          sessionId: ctx.sessionId,
        }),
      )
    }
    // C3：负经验（成功但投机）——独立 negative/ 标签空间，只进裁判清单消费（G4 正向
    // 参考只读 pattern kind，天然隔离）；同 code 幂等靠指纹去重。
    for (const finding of signals.antidegrade ?? []) {
      cards.push(buildNegativeCardFromAntidegrade(finding, ctx))
    }
    for (const card of cards) {
      void persistAntiPattern(card, ctx).catch((error) => console.warn('[experience] persist failed:', error))
    }
  } catch (error) {
    // 采集是增强不是依赖：任何组装异常绝不冒到交付链
    console.warn('[experience] recordFailureCards failed, skipping:', (error as Error)?.message)
  }
}

/**
 * 首批已知负经验种子（P2 稿 C3，从实锤案例提炼；纯构建器——启用经验库时登记，
 * 不自动写账本防污染）。四条：模拟失败按钮/固定样例冒充 AI/关 typecheck 过构建/测试方法进产品 UI。
 */
export const KNOWN_NEGATIVE_SEEDS: Array<{ code: string; symptom: string; trigger: string; test: string[]; review: string[] }> = [
  {
    code: 'cheat-simulation-button',
    symptom: '加「模拟失败」按钮过失败态断言（需求无此控件依据）',
    trigger: '断言含「失败→显示提示」且模型为过断言添加异常触发控件（随记灵案实锤）',
    test: ['需求清单无该控件依据时产物不得出现模拟/仿真失败类控件'],
    review: ['对照需求清单核查异常控件；失败态应由真实错误路径触发'],
  },
  {
    code: 'ai-fixed-sample',
    symptom: 'AI 调用不稳定时返回固定样例冒充智能结果',
    trigger: 'AI 能力实现含「失败时返回示例文案」分支（无报错态）',
    test: ['修改关键输入后输出随之变化', '模型不可用时明确报错而非返回样例'],
    review: ['检查 /api/llm 失败分支是否伪装成功；结果区文案是否写死'],
  },
  {
    code: 'disable-typecheck',
    symptom: '关闭 typecheck/构建门禁让构建通过',
    trigger: '类型错误无法修复时模型可能提议禁用检查（自证循环高危形态）',
    test: ['构建门禁不可被产物或经验绕过'],
    review: ['核查 tsconfig/build 配置未被篡改；错误应修复而非禁检'],
  },
  {
    code: 'test-method-in-ui',
    symptom: '把测试方法/探针逻辑写进产品 UI',
    trigger: '断言教学产物——模型为满足断言把测试机制做进用户界面',
    test: ['产品 UI 不含 mock 参数处理/探针钩子等测试机制'],
    review: ['核查 URL mock=1 处理是否仅限 /api/llm 通道而非 UI 逻辑'],
  },
]

/** 由种子生成候选负经验卡（不落盘；登记方决定时机）。 */
export function buildKnownNegativeSeedCards(projectHash: string): ExperienceCard[] {
  return KNOWN_NEGATIVE_SEEDS.map((seed) =>
    envelope(
      'anti_pattern',
      `negative/seed-${seed.code}`,
      {
        stage: 'coding',
        symptom: seed.symptom,
        trigger_condition: seed.trigger,
        root_cause: { stage: 'coding', description: seed.trigger, method: 'rule', confidence: 1 },
        test_checklist: seed.test,
        review_checklist: seed.review,
        severity: 3,
      },
      { type: 'backfill', project_hash: projectHash, timestamp: Date.now() },
    ),
  )
}

/**
 * C3 负经验卡组装（裁判反退化 finding → anti_pattern 负经验）：tag 落 negative/ 空间，
 * severity=3（投机直接拒）；审查清单面向裁判核查（与 B4 三条规则同口径）。
 */
function buildNegativeCardFromAntidegrade(finding: { code: string; detail: string }, ctx: ObserveCtx): ExperienceCard {
  const checklistByCode: Record<string, { test: string[]; review: string[]; symptom: string }> = {
    'ai-mock-frontend': {
      symptom: 'AI 能力被前端写死/固定模板冒充（产物无 /api/llm 调用痕迹）',
      test: ['修改关键输入后输出随之变化', '模型不可用时明确报错而非假装成功'],
      review: ['全文搜索 /api/llm 调用路径；结果区文案是否写死'],
    },
    'cheat-control': {
      symptom: '产物含无需求依据的「模拟失败」类教学控件（为过失败态断言而加）',
      test: ['需求清单无该控件依据时不得出现'],
      review: ['对照需求清单核查异常控件（模拟/仿真失败类）'],
    },
  }
  const preset = checklistByCode[finding.code] ?? {
    symptom: `反退化信号：${finding.code}`,
    test: ['按能力契约验收证据核查'],
    review: [finding.detail.slice(0, 120)],
  }
  return envelope('anti_pattern', `negative/${finding.code}`, {
    stage: 'coding',
    symptom: preset.symptom,
    trigger_condition: finding.detail.slice(0, 200),
    root_cause: { stage: 'coding', description: finding.detail.slice(0, 200), method: 'rule', confidence: 1 },
    test_checklist: preset.test,
    review_checklist: preset.review,
    severity: 3,
  }, {
    type: 'antidegrade_judge',
    project_hash: hashProjectRef(ctx.projectId),
    timestamp: Date.now(),
    ...(ctx.sessionId ? { session_id: ctx.sessionId } : {}),
  })
}
