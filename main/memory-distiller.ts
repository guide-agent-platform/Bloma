import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentMessage } from '../shared/types'
import { getAgentSessionPath, getDocumentsDir } from '../storage/config-paths'
import { categoryTemperature } from './model-resolution'
import { recordDecision } from './decision-log'
import { findProject } from './project-service'
import { readPrdBackplane } from './document-engine'
import { resolveChannelEnv } from './runtime-fallback'
import type { SDKQuery } from './orchestrator'
import type { PrdBackplane } from './sketch-engine'

/**
 * T4-L3 蒸馏层（兜底，2026-08-18 修订版设计）。
 *
 * 主路是确定性两层（L1 约束走门进背板 / L2 窗口+全量扫描）；本层只补它们装不下的
 * **对话性记忆**：被否决的方案、口头偏好、非功能诉求。与背板重叠的三类
 * （已确认功能 / 用户约束 / 关键决策）一律不存——照存就是第二份事实源
 * （OMO 作者教训：专用记忆系统「极容易冗余」），冲突时以背板为准。
 *
 * **默认关闭**（BLOMA_MEMORY_DISTILL=1 才启用）：设计要求 L1+L2 线上实测有漏才
 * 启用本层；开关是 main 进程环境变量而非用户配置（「明确不做：不暴露配置面」）。
 *
 * 触发点两个稳定检查位：草图确认后（runMvpTask 入口）/ 每次迭代完成后（runIterationTask
 * 尾部），均 fire-and-forget——报错 / 超时 / 产物不合 schema 任一即判失败退回 L2，
 * 绝不阻塞主流程，失败落 T2 决策日志如实记录（成功不落：memory.json 本身就是记录）。
 */

const MEMORY_FILE = 'memory.json'
/** 蒸馏超时（后台任务非用户面生成，不受「生成无超时」决策保护；60s 足够整理型任务） */
const DEFAULT_DISTILL_TIMEOUT_MS = 60_000
/** 单类条数上限 / 单条长度上限（三层注入预算：本段 ≤ 数百 token，草图全文仍是大头） */
const MAX_ENTRIES_PER_CATEGORY = 8
const MAX_ENTRY_LENGTH = 60

export interface ProjectMemory {
  version: 1
  distilled_at: string
  /** 被否决的方案（用户明确否定过的做法，如「不要深色主题」之外被否的具体方案） */
  rejected_ideas: string[]
  /** 口头偏好（如「界面简单点」「别太花哨」——不含约束标记词的那类） */
  verbal_preferences: string[]
  /** 非功能诉求（性能/隐私/离线等，未进背板约束的） */
  non_functional_notes: string[]
}

let distillEnabled = process.env.BLOMA_MEMORY_DISTILL === '1'

export function isMemoryDistillEnabled(): boolean {
  return distillEnabled
}

/** 测试开关（生产经 BLOMA_MEMORY_DISTILL=1 启用）。 */
export function setMemoryDistillEnabledForTests(enabled: boolean): void {
  distillEnabled = enabled
}

/** 读取已蒸馏的项目记忆；无文件/损坏返回 undefined（退回 L2，不报错）。 */
export function readProjectMemory(projectId: string): ProjectMemory | undefined {
  try {
    const project = findProject(projectId)
    const path = join(getDocumentsDir(project.workspace_slug, project.project_id), MEMORY_FILE)
    if (!existsSync(path)) return undefined
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ProjectMemory
    if (!isValidMemory(parsed)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

function isValidMemory(value: unknown): value is ProjectMemory {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<ProjectMemory>
  return (
    Array.isArray(candidate.rejected_ideas) &&
    Array.isArray(candidate.verbal_preferences) &&
    Array.isArray(candidate.non_functional_notes)
  )
}

export interface DistillMemoryInput {
  project_id: string
  session_id: string
  channel_id?: string
  query?: SDKQuery
  /** 测试注入短超时；缺省 60s */
  timeoutMs?: number
}

/**
 * 蒸馏会话 JSONL 全量 → memory.json。
 * 返回是否产出（false = 未启用/无模型/失败——一律静默退回 L2，失败另落决策日志）。
 * 输入是**全量** JSONL（不以窗口历史为输入）：窗口只是读取侧的近因视图。
 */
export async function distillProjectMemory(input: DistillMemoryInput): Promise<boolean> {
  if (!distillEnabled || !input.query) return false
  const resolution = resolveChannelEnv({
    channelId: input.channel_id,
    category: 'summary',
    projectId: input.project_id,
    sessionId: input.session_id,
  })
  // 渠道无模型（含备用）：不启用 L3，退回 L2——蒸馏是锦上添花，不配为它报错
  if (!resolution.env) return false

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_DISTILL_TIMEOUT_MS)
  try {
    const transcript = readSessionTranscript(input.session_id)
    if (transcript.length === 0) return false
    let accumulated = ''
    const stream = input.query(buildDistillPrompt(transcript), {
      env: resolution.env,
      signal: controller.signal,
      sessionId: input.session_id,
      maxTokens: 640000,
      temperature: categoryTemperature('summary'),
    })
    for await (const message of stream) {
      if (message.type !== 'assistant' || !message.message) continue
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text) accumulated += block.text
      }
    }
    const memory = parseMemory(accumulated)
    if (!memory) {
      recordDistillFailure(input, '产物不合 schema（无法解析为三类记忆 JSON）')
      return false
    }
    const filtered = dropBackplaneOverlap(memory, readPrdBackplane(input.project_id))
    const hasContent =
      filtered.rejected_ideas.length + filtered.verbal_preferences.length + filtered.non_functional_notes.length > 0
    if (!hasContent) return false
    const project = findProject(input.project_id)
    const path = join(getDocumentsDir(project.workspace_slug, project.project_id), MEMORY_FILE)
    writeFileSync(path, `${JSON.stringify(filtered, null, 2)}\n`, 'utf8')
    console.info(
      `[memoryDistill] ${project.name} 蒸馏完成：否决 ${filtered.rejected_ideas.length} / 偏好 ` +
        `${filtered.verbal_preferences.length} / 非功能 ${filtered.non_functional_notes.length} 条`,
    )
    return true
  } catch (error) {
    const reason = isAbortError(error) ? '超时' : `报错（${error instanceof Error ? error.message : String(error)}）`
    recordDistillFailure(input, reason)
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** fire-and-forget 包装（触发点用）：蒸馏任何异常都不冒泡到主流程。 */
export function distillProjectMemorySafely(input: DistillMemoryInput): void {
  void distillProjectMemory(input).catch((error: unknown) => {
    console.warn(`[memoryDistill] 未预期异常（已吞掉，不影响主流程）：${error instanceof Error ? error.message : String(error)}`)
  })
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** 失败如实记录（T2 决策行）：降级退回 L2 是改变记忆注入行为的系统决策。 */
function recordDistillFailure(input: DistillMemoryInput, reason: string): void {
  console.warn(`[memoryDistill] 蒸馏失败，退回 L2 确定性记忆：${reason}`)
  try {
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'memory_distilled',
        title: '记忆蒸馏失败降级',
        why: `蒸馏失败（${reason}），不阻塞主流程，退回 L1/L2 确定性记忆（约束走门 + 全量扫描）`,
        detail: { outcome: 'failed', reason },
      },
    })
  } catch {
    // 决策落盘失败不再记日志的日志，静默
  }
}

/** 读取会话 JSONL 全量对话文本（user/assistant 原文，剥系统簿记行）。 */
function readSessionTranscript(sessionId: string): string[] {
  const path = getAgentSessionPath(sessionId)
  if (!existsSync(path)) return []
  const lines: string[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let message: AgentMessage
    try {
      message = JSON.parse(line) as AgentMessage
    } catch {
      continue
    }
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = (message.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
      .trim()
    if (!text || text.startsWith('[terminal]')) continue
    lines.push(`${message.role === 'user' ? '用户' : '助手'}：${text}`)
  }
  return lines
}

function buildDistillPrompt(transcript: string[]): string {
  return [
    '你是「Bloma 项目记忆整理员」。下面是一个软件生成项目的完整对话记录。',
    '请从中提取**只有对话里才留得住、且 PRD 背板装不下**的三类记忆：',
    '- rejected_ideas：被用户否决过的具体方案（如「不要用月历视图」被否的那版做法）；',
    '- verbal_preferences：口头偏好（如「界面简单点」「别太花哨」）；',
    '- non_functional_notes：非功能诉求（性能/隐私/离线类，且不是已声明的硬约束）。',
    '',
    '禁止收录（这些已由 PRD 背板承载，收录即造第二份事实源）：',
    '- 已确认的功能项；用户约束（不含/必须/禁止类硬约束）；关键决策。',
    '',
    '要求：每条 ≤30 字、忠实转写不加工；无把握就不收录（宁缺毋滥）；每类 ≤8 条。',
    '只输出一个 JSON 对象，不要任何多余文字：',
    '{"rejected_ideas":["…"],"verbal_preferences":["…"],"non_functional_notes":["…"]}',
    '',
    '【完整对话记录】',
    transcript.join('\n'),
  ].join('\n')
}

function parseMemory(text: string): ProjectMemory | undefined {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return undefined
  }
  const take = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.replace(/\s+/g, ' ').trim().slice(0, MAX_ENTRY_LENGTH))
          .filter(Boolean)
          .slice(0, MAX_ENTRIES_PER_CATEGORY)
      : []
  const rejected = take(parsed.rejected_ideas)
  const preferences = take(parsed.verbal_preferences)
  const notes = take(parsed.non_functional_notes)
  if (rejected.length === 0 && preferences.length === 0 && notes.length === 0) return undefined
  return {
    version: 1,
    distilled_at: new Date().toISOString(),
    rejected_ideas: rejected,
    verbal_preferences: preferences,
    non_functional_notes: notes,
  }
}

/**
 * 与背板重叠的条目一律丢弃（验收 ③：蒸馏产物与背板冲突以背板为准——
 * 单一事实源断言）。重叠判定用双向子串包含（蒸馏条目是转写短语，措辞可能与背板不同）。
 */
function dropBackplaneOverlap(memory: ProjectMemory, backplane: PrdBackplane): ProjectMemory {
  const authoritative = [
    ...(backplane.constraints ?? []),
    ...backplane.out_of_scope,
    ...backplane.requirements.map((item) => item.description),
  ]
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter((value) => value.length >= 2)
  const isOverlapping = (entry: string): boolean =>
    authoritative.some((source) => source.includes(entry) || entry.includes(source))
  return {
    ...memory,
    rejected_ideas: memory.rejected_ideas.filter((entry) => !isOverlapping(entry)),
    verbal_preferences: memory.verbal_preferences.filter((entry) => !isOverlapping(entry)),
    non_functional_notes: memory.non_functional_notes.filter((entry) => !isOverlapping(entry)),
  }
}
