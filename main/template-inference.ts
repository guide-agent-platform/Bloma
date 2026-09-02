/**
 * 项目类型推断（注入点①，2026-09-02 周计划 §6 / 方案 §六）。
 *
 * PRD 12.2 关键词→类型映射的本周实现（原「推断规则留待架构设计阶段确定」留白口子）。
 * 对用户透明（12.2「向导 Agent 从对话提取关键词自动匹配，对用户不可见」）。
 *
 * 调研对照（research/P2P4P5-类型推断与模板包-借鉴笔记.md）：Spec Kit/Kiro/OpenSpec
 * 均不做自动类型检测（开发者工具，用户自选）；Bloma 是小白用户产品，用户不懂
 * 类型术语——系统推断 + 澄清轮可修正 + 兜底宽松级（误判代价最小：把宽松模板
 * 错给标准项目只是 PRD 变薄，反之多问用户问题）。
 *
 * 范围界定：greenfield/brownfield 维度不做（我方所有项目均新建，无存量代码接入；
 * Kiro Requirements-First/Design-First 的区分对注入点⑥ loop 改现有代码才有意义，
 * 二期再议）。ai_app 类型值保留但推断不出（模板包二期，AI 关键词暂归个人小工具）。
 */

import type { TemplateType } from '../shared/types'

/** 类型→推断置信（显式形态词=strong；小工具具体词=weak——可被后续 strong 信号修正）。 */
type InferenceStrength = 'strong' | 'weak' | 'none'

interface TypeRule {
  type: TemplateType
  /** 桌面端/网页端等形态词：strong（显式声明载体形态） */
  strength: InferenceStrength
  pattern: RegExp
}

/**
 * 关键词表（PRD 12.2 展开为中文同义词族）。
 * 匹配顺序 = 优先级：桌面（载体最稀有、信号最强）> 网页 > AI（归个人小工具）> 小工具词 > 兜底。
 * 12.2 的「CLI/脚本」行并入个人小工具（12.3 模板分类仅三种，无独立 CLI 模板）。
 */
const TYPE_RULES: TypeRule[] = [
  {
    type: 'desktop_tool',
    strength: 'strong',
    pattern: /桌面(?:软件|应用|端|工具|程序)|电脑(?:上|上面|里)?的?(?:软件|工具|程序|应用)|(?:装|安装|跑|运行|用)\s*在\s*电脑(?:上|里)|(?:win|windows|mac|苹果电脑|linux)\s*(?:程序|软件|应用|上)|本地(?:软件|应用|安装|程序)|安装包|exe\b/i,
    // M-2：「效率工具」已移出——功能词抢跑载体词：「效率工具网站」「在线效率工具」
    // 全被误判 desktop_tool，注入点②⑤⑥⑧全链用错模板；载体词（网站/网页/桌面…）才是判型依据
  },
  {
    type: 'web_fullstack',
    strength: 'strong',
    pattern: /网站|网页|博客|商城|电商|店铺|后台|管理(?:系统|端|后台)|官网|落地页|论坛|社区|门户|(?:web|h5|html5)\s*(?:页面|应用|网站)?|浏览器(?:里|中|上)?(?:用|打开|访问)|在线[\u4e00-\u9fa5A-Za-z0-9]{0,4}?(?:工具|应用|平台|系统)|小程序/i,
  },
  {
    // 二期口径：AI 关键词暂归个人小工具（模板包 v1 仅三种；ai_app 类型值保留待二期模板）
    type: 'personal_tool',
    strength: 'weak',
    pattern: /调用\s*(?:ai|gpt|大模型|openai)|(?:接入|使用)\s*(?:ai|llm)|做智能|智能(?:助手|推荐|问答)|大模型|chatgpt|ai\s*(?:助手|应用|工具)/i,
  },
  {
    type: 'personal_tool',
    strength: 'weak',
    pattern: /(?:处理|清洗|整理|转换)(?:数据|表格|文件|批量)|(?:批量|脚本|命令行|cli)|计算器|生成器|转换器|计时器|番茄钟|倒计时|待办|清单|笔记|记账|账本|习惯打卡|密码(?:器|生成)|单页|小工具/i,
  },
]

/** 兜底类型（12.2 无归类时优先个人小工具：宽松级误判代价最小）。 */
export const DEFAULT_TEMPLATE_TYPE: TemplateType = 'personal_tool'

/**
 * 关键词→类型推断（PRD 12.2）：首条消息/澄清消息共用。
 * 无命中 → personal_tool 兜底。桌面优先于网页（「电脑上做个网站」按桌面更贴近
 * 用户说的载体；纯「网站」词不受影响）。
 */
export function inferTemplateType(text: string): TemplateType {
  for (const rule of TYPE_RULES) {
    if (rule.pattern.test(text)) return rule.type
  }
  return DEFAULT_TEMPLATE_TYPE
}

/** 命中强度查询（澄清轮修正判定用）。 */
function inferStrength(text: string): { type: TemplateType; strength: InferenceStrength } {
  for (const rule of TYPE_RULES) {
    if (rule.pattern.test(text)) return { type: rule.type, strength: rule.strength }
  }
  return { type: DEFAULT_TEMPLATE_TYPE, strength: 'none' }
}

/**
 * 澄清轮类型修正（对用户透明）：用户后续话语带**显式形态信号**（strong）时更新
 * 推断；weak 信号不动已有判断（「说到计算器」不代表要把已判定的 web 项目改成小工具
 * ——可能只是网页里的一个功能）。首建兜底（personal_tool）对 weak 信号也让位——
 * 兜底本就是「没证据」的占位，任何具体词都是增量证据。
 *
 * 返回 undefined = 维持现状（调用方不写盘）。
 */
export function refineTemplateType(current: TemplateType, message: string): TemplateType | undefined {
  const hit = inferStrength(message)
  if (hit.strength === 'none') return undefined
  if (hit.type === current) return undefined
  if (hit.strength === 'strong') return hit.type
  // weak：仅当前值是「无证据兜底」且兜底未曾被 strong 确认时才让位——
  // 兜底值=personal_tool 且当前就是它：weak 命中 web/desktop 以外的 personal_tool
  // 词无意义（同类型）；weak 命中不了其它类型（AI 词已归 personal_tool），此处恒同类型
  return undefined
}
