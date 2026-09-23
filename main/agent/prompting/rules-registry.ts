/**
 * 操作契约 ID 注册表（Phase 3 B2，2026-09-09，P1 稿 §3 M2 / 咨询 B 缺口 1/3）。
 *
 * 硬约束从各段 prompt 的散落内联文字，收敛为 ID 单点定义的结构化条款：
 * 触发—必须—禁止替代—受阻 四段式 + 一句理由 + 条款等级（不变量/完成标准/偏好）。
 * 各消费方只引用 R-* ID；完整定义只在注册表渲染一次（防双源）。
 *
 * 开关 BLOMA_RULES_REGISTRY（缺省 off=字节级现状：内联原文保留、本表零注入）；
 * on 时消费方（当前：loop system prompt）删除对应内联原文、注入本表渲染段——
 * 同一规则永远只有一份完整定义。
 *
 * 与【术语纪律】段的关系（总计划 B2「合并防双源」）：术语纪律是措辞规范（词表），
 * 本表是操作不变量（行为契约），两者不相交；新增规则时先查术语段避免重复表述。
 */

import { gameDeriveExemptEnabled } from '../../model/prd-backplane'

/** 条款等级（写法纪律：区分不变量/完成标准/偏好，不全叫最高优先级）。 */
export type RuleKind = 'invariant' | 'completion' | 'preference'

export interface OperationRule {
  /** 注册表 ID：R-<域>-<序号>，单点定义、他处只引用 */
  id: string
  /** 条款名（一句话） */
  name: string
  /** 触发：什么情况下本条款生效 */
  trigger: string
  /** 必须：唯一合规做法 */
  must: string
  /** 禁止替代：常见的不合规替代（含合理化变体，写具体） */
  forbidden: string
  /** 受阻：做不到时怎么办（报告而非绕过） */
  blocked: string
  /** 理由：一句（不写惩罚/虚构检测） */
  reason: string
  kind: RuleKind
}

/**
 * 首批三条（P1 稿 M2 表格；R-FILE-01/R-DATA-01 从 loop prompt 内联原文提取，
 * R-OUTPUT-01 为新增——此前只有 output-integrity 代码侧守卫，无 prompt 条款）。
 */
export const RULES_REGISTRY: readonly OperationRule[] = [
  {
    id: 'R-FILE-01',
    name: '既有文件修改前置',
    trigger: '修改已存在于骨架或前轮产物中的文件',
    must: '先用 read_file 读该文件当前内容，再基于读到的现状编辑；read_file 返回末尾带「文件版本」，把它作为 edit_file 的 expected_revision 传入可实现工具层校验',
    forbidden: '凭记忆、凭 plan/摘要或凭猜测描述文件现状后直接编辑（文件可能已被修复轮或上一迭代修改；传旧版本号会被 STALE_READ 拒绝）',
    blocked: 'read 失败（文件不存在/读取报错）则不修改该文件，在旁白报告阻塞原因',
    reason: '修复轮与上一迭代会改变文件，凭旧印象编辑必然写错',
    kind: 'invariant',
  },
  {
    id: 'R-DATA-01',
    name: '业务数据持久化',
    trigger: '数据留存类需求（保存/历史/记录/收藏/刷新或重开后仍在）',
    must: '用后端持久化：server/routes/ 路由 + ctx.readData/writeData 落 data/ 目录',
    forbidden: 'localStorage/sessionStorage 存业务数据（含「临时先用、后续替换」「PRD 只说刷新后仍在」等合理化变体）',
    blocked: '持久化方式在契约中未明确时，报告缺口等待澄清，不自行降级为前端存储',
    reason: '前端存储随清缓存丢失且不可被探针可信验证；后端持久化同样满足「刷新后仍在」',
    kind: 'invariant',
  },
  {
    id: 'R-OUTPUT-01',
    name: '工具协议不进正文',
    trigger: '任何需要执行操作或调用工具的意图',
    must: '只经工具通道发起调用；收到工具结果后才在旁白陈述结果；测试未全绿不声称完成',
    forbidden: '把工具调用协议原文（JSON / tool_calls 标记）写进正文冒充已执行；无结果时宣称成功',
    blocked: '无法发起工具调用时，在旁白报告阻塞与原因，不伪造结果',
    reason: '正文里的协议文本不会被执行，冒充成功会污染验收与过程记录',
    kind: 'invariant',
  },
]

/** BLOMA_RULES_REGISTRY 开关：缺省 off（内联原文=现状）；on 时注册表渲染替换内联。 */
export function rulesRegistryEnabled(): boolean {
  const raw = (process.env.BLOMA_RULES_REGISTRY ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true'
}

/** C1b（2026-09-11 拍板）：game 豁免开启时 R-DATA-01 的 game 变体——轻留存允许
 *  localStorage（重业务数据仍后端）；仅替换 R-DATA-01 一条，其余规则不动。
 *  非 game / 豁免 off → 原表（字节级现状）。 */
export function rulesForTemplateType(templateType?: import('../../../shared/types').TemplateType): readonly OperationRule[] {
  if (templateType !== 'game' || !gameDeriveExemptEnabled()) return RULES_REGISTRY
  return RULES_REGISTRY.map((rule) =>
    rule.id === 'R-DATA-01'
      ? {
          ...rule,
          must: '按数据量级分流：重业务数据（用户内容/多记录管理）用后端持久化 server/routes/ 路由 + ctx.readData/writeData 落 data/；街机游戏轻留存（最高分/最佳成绩等单值数据）可用 localStorage',
          forbidden: '把重业务数据存 localStorage/sessionStorage（含「临时先用、后续替换」等合理化变体）；轻留存反向过度设计出后端',
          blocked: '数据量级不确定时，在旁白说明选择依据（单值轻留存→localStorage；内容型多记录→后端）',
          reason: 'game 轻留存豁免（C1b 拍板）：最高分类单值数据 localStorage 足够且可被探针读取；重数据后端持久化仍是完整程序口径',
        }
      : rule,
  )
}

/**
 * 渲染操作契约段（每条规则只出现一次完整定义）。
 * sectionTitle 允许消费方定制段名（默认适配 loop）；空表返回空串（零注入）。
 */
export function renderRulesSection(rules: readonly OperationRule[] = RULES_REGISTRY, sectionTitle = '【操作契约（不变量——效率、简洁、测试通过均不得违反）】'): string {
  if (rules.length === 0) return ''
  const lines: string[] = [sectionTitle]
  for (const rule of rules) {
    lines.push(`- ${rule.id}｜${rule.name}`)
    lines.push(`  触发：${rule.trigger}`)
    lines.push(`  必须：${rule.must}`)
    lines.push(`  禁止替代：${rule.forbidden}`)
    lines.push(`  受阻：${rule.blocked}（理由：${rule.reason}）`)
  }
  return lines.join('\n')
}
