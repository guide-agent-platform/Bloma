/**
 * 桌面线需求摘要渲染（2026-09-26 首跑修复）。
 *
 * 背景：首跑实证——桌面调度员与子会话此前没有任何需求注入路径（调度员系统提示词只含
 * 阶段任务书，子会话基底只有委派规则），架构/实现子会话看不到 PRD。本模块把 PRD 背板
 * 映射为紧凑的「需求清单」文本，由编排层装配进调度员系统提示词与子会话基底 system。
 *
 * 纯函数零依赖（结构类型入参，不引 model 层——R1 合规）；调用方负责取值与容错。
 */

import { readPrdBackplane } from '../project/document-engine'
import { requirementPriority, type ProductShape, type UxExperienceSpec } from '../model/prd-backplane'
import { renderShapeBrief, renderShapeVerifyBrief } from './shape-templates'
import { acceptanceAssociationIssues, requirementEvidenceHash, trustedAcceptance } from '../project/requirement-contract'

export interface RequirementDigestItem {
  source_refs?: import('../../shared/attachment-types').MaterialSourceRef[]
  id: string
  description: string
  /** 优先级（P0/P1/P2；缺省不渲染标签） */
  priority?: string
  acceptance?: string
  behavior_assertions?: string[]
  scope_notes?: string
  requirement_hash?: string
}

export interface RequirementDigestInput {
  items: RequirementDigestItem[]
  positioning?: string
  constraints?: string[]
  out_of_scope?: string[]
  assumptions?: string[]
  prd_document?: string
  /** 单项描述截断上限（默认 140 字符） */
  maxDescriptionChars?: number
  /** 最多输出条数（默认 24；超出以省略行注明） */
  maxItems?: number
}

/**
 * 渲染需求摘要（逐行 `- F-xxx [P0] 描述`）。
 * 空清单返回空串——调用方以「空串 = 不注入」口径处理（fail-open）。
 */
export function renderRequirementsDigest(input: RequirementDigestInput): string {
  const maxItems = input.maxItems ?? 24
  const maxChars = input.maxDescriptionChars ?? 140
  const shown = input.items.slice(0, maxItems)
  const lines = shown.flatMap((item) => {
    const description =
      item.description.length > maxChars ? `${item.description.slice(0, maxChars)}…` : item.description
    const sources = item.source_refs?.map(ref => `${ref.attachment_id}@${ref.sha256.slice(0, 12)}:${ref.start_line ?? ''}-${ref.end_line ?? ''}`).join('；')
    const assertions = [...new Set((item.behavior_assertions ?? []).map((text) => text.trim()).filter(Boolean))]
    return [
      `- ${item.id}${item.priority ? ` [${item.priority}]` : ''} ${description}${sources ? `（材料来源：${sources}）` : ''}`,
      ...(item.requirement_hash ? [`  验证版本：${item.requirement_hash}`] : []),
      ...(item.acceptance?.trim() ? [`  验收要点：${item.acceptance.trim()}`] : []),
      ...assertions.map((assertion) => `  行为断言：${assertion}`),
      ...(item.scope_notes?.trim() ? [`  本项范围排除：${item.scope_notes.trim()}`] : []),
    ]
  })
  if (input.items.length > shown.length) {
    lines.push(`- …其余 ${input.items.length - shown.length} 项（略）`)
  }
  if (input.positioning?.trim()) lines.unshift(`产品定位：${input.positioning.trim()}`)
  for (const [heading, entries] of [
    ['用户约束（必须遵守）', input.constraints],
    ['范围排除（不得实现）', input.out_of_scope],
    ['已记录假设（不得冒充用户原话）', input.assumptions],
  ] as const) {
    const values = entries?.map((text) => text.trim()).filter(Boolean) ?? []
    if (values.length) lines.push(`\n【${heading}】`, ...values.map((text) => `- ${text}`))
  }
  if (input.prd_document?.trim()) {
    lines.push('\n【已确认 PRD 全文（补充上下文；与上列契约矛盾时报告，不自行扩大范围）】', input.prd_document.trim())
  }
  return lines.join('\n')
}

/** 九态中文标签（digest 渲染用；与 prd-backplane UxStateId 同源，批9 2026-10-07 扩两态）。 */
const UX_STATE_LABELS: Record<UxExperienceSpec['states'][number]['id'], string> = {
  empty: '空态',
  ready_input: '待输入',
  validating: '校验中',
  running: '执行中',
  success: '成功',
  partial: '部分成功',
  failed: '失败',
  cancelled: '已取消',
  unconfigured: '待配置',
}

/**
 * 渲染体验契约段（UX 契约线，2026-10-06）：背板 ux 存在时渲染紧凑文本注入子会话上下文；
 * 缺省返回 undefined（任务书通用七态兑底纪律兜底，不注入）。纯函数供单测。
 */
export function renderUxDigest(ux: UxExperienceSpec | undefined): string | undefined {
  if (!ux || ux.states.length === 0) return undefined
  const lines = ['【体验契约（PRD 确认时冻结——实现按此交付，不得自行改定义）】']
  lines.push('状态（用户在该状态看到什么）：')
  for (const state of ux.states) {
    lines.push(`- ${UX_STATE_LABELS[state.id]}（${state.id}）：${state.observable}`)
  }
  if (ux.feedback_rules.length > 0) {
    lines.push('反馈规则：')
    for (const rule of ux.feedback_rules) {
      lines.push(`- ${rule}`)
    }
  }
  return lines.join('\n')
}

/** 形状摘要标签渲染（批9 工件1：shape 随 PRD 冻结后注入调度员/子会话上下文）。 */
const SHAPE_HOST_LABELS: Record<ProductShape['host_template'], string> = {
  instant_utility: '即时工具（输入→结果→复制）',
  record_manager: '记录管理（表单+列表+留存）',
  file_pipeline: '文件管线（批量处理→逐个产出）',
  job_runner: '任务执行器（长任务监控）',
}

/**
 * 渲染形状摘要段（批9 工件1）：背板 shape 存在时渲染紧凑文本——宿主模板/主循环/
 * 事实来源/时长档/破坏性操作/LLM 角色/job_policy；缺省返回 undefined（无形状增强，
 * 任务书不注入）。纯函数供单测。llm_role≠none 时附 LLM 交付语义一句（分层断言
 * 口径见 verify 任务书）。
 */
export function renderShapeDigest(shape: ProductShape | undefined): string | undefined {
  if (!shape) return undefined
  const lines = [`【产品形状（PRD 冻结——已选定：${SHAPE_HOST_LABELS[shape.host_template]}）】`]
  lines.push(`- 主工作循环：${shape.primary_loop}`)
  lines.push(`- 事实来源：${shape.fact_source}｜任务时长：${shape.task_duration}${shape.needs_resident ? '｜需常驻' : ''}${shape.needs_network ? '｜需联网' : ''}`)
  if (shape.destructive_ops.length > 0) lines.push(`- 破坏性操作：${shape.destructive_ops.join('；')}（必须确认或备份后再执行）`)
  if (shape.modules.length > 0) lines.push(`- 次级形状：${shape.modules.join('；')}`)
  if (shape.llm_role !== 'none') {
    const roleText: Record<ProductShape['llm_role'], string> = {
      core: 'core——移除 LLM 产品不成立：真实验证不过不得宣称完整交付（Provider Qualification 平台侧收口）',
      optional: 'optional——AI 是增强功能：可降级交付，如实标注降级项',
      preview: 'preview——生成内容仅预览示意：交付时如实标注',
      user_config: 'user_config——交付时用户自配 key：必须实现无 key 引导界面（unconfigured 态：说明文案+设置入口）',
      none: '',
    }
    lines.push(`- AI 角色：${shape.llm_role}，${roleText[shape.llm_role]}`)
  }
  lines.push(`- 任务策略：可取消=${shape.job_policy.cancellable ? '是' : '否（用户口径）'}；进度反馈=${shape.job_policy.progress ? '是' : '否'}；关闭时=${shape.job_policy.close_policy}`)
  return lines.join('\n')
}

/**
 * 读取项目 PRD 背板的形状任务书注入段（批9 工件2）：implement 双书用 shapeBrief、
 * verify 用 shapeVerifyBrief；背板无 shape（旧项目/降级）返回空对象（任务书占位符
 * 渲染为空串）。fail-open：背板缺失/读取失败不阻断。
 */
export function readDesktopShapeBriefs(projectId: string): { shapeBrief?: string; shapeVerifyBrief?: string } {
  try {
    const backplane = readPrdBackplane(projectId)
    const shape: ProductShape | undefined = backplane.shape
    const shapeBrief = renderShapeBrief(shape)
    const shapeVerifyBrief = renderShapeVerifyBrief(shape)
    return {
      ...(shapeBrief ? { shapeBrief } : {}),
      ...(shapeVerifyBrief ? { shapeVerifyBrief } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * 读取项目 PRD 背板并渲染需求摘要（桌面线上下文装配便捷函数）。
 * fail-open：背板缺失/读取失败返回 undefined——不阻断主链（如实无注入）。
 * UX 契约线（2026-10-06）：背板 ux 存在时在需求清单后追加体验契约段（同一注入点，
 * quick/longterm 子会话同享）。
 * 批9（2026-10-07）：背板 shape 存在时再追加形状摘要段（同注入点）。
 */
export function readDesktopRequirementsDigest(projectId: string): string | undefined {
  try {
    const backplane = readPrdBackplane(projectId)
    const associationIssues = acceptanceAssociationIssues(backplane)
    const digest = renderRequirementsDigest({
      positioning: backplane.positioning,
      constraints: backplane.constraints,
      out_of_scope: backplane.out_of_scope,
      assumptions: backplane.assumptions,
      prd_document: associationIssues.length ? undefined : backplane.prd_document,
      // 运行契约不得用展示窗口裁剪：全部功能、长描述与验收条件都传给实现者。
      maxItems: backplane.requirements.length,
      maxDescriptionChars: Number.MAX_SAFE_INTEGER,
      items: backplane.requirements.map((item) => ({
        id: item.id,
        description: item.description,
        priority: requirementPriority(item),
        source_refs: item.source_refs,
        acceptance: trustedAcceptance(backplane, item),
        requirement_hash: requirementEvidenceHash(backplane, item),
        behavior_assertions: item.behavior_assertions,
        scope_notes: item.scope_notes,
      })),
    })
    const parts = [digest.trim() ? digest : '',
      '交付范围：全部已确认功能项均须逐项记录实现状态与证据；P0/P1/P2 只决定顺序，漏填优先级不能免除交付。',
      ...associationIssues, renderUxDigest(backplane.ux) ?? '', renderShapeDigest(backplane.shape) ?? ''].filter(Boolean)
    return parts.length > 0 ? parts.join('\n\n') : undefined
  } catch {
    return undefined
  }
}
