/**
 * 共享提示词骨架（§7.0，2026-08-17 设计：借鉴 oh-my-openagent 的
 * buildHardBlocksSection / buildAntiPatternsSection）。
 *
 * 一份共享规则，各引擎提示词按需拼接——规则只在单点维护，避免各引擎
 * 各写一份后互相漂移（历史上 MVP/草图/PRD 三处各写过一版「禁外部网络」，
 * 措辞与力度都不一致）。
 */

/** 硬约束：所有引擎复用（生成型/判定型都适用）。 */
export const HARD_BLOCKS: readonly string[] = [
  '不编造文件路径/行号/配置键，不确定就明说',
  '不擅自扩功能（严格守住范围排除清单）',
  '纯前端零外部依赖（沙箱 CSP connect-src=none，禁外部网络）',
  '禁用 eval()/new Function()/Function() 构造器/setTimeout/setInterval 传字符串等动态执行方式（沙箱 CSP 已禁 unsafe-eval，违规代码会被直接拦截）',
  '不写 <meta http-equiv="Content-Security-Policy">（平台统一注入，双 CSP 会互相冲突）',
  '输出必须是要求的结构化格式（JSON/HTML），不输出多余文字、解释或 markdown 围栏',
]

/** 反模式：执行型引擎（MVP 生成/修复）复用。 */
export const ANTI_PATTERNS: readonly string[] = [
  '最小满足：行为断言是完成标尺，不是「标题实现一下」——断言说「x 坐标增加」就要真的驱动坐标',
  '只改文字不改行为：「让文字变」≠「实现功能」，交互控件必须真实驱动应用状态',
  '删除失败测试来「通过」：测试是门禁不是障碍',
  '忽略行为断言只贴背板：功能项列表不是装饰，每条断言都要能对应到具体代码',
]

/** 硬约束段（各引擎系统提示词拼接）。 */
export function buildHardBlocksSection(): string {
  return ['【硬约束（HARD BLOCKS，违反即废品）】', ...HARD_BLOCKS.map((rule) => `- ${rule}`)].join('\n')
}

/** 反模式段（执行型引擎系统提示词拼接）。 */
export function buildAntiPatternsSection(): string {
  return ['【反模式（ANTI-PATTERNS，出现即退回重做）】', ...ANTI_PATTERNS.map((rule) => `- ${rule}`)].join('\n')
}
