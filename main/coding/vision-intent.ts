/**
 * vision-intent.ts — 视觉审计的「意图提取器 v1」（2026-09-12 裁定后的第 2 步）。
 *
 * 定位：给对照审核者提供**基准**——"代码/需求声称应该有什么"。
 * 基准权威分级（issue #10 追加裁定 ①）：
 *   需求/背板（用户可见承诺）= **唯一基准** ← 本模块只吃这一级
 *   入口可达代码 = 辅助证据（可验证/证伪，不作基准）
 *   孤岛代码（脚手架/官方模块库物化但未被引用）= 仅 evidence_ref
 *
 * v1 来源与取舍（裁定 ⑫ + 第一版意图来源确认）：
 *   ✅ 背板 requirements（结构化功能项）+ positioning
 *   ❌ GWT 场景（与 L0 的"真控件/断言泄漏"判定高度重叠，增量小）
 *   ❌ 全量代码语义分析（成本与误报不可控）
 *   ⚠️ 入口可达代码第一版不做（静态可达性亦有 canvas 动态加载的漏报），留待 5–10 个真实产物校准误报率后再定
 *
 * 版本时效（裁定 ⑩）：意图清单带 backplane_hash；背板更新即失效重取。
 * 人工可审：清单落项目文档 intent-list.json（文档面板可见），每项带 evidence_ref 指回原文位置。
 */
import { createHash } from 'node:crypto'
import type { PrdBackplane } from '../model/prd-backplane'

/** 意图项：一个"应当存在于画面"的元素/特性的声明。 */
export interface IntentItem {
  /** 稳定标识（用功能项 id，如 F-001；复验按此对齐——裁定 ②） */
  element_id: string
  source: 'backplane'
  /** 需求是否声明它存在（v1 只收 claimed=true 的项） */
  claimed: boolean
  /** 期望角色：feature=功能特性；positioning=产品定位；screen=整屏 */
  expected_role: 'feature' | 'positioning' | 'screen'
  /** 期望文案（功能项描述原文；用于"是什么"维度的核对） */
  expected_text: string | null
  /** 期望状态（v1 统一 visible；状态维度的细判留待 UX 规格接入） */
  expected_state: 'visible'
  /** 证据引用：指回原文位置，供人工复核 */
  evidence_ref: string
  /** 生成本项时的背板哈希（裁定 ⑩） */
  backplane_hash: string
}

export interface IntentList {
  backplane_hash: string
  generated_at: string
  /** v1 只含背板来源；将来升格"入口可达代码"时在此追加  */
  sources_used: string[]
  items: IntentItem[]
}

/** 背板稳定子集哈希：参与语义的部分（定位 + 功能项 + 范围外 + 约束），忽略时间戳等噪声。 */
export function backplaneHash(backplane: Pick<PrdBackplane, 'positioning' | 'requirements' | 'out_of_scope' | 'constraints'>): string {
  const stable = {
    positioning: backplane.positioning ?? '',
    requirements: (backplane.requirements ?? []).map((r) => ({ id: r.id, description: r.description ?? '' })),
    out_of_scope: backplane.out_of_scope ?? [],
    constraints: backplane.constraints ?? [],
  }
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16)
}

/** 从背板构建意图清单 v1（确定性，无 LLM；无背板内容 → 空清单）。 */
export function buildIntentList(backplane: Pick<PrdBackplane, 'project_id' | 'positioning' | 'requirements' | 'out_of_scope' | 'constraints'>): IntentList {
  const hash = backplaneHash(backplane)
  const items: IntentItem[] = []

  const positioning = (backplane.positioning ?? '').trim()
  if (positioning) {
    items.push({
      element_id: 'positioning',
      source: 'backplane',
      claimed: true,
      expected_role: 'positioning',
      expected_text: positioning,
      expected_state: 'visible',
      evidence_ref: 'prd.json#positioning',
      backplane_hash: hash,
    })
  }

  for (const req of backplane.requirements ?? []) {
    const id = String(req.id ?? '').trim()
    const description = String(req.description ?? '').trim()
    if (!id) continue
    items.push({
      element_id: id,
      source: 'backplane',
      claimed: true,
      expected_role: 'feature',
      expected_text: description || null,
      expected_state: 'visible',
      evidence_ref: `prd.json#requirements/${id}`,
      backplane_hash: hash,
    })
  }

  return {
    backplane_hash: hash,
    generated_at: new Date().toISOString(),
    sources_used: ['backplane.positioning', 'backplane.requirements'],
    items,
  }
}

/** 清单是否仍与当前背板一致（不一致 = 失效，需重取——裁定 ⑩）。 */
export function intentListFresh(list: Pick<IntentList, 'backplane_hash'> | undefined, backplane: Parameters<typeof backplaneHash>[0]): boolean {
  if (!list) return false
  return list.backplane_hash === backplaneHash(backplane)
}

/** 渲染给对照审核者的紧凑清单（只给"应该有什么"，不给代码细节）。 */
export function renderIntentListForPrompt(list: IntentList): string {
  if (list.items.length === 0) return '（背板未声明任何可核对元素——本次只做描述真实性核查，不做符合性判定）'
  const lines = list.items.map((item) => {
    const text = item.expected_text ? `：${item.expected_text.slice(0, 120)}` : ''
    return `- [${item.expected_role}] ${item.element_id}${text}（期望状态：${item.expected_state}；证据：${item.evidence_ref}）`
  })
  return ['以下为需求/背板声明的**应存在元素**（唯一基准；画面与它不符即为偏差）：', ...lines].join('\n')
}
