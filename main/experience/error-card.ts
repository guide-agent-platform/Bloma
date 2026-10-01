import { randomUUID } from 'node:crypto'
import {
  EXPERIENCE_GOVERNANCE,
  computeFingerprint,
  type AntiPatternBody,
  type CardEnvelope,
  type ExperienceCard,
} from './types'
import { appendExperienceEvent } from './event-log'
import type { GwtTestResult } from '../verification/test-legacy'
import type { JudgeVerdict } from '../review/judge-engine'

/**
 * 失败信号采集层（F 系列 W2.1 改写，2026-09-16 Phase 10 承接）：四类失败信号改为
 * **事件行**落账本（event-log.ts）——observations 只记事实（异常类型/层/轮次/断言
 * id），不产卡不归因；v1 卡组装器（symptom/root_cause 原文复制旧病）已删。
 * 函数名 recordFailureCards 保留（六写点签名零改动）；root_cause 字段停写。
 * 旧消费面已冻结（experience-service selectForInjection 只放行 v2 rule 卡，拍板 2.3/D2）。
 *
 * 保留物：KNOWN_NEGATIVE_SEEDS + buildKnownNegativeSeedCards（人工登记通道，
 * judge 反退化种子——negative/ 标签空间，与事件行采集正交）。
 *
 * 纪律：组装全部纯事实提取；写入 fire-and-forget（warn 不抛）；开关 off=零副作用。
 */

export interface ObserveCtx {
  projectId: string
  sessionId?: string
  /** 单信号观察条数上限（防 failure_summary 爆炸灌账本）；缺省 5 */
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

// =========================================================================
// 事件行采集（recordFailureCards 六写点签名不变）
// =========================================================================

/** 唯一采集入口：四类失败信号 + C3 反退化 findings → v2 事件行（不产卡不归因）。 */
export function recordFailureCards(
  ctx: ObserveCtx,
  signals: {
    testResult?: GwtTestResult
    judgeVerdict?: JudgeVerdict
    abnormal?: { outcomeType: 'timeout' | 'interrupt' | 'unexpected_exit'; description: string }
    /** C3（2026-09-09）：裁判反退化 findings → 事实观察行 */
    antidegrade?: Array<{ code: string; detail: string }>
  },
): void {
  // 恒采集（EXPERIENCE 开关 2026-10-01 转正删除）
  try {
    const cap = ctx.maxCards ?? 5
    const runId = ctx.sessionId ?? ctx.projectId
    if (signals.testResult && signals.testResult.failed_count > 0) {
      const t = signals.testResult
      appendExperienceEvent({
        projectId: ctx.projectId,
        runId,
        eventType: 'gwt_failure',
        stage: 'testing',
        observations: [
          `failed ${t.failed_count}/${t.total_count}`,
          ...t.failure_summary.map((f) => `${f.scenario}：${f.reason}`),
        ].slice(0, cap + 1),
        evidenceRefs: ['documents/test-report.json'],
      })
    }
    if (signals.judgeVerdict && signals.judgeVerdict.verdict === 'return') {
      const constraints = [...(signals.judgeVerdict.hard_constraints ?? []), ...(signals.judgeVerdict.soft_constraints ?? [])]
      appendExperienceEvent({
        projectId: ctx.projectId,
        runId,
        eventType: 'judge_return',
        stage: 'judge_review',
        observations: constraints.filter((c) => !c.passed).map((c) => `${c.name}：${c.detail}`).slice(0, cap),
      })
    }
    if (signals.abnormal) {
      appendExperienceEvent({
        projectId: ctx.projectId,
        runId,
        eventType: 'abnormal_outcome',
        stage: 'coding',
        observations: [`${signals.abnormal.outcomeType}: ${signals.abnormal.description}`].slice(0, cap),
      })
    }
    for (const finding of signals.antidegrade ?? []) {
      appendExperienceEvent({
        projectId: ctx.projectId,
        runId,
        eventType: 'antidegrade_finding',
        stage: 'judge_review',
        observations: [`${finding.code}: ${finding.detail}`],
      })
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
