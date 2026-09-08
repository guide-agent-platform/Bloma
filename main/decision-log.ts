import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentMessage } from '../shared/types'
import { getAgentSessionPath, getDocumentsDir } from '../storage/config-paths'
import { appendJsonLine } from '../storage/json-store'
import { appendSessionMessage } from './session-tree'
import { registerDecisionsDocument } from './document-engine'
import { findProject } from './project-service'
import { listSessions } from './session-service'

/**
 * 决策日志（长期型改造 T2）：把「改变用户可见产物的决策及其 why」沉淀为
 * 结构化 system 消息（`[decision] {json}`）落盘到会话 JSONL，并同步聚合导出
 * `decisions.md` 到项目文档目录。
 *
 * - 落盘即导出（非会话结束批量）：保证 T7 冻结快照时取到的不是过期聚合；
 * - 聚合只认 JSONL 已有记录（含旧格式 `[decision-card]` 行），历史项目如实导出、不补造；
 * - 项目缺失（测试字面 id 等）时静默跳过导出，不让决策日志反噬主流程。
 */

export type DecisionType =
  | 'clarification_card'
  | 'clarification_answer'
  | 'clarification_forced_auto'
  | 'clarification_forced_confirm'
  | 'requirement_confirm_card'
  | 'requirement_confirmed'
  | 'prd_review'
  | 'prd_review_overridden'
  | 'internal_audit'
  | 'prd_review_answered'
  | 'prd_review_round_limit'
  | 'prd_confirm'
  | 'judge_semantic'
  | 'modification_gate'
  | 'modification_decision'
  | 'requirement_normalized'
  | 'judge_return'
  | 'circuit_rollback'
  | 'startup_convergence'
  | 'runtime_channel_switch'
  | 'category_route'
  | 'constraint_captured'
  | 'memory_distilled'
  | 'enrichment_stats'
  | 'agent_loop'
  | 'template_type_refined'
  | 'requirement_earsified'
  | 'template_override_rejected'
  | 'prd_backplane_fallback'
  | 'enrichment_clarification_requested'
  | 'enrichment_clarification_answered'
  | 'enrichment_clarification_exhausted'
  | 'enrichment_clarification_timeout'
  | 'skeleton_rendered'
  | 'skeleton_render_failed'
  | 'skeleton_override_rejected'
  | 'build_gate_passed'
  | 'build_gate_failed'
  | 'build_gate_unavailable'
  | 'repair_round_started'
  | 'repair_round_completed'
  | 'repair_budget_exhausted'
  /** L0 产物 UI 完整性硬门禁（artifact-ui-gate，2026-09-07）：探针结果必录 */
  | 'ui_gate'
  /** L1 双视觉审计（vision-audit-gate，2026-09-07）：passed/flagged/unavailable/skipped 均必录，绝不静默 */
  | 'vision_audit'
  | 'plan_generated'
  | 'plan_fallback'
  | 'module_rendered'
  | 'module_render_failed'
  | 'module_rejected'

export interface DecisionEntry {
  type: DecisionType
  /** 决策标题（人类可读，如「用户确认修改」） */
  title: string
  /** 决策理由：为什么做了这个决定 */
  why: string
  detail?: Record<string, unknown>
}

export interface RecordDecisionInput {
  project_id: string
  session_id: string
  entry: DecisionEntry
}

/** system 消息里的决策行前缀（聚合时按此前缀识别）。 */
export const DECISION_PREFIX = '[decision]'
/** 旧格式：Sprint 3 之前的决策卡片选项行（`[decision-card] 选项A｜选项B`），聚合时如实收录。 */
const LEGACY_DECISION_CARD_PREFIX = '[decision-card]'
const DECISIONS_MD = 'decisions.md'

interface DecisionLine {
  timestamp: number
  session_id: string
  entry: DecisionEntry
}

/** 落盘一条决策：追加 system 消息到会话 JSONL，随后同步重导出 decisions.md。 */
export function recordDecision(input: RecordDecisionInput): void {
  const entry: DecisionEntry & { created_at: string } = {
    ...input.entry,
    created_at: new Date().toISOString(),
  }
  appendSessionMessage(input.session_id, {
    role: 'system',
    content: [{ type: 'text', text: `${DECISION_PREFIX} ${JSON.stringify(entry)}` }],
    timestamp: Date.now(),
  })
  try {
    exportDecisionsMd(input.project_id)
  } catch {
    // 项目索引缺失（测试环境字面 project_id）等：决策行已在会话 JSONL，导出跳过
  }
}

/**
 * 从项目全部会话的 JSONL 聚合决策记录，导出 `documents/{project_id}/decisions.md`。
 * 时间线 = 何时、问了什么、选了什么、为什么改；按时间戳升序。
 */
export function exportDecisionsMd(projectId: string): void {
  const project = findProject(projectId)
  const sessions = listSessions({ request_id: 'decision-log', project_id: projectId }).sessions

  const lines: DecisionLine[] = []
  for (const session of sessions) {
    const path = getAgentSessionPath(session.session_id)
    if (!existsSync(path)) continue
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      if (!raw.trim()) continue
      let message: AgentMessage
      try {
        message = JSON.parse(raw) as AgentMessage
      } catch {
        continue
      }
      if (message.role !== 'system') continue
      const text = (message.content ?? []).find((block) => block.type === 'text')?.text ?? ''
      const parsed = parseDecisionText(text)
      if (parsed) lines.push({ timestamp: message.timestamp, session_id: session.session_id, entry: parsed })
    }
  }

  lines.sort((a, b) => a.timestamp - b.timestamp)
  const dir = getDocumentsDir(project.workspace_slug, project.project_id)
  writeFileSync(join(dir, DECISIONS_MD), renderDecisionsMarkdown(project.name, lines), 'utf8')
  // 登记进文档清单（幂等），让文档面板能列出并读取 decisions.md
  registerDecisionsDocument(projectId)
}

/** 解析一行 system 文本为新格式决策（JSON）或旧格式决策卡片行；非决策行返回 undefined。 */
export function parseDecisionText(text: string): DecisionEntry | undefined {
  if (text.startsWith(DECISION_PREFIX)) {
    try {
      const parsed = JSON.parse(text.slice(DECISION_PREFIX.length)) as DecisionEntry
      if (parsed && typeof parsed.title === 'string' && typeof parsed.why === 'string') {
        return { type: parsed.type, title: parsed.title, why: parsed.why, detail: parsed.detail }
      }
    } catch {
      // 损坏行跳过
    }
    return undefined
  }
  if (text.startsWith(LEGACY_DECISION_CARD_PREFIX)) {
    const options = text.slice(LEGACY_DECISION_CARD_PREFIX.length).trim()
    return {
      type: 'clarification_card',
      title: '决策卡片（历史记录）',
      why: `当时向用户弹出可点选选项：${options || '（空）'}`,
    }
  }
  return undefined
}

function renderDecisionsMarkdown(projectName: string, lines: DecisionLine[]): string {
  if (lines.length === 0) {
    return `# ${projectName} · 决策日志\n\n> 本项目会话记录中暂无已落盘的决策条目（不补造历史）。\n`
  }
  const items = lines
    .map((line) => {
      const time = new Date(line.timestamp).toISOString().replace('T', ' ').slice(0, 19)
      const detail =
        line.entry.detail && Object.keys(line.entry.detail).length > 0
          ? `\n  - 详情：\`${JSON.stringify(line.entry.detail)}\``
          : ''
      return [
        `## ${time} · ${line.entry.title}`,
        ``,
        `- 类型：\`${line.entry.type}\``,
        `- 理由：${line.entry.why}`,
        `- 会话：\`${line.session_id}\`${detail}`,
        ``,
      ].join('\n')
    })
    .join('\n')
  return `# ${projectName} · 决策日志\n\n> 由会话 JSONL 聚合生成，每次决策落盘时同步重导出。只收录已落盘记录，不补造历史。\n\n${items}`
}
