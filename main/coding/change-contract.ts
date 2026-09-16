/**
 * Phase 10 W1-4（2026-09-16，咨询 G 收口·真实项目交付体系）：变更契约 ChangeContract。
 * RoundAnchor（B3）的一般化：变更不只是「修哪几条」，还有「必须保留什么、什么算
 * 违规、旧契约与数据凭什么活着」。三向验收（正向/负向/兼容）+ 基线绑定。
 * 负向断言 v0 纯确定性：不变量词表（非负/非空/唯一/上限/时间边界/禁止类）扫描
 * requirements 与行为断言文本；无命中如实为空不编造（LLM 加厚留 v1）。
 * 契约是 anchor 的超集输入：roundAnchorFromChangeContract 把契约投影回
 * RoundAnchorSpec（既有 anchor 注入链零改动）；renderChangeContractSection 渲染
 * 【变更契约】段进 system。
 * 依赖：shared/types（ChangeContract）+ model/prd-backplane（背板与 anchor 类型）。
 * 开关 BLOMA_CHANGE_CONTRACT：'1'/'on'/'true'=开；未设/'0'/'off'/'false'=关
 * （缺省 off，零注入零派生，字节级现状）。
 */
import type { ChangeContract } from '../../shared/types'
import type { PrdBackplane, RoundAnchorSpec, SketchRequirement } from '../model/prd-backplane'
import { requirementAssertions, requirementStory } from '../model/prd-backplane'

/** 开关解析（与 roundAnchorEnabled 同风格，每次调用读取）。 */
export function changeContractEnabled(): boolean {
  const raw = (process.env.BLOMA_CHANGE_CONTRACT ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true'
}

/** 不变量词表：命中即在负向验收中登记（确定性，无 LLM）。 */
const INVARIANT_PATTERNS: Array<{ re: RegExp; tag: string }> = [
  { re: /不能为负|不可为负|非负|不为负|负数.{0,6}(不行|不可|禁止)/, tag: '非负' },
  { re: /必填|不能为空|不可为空|不允许为空|不可空/, tag: '非空' },
  { re: /唯一|不可重复|不能重复|不得重复/, tag: '唯一' },
  { re: /不能超过|不可超过|上限|最多不超过/, tag: '上限' },
  { re: /不能早于|不可早于|不能是未来|不可为未来|不能晚于|不可晚于/, tag: '时间边界' },
  { re: /禁止|不得(?!改|破)/, tag: '禁止类规则' },
]

export interface DeriveChangeContractInput {
  /** 变更目标（用户诉求原话；修复轮为失败清单摘要） */
  goal: string
  backplane: PrdBackplane
  /** 聚焦功能项 id（迭代轮 focus；修复轮可缺省） */
  focus?: string[]
  /** data/ 数据文件相对路径（来自 ContextPack；有则登记数据兼容约束） */
  dataFiles?: string[]
  /** 上次终验结果（null=无基线报告） */
  baseline: { passed: number; total: number } | null
  /** 产物 git 基线短 hash（W1-1 开启时由调用方读取；缺省不记） */
  gitCommit?: string
}

function deriveNegativeAssertions(backplane: PrdBackplane): string[] {
  const out: string[] = []
  for (const item of backplane.requirements ?? []) {
    const text = [item.description ?? '', item.story ?? '', ...(item.behavior_assertions ?? [])].join('\n')
    const hits = INVARIANT_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.tag)
    if (hits.length === 0) continue
    for (const tag of [...new Set(hits)].slice(0, 2)) {
      out.push(`${item.id}（${tag}）：违反「${(item.description ?? '').slice(0, 40)}」规则的输入必须被明确拒绝或提示，不得静默通过`)
    }
    if (out.length >= 8) break
  }
  return out
}

function deriveMustPreserve(backplane: PrdBackplane, dataFiles: string[]): string[] {
  const out: string[] = []
  for (const ep of backplane.interface_spec ?? []) {
    if (!ep.endpoint.trim()) continue
    out.push(`契约端点 ${(ep.method || 'GET').toUpperCase()} ${ep.endpoint.trim()} 变更后保持可用（响应语义不破坏）`)
  }
  for (const f of dataFiles.slice(0, 4)) {
    out.push(`既有数据 ${f} 变更后完整可读（字段不丢不重写；结构变化必须带迁移）`)
  }
  return out.slice(0, 10)
}

/** 确定性派生变更契约。无命中字段如实为空。 */
export function deriveChangeContract(input: DeriveChangeContractInput): ChangeContract {
  const focusSet = new Set(input.focus ?? [])
  const focused: SketchRequirement[] = (input.backplane.requirements ?? []).filter((r) => focusSet.has(r.id))
  const positive = focused.flatMap((item) => requirementAssertions(item).slice(0, 2)).slice(0, 6)
  return {
    goal: input.goal,
    mustPreserve: deriveMustPreserve(input.backplane, input.dataFiles ?? []),
    outOfScope: [
      '不顺手重构、换库、调目录结构或改需求语义',
      ...(input.backplane.out_of_scope ?? []).slice(0, 3),
    ],
    acceptance: {
      positive,
      negative: deriveNegativeAssertions(input.backplane),
      compat: [
        ...(input.backplane.interface_spec ?? []).some((ep) => ep.endpoint.trim())
          ? ['全部契约端点经 run_gwt_tests/api 契约检查存活（404/5xx=失败）']
          : [],
        ...(input.dataFiles && input.dataFiles.length > 0
          ? ['变更后旧数据读取断言通过（既有记录仍出现且内容完整）']
          : []),
      ],
    },
    baseline: {
      testReportPresent: input.baseline !== null,
      passed: input.baseline?.passed ?? 0,
      total: input.baseline?.total ?? 0,
      ...(input.gitCommit ? { gitCommit: input.gitCommit } : {}),
    },
  }
}

/** 契约 → 本轮锚投影（超集输入：契约激活时 anchor 由契约派生，注入链零改动）。 */
export function roundAnchorFromChangeContract(contract: ChangeContract): RoundAnchorSpec {
  return {
    must_preserve: contract.mustPreserve.length > 0 ? contract.mustPreserve : ['全部 P0 功能项断言保持通过'],
    out_of_scope: contract.outOfScope,
    completion_evidence: [
      ...contract.acceptance.positive,
      ...contract.acceptance.negative,
      ...contract.acceptance.compat,
      'run_gwt_tests 全量不回退',
    ],
  }
}

/** 渲染【变更契约】段（空段如实省略；独立导出便于单测与 A/B）。 */
export function renderChangeContractSection(contract: ChangeContract): string {
  const lines: string[] = [`【变更契约（宿主确定性派生）】目标：${contract.goal || '（见任务书）'}`]
  const bullet = (title: string, entries: string[]) => {
    const list = entries.filter(Boolean)
    if (list.length > 0) lines.push(`- ${title}：${list.join('；')}`)
  }
  bullet('必须保留', contract.mustPreserve)
  bullet('范围外', contract.outOfScope)
  bullet('正向验收', contract.acceptance.positive)
  bullet('负向验收（违规输入必须拒绝）', contract.acceptance.negative)
  bullet('兼容性验收', contract.acceptance.compat)
  if (contract.baseline.testReportPresent) {
    lines.push(`- 基线：上次终验 ${contract.baseline.passed}/${contract.baseline.total} 过${contract.baseline.gitCommit ? `（git ${contract.baseline.gitCommit}）` : ''}，变更后不得低于该基线`)
  } else {
    lines.push('- 基线：无历史测试报告（首次验收即基线）')
  }
  lines.push('（契约是验收边界不是实现指令；实现方式仍由你按项目现状决定）')
  return lines.join('\n')
}

/** 接线助手：开关 off 返回 ''（字节级零注入）；on 返回渲染段（含前导空行便于拼接）。 */
export function buildChangeContractBlock(contract: ChangeContract | null): string {
  if (!changeContractEnabled() || !contract) return ''
  return `\n\n${renderChangeContractSection(contract)}`
}
