import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { findProject } from './project-service'
import { getDocumentsDir } from '../storage/config-paths'

/**
 * 项目执行经验日志（2026-08-26 改造 2，ralph progress.txt 的确定性等价物）。
 *
 * 与 memory-distiller（L3 对话性记忆）刻意区分：本模块只沉淀**执行过程经验**——
 * loop 完成总结（做了什么/未解决项）、异常结局（turn_limit/budget_exhausted/cancelled）、
 * 工具失败模式；**不存需求/决策/约束**（那是 prd.json 背板的事实源，照存就是
 * 第二真相源——OMO 作者教训）。零 LLM 成本：条目直接取自 AgentLoopResult，纯确定性。
 *
 * - append-only JSONL（documents/{project_id}/learnings.jsonl），读取取最近 N 条；
 * - 治理（闭环 PR3，零 LLM）：入队去重（仅 loop_summary，防迭代重生成刷屏；
 *   loop_outcome 失败必须全留不去重）+ 注入排序（kind 权重 outcome 优先、
 *   过期 >14 天的 summary 沉底但条数不足时仍入选）；
 * - 全链路静默失败（增强腿）：文件 IO/项目缺失不抛错、不阻断生成；
 * - 注入消费方：buildLoopSystemWithOverride 的【历史经验】段（下轮 fresh loop
 *   开场即知上轮踩过什么坑——迭代重生成场景的防漂移增益）。
 */

export interface ProjectLearning {
  recorded_at: string
  kind: 'loop_summary' | 'loop_outcome' | 'note'
  text: string
  meta?: Record<string, unknown>
}

/** 单条文本上限（finalText 完成总结可能较长，落盘截断防膨胀） */
const TEXT_CHAR_LIMIT = 300
/** 注入段默认条数（token 预算：N 条 × ≤120 字渲染） */
const DEFAULT_INJECT_LIMIT = 6
/** 入队去重回看窗口（条）：只与最近 N 条比对，越旧越可能已有价值退化 */
const DEDUP_LOOKBACK = 20
/** 注入排序的 kind 权重：异常结局（失败信号）优先于总结/备注。 */
const KIND_WEIGHT: Record<ProjectLearning['kind'], number> = { loop_outcome: 2, note: 1, loop_summary: 1 }
/** loop_summary 时效阈值（天）：超过则注入排序沉底（不删除，条数不足时仍可入选）。 */
const SUMMARY_STALE_DAYS = 14

function normalizeForDedup(text: string): string {
  return text.trim().toLowerCase().slice(0, 60)
}

function learningsPath(workspaceSlug: string, projectId: string): string {
  return join(getDocumentsDir(workspaceSlug, projectId), 'learnings.jsonl')
}

/** 追加一条执行经验（静默失败返回 null）。 */
export function appendProjectLearning(
  projectId: string,
  entry: { kind: ProjectLearning['kind']; text: string; meta?: Record<string, unknown> },
): ProjectLearning | null {
  try {
    const project = findProject(projectId)
    const path = learningsPath(project.workspace_slug, projectId)
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true })
    const record: ProjectLearning = {
      recorded_at: new Date().toISOString(),
      kind: entry.kind,
      text: entry.text.trim().slice(0, TEXT_CHAR_LIMIT),
      ...(entry.meta ? { meta: entry.meta } : {}),
    }
    // 入队去重（仅 loop_summary）：迭代重生成的完成总结高度相似，同前缀刷屏挤占
    // 注入预算；loop_outcome 不去重——重复失败恰是最该留的信号（v1 保守裁定）。
    if (record.kind === 'loop_summary') {
      const prefix = normalizeForDedup(record.text)
      const duplicated = readAllLearnings(projectId)
        .slice(-DEDUP_LOOKBACK)
        .some((existing) => existing.kind === 'loop_summary' && normalizeForDedup(existing.text) === prefix)
      if (duplicated) return null
    }
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8')
    return record
  } catch {
    return null
  }
}

/** 全量读取（损坏行跳过；无文件/异常返回空数组）。 */
function readAllLearnings(projectId: string): ProjectLearning[] {
  try {
    const project = findProject(projectId)
    const path = learningsPath(project.workspace_slug, projectId)
    if (!existsSync(path)) return []
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    const records: ProjectLearning[] = []
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as ProjectLearning
        if (parsed && typeof parsed.text === 'string' && parsed.text) records.push(parsed)
      } catch {
        // 损坏行跳过
      }
    }
    return records
  } catch {
    return []
  }
}

/** 读最近 N 条执行经验（文件序取尾）。 */
export function readRecentLearnings(projectId: string, limit = DEFAULT_INJECT_LIMIT): ProjectLearning[] {
  return readAllLearnings(projectId).slice(-limit)
}

/**
 * 治理后的注入读序（闭环 PR3）：kind 权重降序（loop_outcome 优先）→ 时间降序；
 * 过期（>SUMMARY_STALE_DAYS 天）的 loop_summary 沉底——文件不动，只影响注入排序，
 * 条数不足时仍可入选。零 LLM，纯确定性。
 */
export function readCuratedLearnings(projectId: string, limit = DEFAULT_INJECT_LIMIT): ProjectLearning[] {
  const staleBefore = Date.now() - SUMMARY_STALE_DAYS * 86_400_000
  const effectiveWeight = (entry: ProjectLearning): number => {
    if (entry.kind === 'loop_summary' && Date.parse(entry.recorded_at) < staleBefore) return 0
    return KIND_WEIGHT[entry.kind] ?? 1
  }
  return [...readAllLearnings(projectId)]
    .sort(
      (a, b) =>
        effectiveWeight(b) - effectiveWeight(a) || b.recorded_at.localeCompare(a.recorded_at),
    )
    .slice(0, limit)
}

/**
 * 渲染系统提示词的【历史经验】段：无经验返回空串（首轮生成零开销）。
 * 单条渲染截 120 字，保持注入预算可控。
 */
export function renderLearningsSection(projectId: string, limit = DEFAULT_INJECT_LIMIT): string {
  const learnings = readCuratedLearnings(projectId, limit)
  if (learnings.length === 0) return ''
  const lines = learnings.map((learning) => {
    const label = learning.kind === 'loop_summary' ? '完成总结' : learning.kind === 'loop_outcome' ? '异常结局' : '备注'
    return `- [${label}] ${learning.text.slice(0, 120)}`
  })
  return ['【历史经验】（此前生成轮留下的，避免重复踩坑）', ...lines].join('\n')
}
