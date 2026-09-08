import React from 'react'
import type { AgentEvent } from '../../shared/types'
import type { DelegationView } from '../agent-atoms'
import { deriveToolCallRecords, TOOL_UI_LABELS } from './ToolCallBlock'
import { DELEGATION_ROLE_LABELS } from './delegation-labels'

/**
 * ProgressCard — 等待期的「查看进度」展开内容（v2，2026-09-08）。
 *
 * v2 借鉴 Proma 母体 TaskProgressCard：把"进度"表达为**步骤列表**（完成打勾、
 * 进行中转圈、未开始圆圈），而不是时间百分比——动态 Agent Loop 没有诚实的剩余
 * 时间分母。数据读后端权威 workflowStage（stage_changed 已实时广播 + 落盘）做
 * 确定性步骤映射（mapStageToRunSteps），零新增后端契约；阶段回退如实重试，不假装通过。
 *
 * 完成度百分比 = 已完成步数 ÷ 总步数（如实，不预测剩余时间）。
 * 每步"正在做什么"的活体 detail 来自事件流（buildProgressLines，工具/委派）。
 */

// =========================================================================
// 步骤模型与 stage 映射（纯函数，可单测）
// =========================================================================

export type RunStepStatus = 'pending' | 'in_progress' | 'done'

export interface RunStep {
  id: string
  label: string
  status: RunStepStatus
}

/** MVP 主链 3 步模板：generating_mvp → testing/repairing → judge_review → ready */
const MVP_STEPS: Array<{ id: string; label: string }> = [
  { id: 'build', label: '生成可运行版本' },
  { id: 'test', label: '自动测试并修复' },
  { id: 'quality', label: '质量检查' },
]

/** 草图链 2 步模板 */
const SKETCH_STEPS: Array<{ id: string; label: string }> = [
  { id: 'sketch', label: '画草图给你看' },
  { id: 'preview', label: '准备预览' },
]

function withStatus(
  template: Array<{ id: string; label: string }>,
  currentIndex: number,
  allDone = false,
): RunStep[] {
  return template.map((step, index) => {
    const status: RunStepStatus = allDone
      ? 'done'
      : index < currentIndex - 1
        ? 'done'
        : index === currentIndex - 1
          ? 'in_progress'
          : 'pending'
    return { ...step, status }
  })
}

/**
 * 后端权威 workflowStage → 用户可读步骤列表。
 * 返回 null = 不套模板（clarifying/iterating/upgrading 等），由卡片回退阶段文案。
 * currentIndex 为 1-based；未列出的中间阶段（sketch_ready 等）不返回，避免误导。
 */
export function mapStageToRunSteps(stage: string): RunStep[] | null {
  switch (stage) {
    case 'generating_sketch':
      return withStatus(SKETCH_STEPS, 1)
    case 'generating_mvp':
      return withStatus(MVP_STEPS, 1)
    case 'testing':
    case 'repairing':
      // 测试/修复共享第 2 步：两者来回时不误报已完成，避免进度"假推进"
      return withStatus(MVP_STEPS, 2)
    case 'judge_review':
      return withStatus(MVP_STEPS, 3)
    case 'ready':
      return withStatus(MVP_STEPS, 3, true)
    default:
      return null
  }
}

export interface RunStepProgress {
  /** 第几步（1-based）；无 in_progress 且未全完成时为 0 */
  current: number
  total: number
  done: number
  /** 完成度 = 已完成步数 ÷ 总步数 */
  percent: number
  allDone: boolean
}

export function computeStepProgress(steps: RunStep[]): RunStepProgress {
  const total = steps.length
  if (total === 0) return { current: 0, total: 0, done: 0, percent: 0, allDone: false }
  const done = steps.filter((step) => step.status === 'done').length
  const inProgressIndex = steps.findIndex((step) => step.status === 'in_progress')
  const allDone = done === total
  const current = allDone ? total : inProgressIndex >= 0 ? inProgressIndex + 1 : 0
  return { current, total, done, percent: Math.round((done / total) * 100), allDone }
}

// =========================================================================
// 活体过程行（每步"正在做什么"的 detail，v1 逻辑保留）
// =========================================================================

export type ProgressLineStatus = 'running' | 'ok' | 'error' | 'budget'

export interface ProgressLine {
  key: string
  kind: 'tool' | 'delegation'
  label: string
  detail: string
  status: ProgressLineStatus
}

/** 未知工具在活体行的兜底文案（避免把英文工具名抛给 P0 用户） */
export const PROGRESS_UNKNOWN_LABEL = '正在处理任务'

export const PROGRESS_STATUS_TEXT: Record<ProgressLineStatus, string> = {
  running: '进行中',
  ok: '完成',
  error: '出错',
  budget: '预算已满',
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** 已完成步骤数：成功收尾的工具调用 + 已完成的委派 */
export function countDoneSteps(events: AgentEvent[], delegations: DelegationView[]): number {
  let done = 0
  for (const event of events) {
    if (event.type === 'tool_call_completed' && event.payload.status !== 'error') done += 1
  }
  for (const delegation of delegations) {
    if (delegation.status === 'completed') done += 1
  }
  return done
}

/**
 * 从事件流 + 委派归约出最近过程行（工具在前、委派在后，与 LiveProcessGroup 同序；
 * 只取最近 max 条，「最近」= 数组尾部）。
 */
export function buildProgressLines(
  events: AgentEvent[],
  delegations: DelegationView[],
  max = 4,
): ProgressLine[] {
  const lines: ProgressLine[] = []
  const records = deriveToolCallRecords(events)
  for (const record of records) {
    lines.push({
      key: record.key,
      kind: 'tool',
      label: TOOL_UI_LABELS[record.tool] ?? PROGRESS_UNKNOWN_LABEL,
      detail: truncate(record.outputSummary ?? record.inputSummary ?? '', 40),
      status:
        // budget = 调用预算正常中止，不是错误（P3-2 审计项，2026-09-08）：单独成态避免红点「出错」误报
        record.status === 'budget'
          ? 'budget'
          : record.status === 'error'
            ? 'error'
            : record.status === 'running'
              ? 'running'
              : 'ok',
    })
  }
  for (const delegation of delegations) {
    const roleLabel = DELEGATION_ROLE_LABELS[delegation.role] ?? delegation.role
    lines.push({
      key: `delegation:${delegation.delegation_id}`,
      kind: 'delegation',
      label: `派出${roleLabel}子助手`,
      detail: truncate(delegation.goal, 40),
      status:
        delegation.status === 'running'
          ? 'running'
          : delegation.status === 'completed'
            ? 'ok'
            : 'error',
    })
  }
  return lines.slice(-max)
}

/** 取最近一条"正在做"（优先 running，否则最新一条）作为当前步的活体 detail。 */
export function pickLiveLine(lines: ProgressLine[]): ProgressLine | null {
  if (lines.length === 0) return null
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].status === 'running') return lines[i]
  }
  return lines[lines.length - 1]
}

// =========================================================================
// 组件
// =========================================================================

export interface ProgressCardProps {
  /** 当前阶段业务文案（steps 为空时作为回退标题，如「正在生成可运行版本」） */
  stageLabel: string
  /** 步骤列表（mapStageToRunSteps 结果；空数组 = 无模板回退） */
  steps: RunStep[]
  /** 最近过程行（作为当前步"正在做什么"的活体 detail） */
  lines: ProgressLine[]
  /** 已收尾的工具/委派步数（无模板回退时展示） */
  doneSteps: number
  onClose: () => void
  /** 提出新想法（超时态用户可补充需求，父级聚焦输入框并提示排队，R-WAIT-04） */
  onSuggestIdea?: () => void
}

export const ProgressCard: React.FC<ProgressCardProps> = ({ stageLabel, steps, lines, doneSteps, onClose, onSuggestIdea }) => {
  const progress = computeStepProgress(steps)
  const liveLine = pickLiveLine(lines)
  const inProgressExists = steps.some((step) => step.status === 'in_progress')

  const hasTemplate = steps.length > 0
  const header = hasTemplate
    ? `${progress.allDone ? '已完成' : `第 ${progress.current} / ${progress.total} 步`} · 已完成 ${progress.percent}%`
    : lines.length > 0 || doneSteps > 0
      ? `${stageLabel} · 已完成 ${doneSteps} 步`
      : '正在准备 / 理解你的需求…'

  return (
    <div
      data-ai-id="progress-card"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
        padding: 'var(--space-4)',
        background: 'var(--white)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        maxWidth: 420,
        boxShadow: 'var(--shadow-sm)',
        animation: 'tile-enter 0.3s ease both',
      }}
    >
      <div>
        {!hasTemplate && lines.length === 0 && doneSteps === 0 && (
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text)', fontWeight: 600 }}>{stageLabel}</p>
        )}
        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text)', fontWeight: 600 }}>{header}</p>
      </div>

      {steps.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {steps.map((step) => (
            <div
              key={step.id}
              data-ai-id={`progress-step-${step.id}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                padding: 'var(--space-2) var(--space-3)',
                background: 'var(--glass-bg-soft)',
                border: `1px solid ${step.status === 'in_progress' ? 'var(--color-quick)' : 'var(--color-border)'}`,
                borderRadius: 'var(--radius-sm)',
                fontSize: 'var(--font-size-xs)',
                color: 'var(--color-text-muted)',
              }}
            >
              <span aria-hidden style={{ width: 14, height: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {step.status === 'done' && <span style={{ color: 'var(--color-quick)', fontSize: 13, lineHeight: 1 }}>✓</span>}
                {step.status === 'in_progress' && (
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      border: '2px solid var(--color-border)',
                      borderTopColor: 'var(--color-quick)',
                      borderRadius: '50%',
                      display: 'inline-block',
                      animation: 'spin 0.8s linear infinite',
                    }}
                  />
                )}
                {step.status === 'pending' && <span style={{ width: 8, height: 8, borderRadius: '50%', border: '1px solid var(--gray-300, #d4d4d8)', display: 'inline-block' }} />}
              </span>
              <span
                style={{
                  color: step.status === 'in_progress' ? 'var(--color-text)' : step.status === 'done' ? 'var(--color-text-muted)' : 'var(--color-text-muted)',
                  fontWeight: step.status === 'in_progress' ? 600 : 400,
                  textDecoration: step.status === 'done' ? 'none' : 'none',
                  flexShrink: 0,
                }}
              >
                {step.label}
              </span>
              <span style={{ marginLeft: 'auto', flexShrink: 0 }}>
                {step.status === 'in_progress' && <span style={{ color: 'var(--color-quick)' }}>进行中</span>}
                {step.status === 'done' && <span>完成</span>}
              </span>
            </div>
          ))}
        </div>
      )}

      {hasTemplate && inProgressExists && liveLine && (
        <div
          data-ai-id="progress-live-line"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            fontSize: 'var(--font-size-xs)',
            color: 'var(--color-text-muted)',
            overflow: 'hidden',
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
            {`正在：${liveLine.label}${liveLine.detail ? ` · ${liveLine.detail}` : ''}`}
          </span>
        </div>
      )}

      {!hasTemplate && lines.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {lines.map((line) => (
            <div
              key={line.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                padding: 'var(--space-2) var(--space-3)',
                background: 'var(--glass-bg-soft)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 'var(--font-size-xs)',
                color: 'var(--color-text-muted)',
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  flexShrink: 0,
                  background:
                    line.status === 'error'
                      ? 'var(--color-danger)'
                      : line.status === 'ok'
                        ? 'var(--color-quick)'
                        : line.status === 'budget'
                          ? 'var(--gray-400)'
                          : 'var(--color-warning)',
                  animation: line.status === 'running' ? 'pulse-stage 1.6s ease-in-out infinite' : 'none',
                }}
              />
              <span style={{ color: 'var(--color-text)', fontWeight: 500, flexShrink: 0 }}>{line.label}</span>
              {line.detail && (
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                  {line.detail}
                </span>
              )}
              <span style={{ marginLeft: 'auto', flexShrink: 0, color: line.status === 'error' ? 'var(--color-danger)' : 'var(--color-text-muted)' }}>
                {PROGRESS_STATUS_TEXT[line.status]}
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        <button
          type="button"
          onClick={onClose}
          style={{
            height: 30,
            padding: '0 var(--space-3)',
            fontSize: 'var(--font-size-xs)',
            fontWeight: 600,
            color: 'var(--color-text-muted)',
            background: 'transparent',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-full)',
            cursor: 'pointer',
          }}
        >
          收起
        </button>
        {onSuggestIdea && (
          <button
            type="button"
            onClick={onSuggestIdea}
            style={{
              height: 30,
              padding: 0,
              fontSize: 'var(--font-size-xs)',
              fontWeight: 600,
              color: 'var(--color-quick)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            提出新想法
          </button>
        )}
      </div>
    </div>
  )
}

export default ProgressCard
