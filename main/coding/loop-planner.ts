/**
 * loop-planner — P3 任务级三文档契约 · plan 腿（2026-09-04）。
 *
 * 定位：loop 前单轮「技术合同」（architect 腿的 Bloma 化：独立调用式子代理，对齐
 * 需求工程腿家族化先例——kernel/llm-call 标准件 + 外置 prompt 覆盖 + fail-closed）。
 * 产出 documents/{project_id}/plan.md（人读/回看）+ 内存对象注入 loop system（D1：
 * 单一格式防双口径漂移——loop 消费内存对象，用户/快照回看消费 md）。
 *
 * 契约（实施稿 §4.1/§5）：
 * - **plan 是参考合同不是硬约束**（D2）：不做中途拦截、不做偏离校验阻断；偏离只在
 *   旁白/log 可见——硬拦截会让 loop 在计划错误时死路（plan 可能比模型判断差）；
 * - 任何失败（无渠道/LLM/解析/校验）→ generateLoopPlan 返回 null → 调用方 fail-open
 *   回退现状注入，不阻断 MVP 生成（callLlmForJson 天然 fail-closed，语义对齐）；
 * - 路径安全（PR-A 硬约束 11）：filesToTouch 校验拒绝 `..`、绝对路径、盘符、家目录
 *   前缀——plan 是模型产物，注入前必须过代码级守卫（validateLoopPlan）；
 * - 温度 0.2 / maxTokens 640000 / thinkingLevel off / attempts 2（D6：与主 loop 同渠道
 *   同 env、独立温度/maxTokens；对齐全渠道 640000 防思考零正文）。
 *
 * 开关（PR-D 三开关之一）：`BLOMA_PLAN_LEG`——'0'=强制关；'1'=强制开；未设时按模式
 * 缺省 quick=off / longterm=on（D7：quick 是延迟敏感的确认-生成闭环，longterm 的
 * token 成本与漂移风险才值得 plan 对价）。
 */

import { callLlmForJson } from '../kernel/llm-call'
import { loadPromptOverride } from '../prompt-config'
import { existsSync } from 'fs'
import { join } from 'path'
import {
  backplaneInterfaceSpec,
  requirementAssertions,
  requirementPriority,
  requirementStory,
  type PrdBackplane,
} from '../model/prd-backplane'
import type { ProjectMode } from '../../shared/types'
import type { SDKQuery } from '../orchestrator'

// =========================================================================
// 数据契约（实施稿 §4.1）
// =========================================================================

/** 目标文件（相对项目根；数量上限按模式：quick ≤12 / longterm ≤20）。 */
export interface LoopPlanFile {
  path: string
  reason: string
}

/** 复用点：骨架文件/既有模块/示例——from 说明复用什么，how 说明怎么复用。 */
export interface LoopPlanReuse {
  from: string
  how: string
}

/** 技术合同（loop 参考合同；内存对象注入 + plan.md 落盘，双消费同一对象）。 */
export interface LoopPlan {
  filesToTouch: LoopPlanFile[]
  reuse: LoopPlanReuse[]
  /** 验证口径（须对齐背板 P0 断言——prompt 纪律：每条引用断言原文或功能项 id） */
  verification: string[]
  risks: string[]
  /** PR-C 迭代分级锚定用：本合同涉及的功能项 id */
  involvedRequirementIds?: string[]
}

/** filesToTouch 数量上限（模式分档：quick 12 / longterm 20，实施稿 §4.1）。 */
export const PLAN_FILES_LIMIT: Record<ProjectMode, number> = { quick: 12, longterm: 20 }

/** plan 腿调用参数固定值（D6：独立温度/maxTokens，与主 loop 同渠道同 env）。 */
export const PLAN_TEMPERATURE = 0.2
export const PLAN_MAX_TOKENS = 640000
export const PLAN_ATTEMPTS = 2

// =========================================================================
// 纯函数：parse / validate（路径安全守卫）
// =========================================================================

/**
 * 相对路径安全归一：反斜杠归一为 `/`、剥空白；拒绝 `..`（任意位置）、绝对路径
 * （`/` 前缀）、Windows 盘符（`X:`）、家目录（`~`）与 URL 形态（`://`）。
 * 返回 null = 违规（validateLoopPlan 据此整体拒绝 → 走 fallback）。
 */
export function normalizePlanPath(raw: string): string | null {
  const path = raw.trim().replace(/\\/g, '/')
  if (!path) return null
  // 任意路径段为 .. 即拒绝（覆盖 `..`、`../x`、`a/../b`、`a/..` 全形态）
  if (path.split('/').includes('..')) return null
  if (path.startsWith('/')) return null
  if (/^[a-zA-Z]:/.test(path)) return null
  if (path.startsWith('~')) return null
  if (path.includes('://')) return null
  return path
}

/** 字符串数组字段清洗：过滤非字符串/空串，限量截取，逐条截长（防模型灌水）。 */
function parseStringArray(raw: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const value = entry.trim()
    if (!value) continue
    out.push(value.slice(0, maxChars))
    if (out.length >= maxItems) break
  }
  return out
}

/** 复用点清洗：非对象/缺 from 的条目丢弃；how 缺省占位不拒收（增强字段）。 */
function parseReuse(raw: unknown): LoopPlanReuse[] {
  if (!Array.isArray(raw)) return []
  const out: LoopPlanReuse[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const from = String((entry as Record<string, unknown>).from ?? '').trim()
    if (!from) continue
    const how = String((entry as Record<string, unknown>).how ?? '').trim() || '（模型未说明方式）'
    out.push({ from: from.slice(0, 120), how: how.slice(0, 160) })
    if (out.length >= 8) break
  }
  return out
}

/**
 * 守卫校验（PR-A 测试锁定面）：filesToTouch 非空 + 数量上限 + 路径安全 + 去重 +
 * unknown 键忽略。任何违规返回 undefined → 调用方走 fallback（fail-closed，绝不
 * 把危险路径注入 loop）。
 */
export function validateLoopPlan(plan: unknown, opts?: { maxFiles?: number }): LoopPlan | undefined {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return undefined
  const record = plan as Record<string, unknown>
  const maxFiles = opts?.maxFiles ?? PLAN_FILES_LIMIT.longterm
  if (!Array.isArray(record.filesToTouch) || record.filesToTouch.length === 0) return undefined
  if (record.filesToTouch.length > maxFiles) return undefined
  const seen = new Set<string>()
  const filesToTouch: LoopPlanFile[] = []
  for (const entry of record.filesToTouch) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
    const rawPath = (entry as Record<string, unknown>).path
    if (typeof rawPath !== 'string') return undefined
    const path = normalizePlanPath(rawPath)
    if (!path) return undefined
    if (seen.has(path)) continue // 去重（首见保留）
    seen.add(path)
    const reason = String((entry as Record<string, unknown>).reason ?? '').trim() || '（模型未给理由）'
    filesToTouch.push({ path, reason: reason.slice(0, 160) })
  }
  if (filesToTouch.length === 0) return undefined
  const involved = parseStringArray(record.involvedRequirementIds, 40, 32)
  return {
    filesToTouch,
    reuse: parseReuse(record.reuse),
    verification: parseStringArray(record.verification, 12, 200),
    risks: parseStringArray(record.risks, 8, 160),
    ...(involved.length > 0 ? { involvedRequirementIds: involved } : {}),
  }
}

/** 模型输出 → LoopPlan（剥代码围栏 → JSON.parse → validate；失败/抛错返回 undefined）。 */
export function parseLoopPlan(text: string, opts?: { maxFiles?: number }): LoopPlan | undefined {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  try {
    return validateLoopPlan(JSON.parse(cleaned), opts)
  } catch {
    return undefined
  }
}

// =========================================================================
// 渲染（plan.md 人读全文 / system 注入段）
// =========================================================================

/** documents/{project_id}/plan.md 全文（人读/快照回看消费，D1 的 md 腿）。 */
export function renderPlanMarkdown(plan: LoopPlan): string {
  const files = plan.filesToTouch.map((file) => `- \`${file.path}\`：${file.reason}`).join('\n')
  const reuse = plan.reuse.length
    ? plan.reuse.map((entry) => `- ${entry.from}：${entry.how}`).join('\n')
    : '- 无'
  const verification = plan.verification.length ? plan.verification.map((entry) => `- ${entry}`).join('\n') : '- 无'
  const risks = plan.risks.length ? plan.risks.map((entry) => `- ${entry}`).join('\n') : '- 无'
  const involved = plan.involvedRequirementIds?.length ? plan.involvedRequirementIds.join('、') : '（未标注）'
  return [
    '# 技术合同（plan 腿）',
    '',
    '> loop 前单轮规划产出。**参考合同**：编程 Agent 实施中若有更优判断可偏离，但须在旁白说明原因；不构成硬约束。',
    '',
    '## 目标文件（filesToTouch）',
    '',
    files,
    '',
    '## 复用点（reuse）',
    '',
    reuse,
    '',
    '## 验证口径（verification，对齐 P0 断言）',
    '',
    verification,
    '',
    '## 风险（risks）',
    '',
    risks,
    '',
    '## 涉及功能项',
    '',
    `- ${involved}`,
    '',
  ].join('\n')
}

/** 注入段目标文件区的字符预算：超出后剩余文件只列路径不列理由（D3 哲学：只减细节不减锚）。 */
const INJECTION_FILES_REASON_BUDGET = 420
/** 注入段验证口径行数上限（其余口径在 plan.md 全文）。 */
const INJECTION_VERIFICATION_LINES = 5

/**
 * loop system 注入段（≤600 字量级，D1 的内存对象腿）。组成（实施稿 §4.2）：
 * 参考合同声明 + filesToTouch 表 + reuse 表 + verification 行 + 自测收口行；
 * risks 不进注入（plan.md 专属）。文件多时理由降级为存在性行——路径锚绝不丢。
 */
export function renderPlanInjection(plan: LoopPlan): string {
  const fileLines: string[] = []
  let reasonBudget = INJECTION_FILES_REASON_BUDGET
  let pathOnlyFrom = -1
  for (let index = 0; index < plan.filesToTouch.length; index += 1) {
    const file = plan.filesToTouch[index]
    if (reasonBudget > 0) {
      fileLines.push(`- ${file.path}：${file.reason}`)
      reasonBudget -= file.path.length + file.reason.length + 4
    } else {
      if (pathOnlyFrom < 0) pathOnlyFrom = index
      fileLines.push(`- ${file.path}`)
    }
  }
  const reuseLines = plan.reuse.length
    ? plan.reuse.slice(0, 4).map((entry) => `- ${entry.from}：${entry.how}`).join('\n') +
      (plan.reuse.length > 4 ? `\n- （另有 ${plan.reuse.length - 4} 个复用点）` : '')
    : '- 无'
  const verificationLines: string[] = plan.verification.slice(0, INJECTION_VERIFICATION_LINES).map((entry) => `- ${entry}`)
  if (plan.verification.length > INJECTION_VERIFICATION_LINES) {
    verificationLines.push(`- （另有 ${plan.verification.length - INJECTION_VERIFICATION_LINES} 条验证口径，按 system 锚定段断言自测）`)
  }
  return [
    '【技术合同（plan 腿产出，默认架构——目标文件清单是推荐的模块拆分，实施时尽量按清单逐个落文件；偏离（如合并文件）须在旁白用一句话说明原因）】',
    '目标文件：',
    ...fileLines,
    '复用点：',
    reuseLines,
    '验证口径（对齐 P0 断言）：',
    ...(verificationLines.length > 0 ? verificationLines : ['- 按 system 锚定段全部 P0 断言自测']),
    '改完按验证口径自测（run_gwt_tests 对照行为断言）后再声明完成。',
  ].join('\n')
}

// =========================================================================
// 调用腿（generateLoopPlan）与开关
// =========================================================================

/** plan 腿总闸：'0'=强制关；'1'=强制开；未设按模式缺省 quick=off / longterm=on（D7）。 */
export function planLegEnabled(mode: ProjectMode): boolean {
  const raw = (process.env.BLOMA_PLAN_LEG ?? '').trim().toLowerCase()
  if (raw === '0' || raw === 'off' || raw === 'false') return false
  if (raw === '1' || raw === 'on' || raw === 'true') return true
  return mode === 'longterm'
}

/** system prompt（角色/输出契约/纪律；maxFiles 动态内嵌进任务输入上限说明）。 */
function planSystemPrompt(maxFiles: number, localOnly = false): string {
  return [
    '你是「Bloma 编程 · 技术规划腿」（loop 前单轮调用的架构子代理：干净上下文、低温确定性产出，只规划不实现）。',
    '输入是 PRD 背板摘要（功能项清单 + P0 断言）与工程骨架地图，你要产出一份技术合同 JSON，供编程 Agent Loop 作为参考合同常驻执行。',
    '',
    '输出契约（严格 JSON，不要 markdown 围栏，不要任何多余文字）：',
    '{"filesToTouch":[{"path":"src/app.js","reason":"承载核心交互逻辑"}],"reuse":[{"from":"src/styles.css（骨架）","how":"样式直接扩展不重写"}],"verification":["F-001 按右方向键→车辆 x 坐标增加"],"risks":["方向键断言依赖焦点管理，需先聚焦再按键"],"involvedRequirementIds":["F-001"]}',
    '',
    '字段纪律：',
    // Phase 8 W2-3：局部修改轮——只改既有文件，禁止新建（定位合同语义）
    '- filesToTouch：' + (localOnly ? '本轮要修改的既有文件（局部修改轮：禁止规划新建文件，禁止规划与诉求无关的功能）' : '本轮要新建或修改的文件') + '（相对项目根，如 index.html、src/app.js），数量上限 ' + maxFiles + '，每个附一句理由；',
    // 完整程序阶段 2.5（2026-09-06 计算器案）：plan 只列前端文件 → loop 顺手 localStorage 满足
    // 「刷新后仍在」，server/routes 渠道被整体绕过——架构纪律必须在合同层锁死
    '- 架构纪律（完整程序）：凡功能含数据留存/服务端处理/模型调用，filesToTouch 必须包含对应 server/routes/<资源>.js（后端路由，文件名即 /api/ 前缀）及前端调用侧改动；' +
      '数据持久化一律规划为后端 data/（ctx.readData/writeData），禁止规划 localStorage/sessionStorage 持久化方案；',
    '- reuse：可复用的骨架既有文件/模块，说明怎么复用；无则空数组；',
    '- verification：验证口径，每条引用 P0 断言原文或以功能项 id 开头（如「F-003 按右方向键→…」）；',
    '- risks：技术风险 0-3 条；',
    '- involvedRequirementIds：本合同涉及的功能项 id；',
    '- 只规划不实现：不写代码内容，只决定文件布局、复用方式与验证口径。',
  ].join('\n')
}

/** generateLoopPlan 的输入（与主 loop 同渠道同 env：query/env 直取主 loop channel context）。 */
export interface GenerateLoopPlanInput {
  mode: ProjectMode
  backplane: PrdBackplane
  /** 骨架地图注入文本（prepareSkeletonBeforeLoop 产物）；null = 无骨架从零建 */
  skeletonMap: string | null
  query: SDKQuery
  env: Record<string, string>
  sessionId: string
  /** 渠道 providerType（omit 黑名单判断；主 loop channel 透传） */
  providerType?: string
  signal?: AbortSignal
  /** P3 分级锚定（迭代路径）：聚焦功能项 id——聚焦项断言全文进 prompt，其余项一行摘要；
 *  规划只覆盖聚焦项的改动，不重做其余项 */
  focusRequirementIds?: string[]
  /** Phase 8 W2-3：局部修改轮定位合同——规划任务改为「定位修改点与影响面」,
 *  filesToTouch 限定既有文件（禁止新建文件合同）；需与 projectRootPath 同时传 */
  localOnly?: boolean
  /** 局部修改轮的用户诉求原话（定位合同的定位目标） */
  localPrompt?: string
  /** 项目根绝对路径（localOnly 时用于「既有文件」存在性过滤） */
  projectRootPath?: string
}

/** 任务输入（user prompt）：背板摘要（focus 生效时分级渲染）+ 骨架地图 + 模板类型 + 上限提醒。 */
function buildPlanPrompt(input: GenerateLoopPlanInput, maxFiles: number): string {
  // Phase 8 W2-3：局部修改轮定位合同——任务从「规划实现」改为「定位修改点与影响面」,
  // 核心约束：只输出需要修改的既有文件，禁止规划新建文件/无关功能（狗粮 94f449c6:
  // 全量规划口径产出「新建 game-core.js」合同直接误导模型重做全项目）。
  if (input.localOnly) {
    return [
      `产品定位：${input.backplane.positioning}`,
      `【本轮用户修改诉求（局部优化，其余保持现状）】${input.localPrompt ?? '（未提供，按聚焦功能项定位）'}`,
      ...(input.focusRequirementIds && input.focusRequirementIds.length > 0
        ? [`诉求归入的功能项：${input.focusRequirementIds.join('、')}（断言见背板锚）`]
        : []),
      '项目已实现并在运行（不是从零新建）：请定位诉求对应的修改点与影响面，输出技术合同 JSON。',
      '硬约束：',
      '- filesToTouch 只包含需要修改的既有文件（禁止新建文件；不确定文件名时用 grep 关键词描述在 reason 里）；',
      '- 不规划与诉求无关的功能、不重做既有功能；',
      `- filesToTouch 数量上限 ${Math.min(maxFiles, 6)}（局部修改应远小于全量）。`,
    ].join('\n')
  }
  const focusSet = input.focusRequirementIds && input.focusRequirementIds.length > 0
    ? new Set(input.focusRequirementIds)
    : undefined
  const items = input.backplane.requirements.map((item) => {
    if (focusSet && !focusSet.has(item.id)) {
      // 未聚焦项一行摘要（只减细节不减锚）：规划不覆盖其改动，但知道存在
      return `- [${item.id}]（${requirementPriority(item)}）${requirementStory(item)}（断言 ${requirementAssertions(item).length} 条，本轮未聚焦：保持现状勿重做）`
    }
    const assertions = requirementAssertions(item).map((assertion) => `  - ${assertion}`).join('\n')
    return `- [${item.id}]（${requirementPriority(item)}）${requirementStory(item)}` + (assertions ? `\n${assertions}` : '')
  }).join('\n')
  const outOfScope = input.backplane.out_of_scope.length
    ? input.backplane.out_of_scope.map((entry) => `- ${entry}`).join('\n')
    : '- 无'
  const templateType = input.backplane.template_meta?.type ?? 'personal_tool'
  // 完整程序阶段 2.5：契约进 plan 任务输入——plan 腿不知道接口契约就不会规划后端文件
  const endpoints = backplaneInterfaceSpec(input.backplane)
  return [
    `产品定位：${input.backplane.positioning}`,
    ...(endpoints.length > 0
      ? [
          '后端 API 契约（interface_spec，前后端真相源）——filesToTouch 必须包含对应的 server/routes 实现文件：',
          ...endpoints.map((ep) => `- ${ep.method ?? 'GET'} ${ep.endpoint} → ${ep.response ?? 'JSON'}`),
        ]
      : []),
    ...(focusSet
      ? [`本轮迭代聚焦修改：${input.focusRequirementIds!.join('、')}——只规划聚焦项的改动，其余功能项保持现状不重做。`
        + '聚焦功能项清单（id/优先级/描述/行为断言，未聚焦项为一行摘要）：']
      : ['功能项清单（id/优先级/描述/行为断言）：']),
    items,
    '范围外（一律不规划）：',
    outOfScope,
    `模板类型：${templateType}`,
    '工程骨架地图：',
    input.skeletonMap ?? '（无工程骨架——目标文件全部新建，按 index.html / src/app.js / src/styles.css 组织）',
    `请输出技术合同 JSON（filesToTouch 数量上限 ${maxFiles}，路径相对项目根）。`,
  ].join('\n')
}

/**
 * plan 腿单轮调用（kernel/llm-call 标准件包装）：任何失败返回 null（fail-closed），
 * 调用方 fail-open 回退现状注入。attempts 2 = 首轮 + 带反馈重试一次。
 */
export async function generateLoopPlan(input: GenerateLoopPlanInput): Promise<LoopPlan | null> {
  const maxFiles = input.localOnly ? Math.min(PLAN_FILES_LIMIT[input.mode], 6) : PLAN_FILES_LIMIT[input.mode]
  const parsed = await callLlmForJson({
    systemPrompt: loadPromptOverride('plan-system') ?? planSystemPrompt(maxFiles, input.localOnly === true),
    prompt: buildPlanPrompt(input, maxFiles),
    query: input.query,
    env: input.env,
    sessionId: input.sessionId,
    maxTokens: PLAN_MAX_TOKENS,
    temperature: PLAN_TEMPERATURE,
    attempts: PLAN_ATTEMPTS,
    thinkingLevel: 'off',
    ...(input.providerType !== undefined ? { providerType: input.providerType } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    parse: (text) => parseLoopPlan(text, { maxFiles }),
  })
  // Phase 8 W2-3：局部修改轮硬过滤——模型仍给出不存在的文件时直接剔除（定位合同
  // 的语义就是「改既有文件」）；剔除后为空 → 返回 null（无合同优于误导性合同，
  // 调用方 fail-open 回退无 plan 现状，任务书本身已携带定位指令）。
  if (parsed && input.localOnly && input.projectRootPath) {
    const existing = parsed.filesToTouch.filter((file) => existsSync(join(input.projectRootPath!, file.path)))
    if (existing.length === 0) return null
    return { ...parsed, filesToTouch: existing }
  }
  return parsed
}

/**
 * W5-1（Phase 8.5，2026-09-12 狗粮 dd6ba98d）：plan 合同 checklist 化——把
 * filesToTouch 分组为有序编号任务，提供「逐项推进、完成勾选」的工作结构
 * （对齐本平台 agent 的任务清单工作法；plan 合同细节仍由 renderPlanInjection 提供）。
 * 分组规则确定性：入口（index.html/styles）→ src 子目录模块 → 装配入口 → 后端路由 → 其余。
 */
export function renderTaskChecklist(plan: LoopPlan): string {
  if (plan.filesToTouch.length === 0) return ''
  const groupOf = (path: string): { order: number; label: string } => {
    if (path === 'index.html' || path === 'src/styles.css') return { order: 0, label: '入口与样式' }
    if (path === 'src/app.js') return { order: 2, label: '装配入口' }
    if (path.startsWith('server/')) return { order: 3, label: '后端路由' }
    if (path.startsWith('src/')) {
      const sub = path.split('/')[1]
      return sub ? { order: 1, label: `src/${sub}/ 模块` } : { order: 2, label: 'src 根模块' }
    }
    return { order: 4, label: '其他' }
  }
  const groups = new Map<string, { order: number; label: string; files: LoopPlanFile[] }>()
  for (const file of plan.filesToTouch) {
    const g = groupOf(file.path)
    const key = `${g.order}|${g.label}`
    if (!groups.has(key)) groups.set(key, { ...g, files: [] })
    groups.get(key)!.files.push(file)
  }
  const ordered = [...groups.values()].sort((a, b) => a.order - b.order)
  const items = ordered.map((group, index) => {
    const fileList = group.files.map((file) => file.path).join('、')
    const reasons = [...new Set(group.files.map((file) => file.reason.replace(/[。；;]$/, '')))].slice(0, 2).join('；')
    // 轻量验证映射：验证口径里提及组内文件名关键词的行挂到该项，挂不上的留在全局清单
    const stems = group.files.map((file) => file.path.split('/').pop()?.replace(/\.[a-z]+$/, '') ?? '')
    const verification = plan.verification
      .filter((entry) => stems.some((stem) => stem && entry.includes(stem)))
      .slice(0, 2)
    return [
      `${index + 1}. [ ] ${group.label}：${fileList} —— ${reasons}`,
      ...(verification.length > 0 ? [`   验证：${verification.join('；')}`] : []),
    ].join('\n')
  })
  return [
    '## 实施清单（按序推进，完成一项即勾选进入下一项）',
    ...items,
    '工作纪律：每项先定位（grep/地图锚点 → read 只读命中段）→ 实现 → 有验证手段时立即验证 → 勾选进入下一项；禁止先全读再全写；已完成项不重读不重写，微调用 edit_file。',
  ].join('\n')
}
