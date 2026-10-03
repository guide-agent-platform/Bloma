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

import type { TemplateType } from '../../shared/types'

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
 * 匹配顺序 = 优先级：桌面（载体最稀有、信号最强）> 游戏（具体产品形态）> 网页 > 复刻 > AI（归个人小工具）> 小工具词 > 兜底。
 * 12.2 的「CLI/脚本」行并入个人小工具（12.3 模板分类仅三种，无独立 CLI 模板）。
 */
const TYPE_RULES: TypeRule[] = [
  {
    type: 'desktop_tool',
    strength: 'strong',
    pattern: /桌面(?:软件|应用|端|工具|程序|计算器|日历|时钟|便签|倒计时|天气|播放器|截图|录屏|词典)|电脑(?:上|上面|里)?的?(?:软件|工具|程序|应用)|(?:装|安装|跑|运行|用)\s*在\s*电脑(?:上|里)|(?:win|windows|mac|苹果电脑|linux)\s*(?:程序|软件|应用|上)|本地(?:软件|应用|安装|程序)|安装包|exe\b/i,
    // M-2：「效率工具」已移出——功能词抢跑载体词：「效率工具网站」「在线效率工具」
    // 全被误判 desktop_tool，注入点②⑤⑥⑧全链用错模板；载体词（网站/网页/桌面…）才是判型依据。
    // 2026-09-25 狗粮实证补：「桌面+具体产品名」（桌面计算器/桌面日历…）也是强载体信号
    //（用户自然描述习惯，无歧义；2026-09-24「桌面计算器」项目因此误判 personal_tool）
  },
  {
    // P1-8/P1-9（2026-09-04）：游戏明确词 → game 类型。放 web_fullstack **之前**：
    // 「网页游戏」是游戏而非普通网页——游戏是更具体的产品形态，必测类别要用状态机/碰撞/胜负，
    // 而非对游戏空转的「边界输入不崩溃」。此前无 game 类型，游戏被兜底 personal_tool 吃不到骨架包。
    type: 'game',
    strength: 'strong',
    pattern: /游戏|小游戏|贪吃蛇|扫雷|2048|俄罗斯方块|打砖块|飞机大战|跑酷|塔防|闯关|街机|像素风/i,
  },
  {
    type: 'web_fullstack',
    strength: 'strong',
    pattern: /网站|网页|博客|商城|电商|店铺|后台|管理(?:系统|端|后台)|官网|落地页|论坛|社区|门户|(?:web|h5|html5)\s*(?:页面|应用|网站)?|浏览器(?:里|中|上)?(?:用|打开|访问)|在线[\u4e00-\u9fa5A-Za-z0-9]{0,4}?(?:工具|应用|平台|系统)|小程序/i,
  },
  {
    // 「复刻/重制」放 web_fullstack **之后**：「复刻一个网站」先命中 web_fullstack（网站词），
    // 「以撒复刻」这类 IP 复刻（无网页/游戏词）落到 game——复刻几乎都指复刻游戏/软件（web 全栈产物）。
    type: 'game',
    strength: 'strong',
    pattern: /复刻|重制/i,
  },
  {
    // 二期口径：AI 关键词暂归个人小工具（模板包 v1 仅三种；ai_app 类型值保留待二期模板）
    type: 'personal_tool',
    strength: 'weak',
    pattern: /调用\s*(?:ai|gpt|大模型|openai)|(?:接入|使用)\s*(?:ai|llm)|做智能|智能(?:助手|推荐|问答)|大模型|chatgpt|ai\s*(?:助手|应用|工具)/i,
  },
  {
    // 桌面唯一品类对齐（fc3f6fab 狗粮实证，2026-10-03）：本地小工具词原归
    // personal_tool（多品类时代语义）——10-01 web 线退役后 desktop_tool 是唯一
    // 生成线且为主攻品类（09-26 拍板），裸「计算器/番茄钟/记账…」应直进桌面线
    // 而非判 personal_tool 后靠形态引导卡多一步。保持 weak：显式载体词（网站/网页/
    // 桌面…strong 规则在前优先）与澄清轮改判语义不变（「网页里加个计算器」仍是 web）。
    type: 'desktop_tool',
    strength: 'weak',
    pattern: /(?:处理|清洗|整理|转换)(?:数据|表格|文件|批量)|(?:批量|脚本|命令行|cli)|计算器|生成器|转换器|计时器|番茄钟|倒计时|待办|清单|笔记|记账|账本|习惯打卡|密码(?:器|生成)|单页|小工具/i,
  },
]

/** 兜底类型（桌面唯一品类对齐，2026-10-03）：无信号输入直接进桌面生成线
 *  （唯一生成线；web/game/ai_app 显式词仍走原判型→PRD 后形态引导卡）。 */
export const DEFAULT_TEMPLATE_TYPE: TemplateType = 'desktop_tool'

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
 * 推断；weak 信号不动已有判断（「说到计算器」不代表要把已判定的 web 项目改成
 * 小工具——可能只是网页里的一个功能）。
 * 桌面唯一品类对齐（2026-10-03）：兜底与小工具词均已归 desktop_tool——weak
 * 命中 desktop 时与兜底同类型短路，AI 词族 weak 命中 personal_tool 但 weak 恒不
 * 改判，行为不变；测试锁定。
 *
 * 返回 undefined = 维持现状（调用方不写盘）。
 */
export function refineTemplateType(current: TemplateType, message: string): TemplateType | undefined {
  const hit = inferStrength(message)
  if (hit.strength === 'none') return undefined
  if (hit.type === current) return undefined
  if (hit.strength === 'strong') return hit.type
  // weak 恒不改判（同类型短路外的可达路径只有 strong，见 doc 注释）
  return undefined
}
