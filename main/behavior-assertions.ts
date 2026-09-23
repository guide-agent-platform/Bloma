/**
 * 行为断言解析（§7.4/§8.1，M3 行为门禁的共享底座）。
 *
 * 把「按右方向键→车辆 x 坐标增加」这类行为断言解析为**可执行的触发器 + 效果**：
 * - gwt-runner 用它做浏览器内行为探针（模拟触发→断言状态变化）；
 * - gwt-service 静态兜底用它做关键词存在性检查（§8.1 有界静态启发式）；
 * - judge-engine 用它读运行证据 + 静态确认。
 *
 * 领域无关：只认动作词表（移动/隐藏/新增…），不认领域实体（车/记账/合成器）。
 * 解析不出触发器或效果的断言 → presenceFallback（存在性检查兜底，与改造前的
 * hasInteractiveEntry 语义同构），绝不因「看不懂断言」退回产物（防误伤）。
 */

import { parseEarsAssertion } from './guide/ears-vocabulary'

/** 用户侧触发器：按键（含方向/空格/回车/字母数字）、点击、双击、输入（fill）、下拉选择（select）。 */
export interface BehaviorTrigger {
  kind: 'key' | 'click' | 'dblclick' | 'fill' | 'select'
  /** KeyboardEvent.key（kind=key 时） */
  key?: string
  /** 目标提示：按钮文本/输入框语义/下拉项语义（非 key 类共用） */
  target?: string
  /** 填入值（kind=fill 时；从触发器语义提取，缺省固定「测试输入」）——
 *  与断言效果语义对齐（a8c7d17d 次级发现①：「输入关键词→显示匹配项」类
 *  断言若填固定值，输入即过滤/无结果提示类实现无法命中） */
  value?: string
}

/** 可探针的效果种类 + 静态启发式关键词（产物全文含其一即视为静态确认）。 */
export interface BehaviorEffect {
  kind: 'move-right' | 'move-left' | 'move-up' | 'move-down' | 'hide' | 'show' | 'add-item' | 'text-change'
  /** 静态启发式关键词（§8.1 词表映射）：SVG transform/CSS @keyframes 等同义实现也在此列 */
  keywords: string[]
}

export interface AssertionPlan {
  assertion: string
  trigger?: BehaviorTrigger
  effect?: BehaviorEffect
  /** 无法解析（含默认断言「该功能项在产物中可见且可交互」）→ 存在性检查兜底 */
  presenceFallback: boolean
}

/** 触发→效果分隔符：单点真相在 ears-vocabulary.splitAssertionAxis（M-5：箭头族优先 +
 *  语义词兑底要求 trigger ≥2 字），本模块不再维护平行正则。 */

/**
 * 解析单条行为断言。
 *
 * 结构约定（normalizer 提示词产出形态）：「<触发>→<效果>」，如
 * 「按右方向键→车辆 x 坐标增加」「点击保存按钮→列表新增一条记录」。
 * 触发器与效果都解析成功才是行为探针；否则 presenceFallback。
 */
export function parseBehaviorAssertion(assertion: string): AssertionPlan {
  const text = assertion.trim()
  // 前缀剥离 + 中轴切分单点在 ears-vocabulary（M-5：箭头族优先，语义词兜底）
  const ears = parseEarsAssertion(text)
  if (!ears.trigger || !ears.response) return { assertion: text, presenceFallback: true }
  const trigger = parseTrigger(ears.trigger)
  const effect = parseEffect(ears.response)
  if (!trigger || !effect) return { assertion: text, presenceFallback: true }
  return { assertion: text, trigger, effect, presenceFallback: false }
}

/** 解析触发器：按/点击/双击/输入/选择 + 按键名或目标提示。
 * 口径（M-3/M-4，与 ears-vocabulary TRIGGER_VOCABULARY 可探针子集一致，互查测试锁定）：
 * - 命名键（空格/回车/Esc/退格）优先于方向键判定（防「按下回车键」的「下」误判）；
 * - 方向键要求完整词形（方向字+「方向键/箭头/键」），「按下保存按钮」的「下」不是键名，
 *   落入 click 分支（词表 click 条目含「按下」，两处口径一致）；
 * - click 词表含「勾选/选中」；fill/select 为 M-4 新增可探针类。 */
function parseTrigger(raw: string): BehaviorTrigger | undefined {
  const text = raw.trim()
  // 按键类：按/敲/触发 + 完整键名（命名键先于方向键）
  if (/(按|敲|触发)/.test(text)) {
    if (/空格|space/i.test(text)) return { kind: 'key', key: ' ' }
    if (/回车|enter/i.test(text)) return { kind: 'key', key: 'Enter' }
    if (/esc|退出键/i.test(text)) return { kind: 'key', key: 'Escape' }
    if (/删除|退格|backspace/i.test(text)) return { kind: 'key', key: 'Backspace' }
    const direction = /右/.test(text) ? 'ArrowRight' : /左/.test(text) ? 'ArrowLeft' : /上/.test(text) ? 'ArrowUp' : /下/.test(text) ? 'ArrowDown' : undefined
    if (direction && /(方向键|箭头|键)/.test(text)) return { kind: 'key', key: direction }
    // 「按 W 键」「按 1」等单字符键
    const singleKey = /按\s*([A-Za-z0-9])\s*键?/.exec(text)
    if (singleKey) return { kind: 'key', key: singleKey[1].toUpperCase() === singleKey[1] ? singleKey[1] : singleKey[1].toUpperCase() }
  }
  // 双击类（M-4）：双击条目 / 双按XX
  const dblMatch = /双(?:击|按)\s*[「'"“]?([^」'"”，。,]{1,12})/.exec(text)
  if (dblMatch) {
    const target = dblMatch[1]?.trim()
    if (target) return { kind: 'dblclick', target }
  }
  // 点击类：点击保存按钮 / 点「开始」 / 单击提交 / 按下保存 / 勾选记住我（词表口径含「按下/勾选/选中」）
  const clickMatch = /(点击|单击|点按|按下|勾选|选中|点)\s*[「「'"“]?([^」」'"”]+?)[」」'"”]?\s*(?:按钮|键|控件|图标)?$/.exec(text)
  if (clickMatch) {
    const target = clickMatch[2]?.trim()
    if (target && target.length <= 12) return { kind: 'click', target }
  }
  // 输入类（M-4）：在XX输入框输入… / 输入XX（无框名时目标为任意输入框）。
  // T-8：开头的介词（在/向/往/于/从）先剥——否则 capture 把「在」带进 target。
  // a8c7d17d 回溯漏洞修复（2026-09-04）：旧正则懒惰 capture≥1 与可选介词组无锚定
  // 组合回溯——「在搜索框输入」介词组消费「在」后 capture 与复合框名「搜索框」
  // 对不齐，回溯让介词组匹配空，capture='在'（target='在'）致 fill 探针全 MISS。
  // 修法：剥介词后 ^ 锚定，capture 允许空 + 框名词入组；复合框名（搜索框）无
  // 前缀时 target 取框名语义前缀（搜索），其余泛化 input。
  if (/(输入|键入|填写|填入|录入)/.test(text)) {
    const stripped = text.replace(/^(?:在|向|往|于|从)\s*/, '')
    const boxMatch = /^([\u4e00-\u9fa5A-Za-z0-9]{0,8}?)\s*(输入框|文本框|输入域|搜索框|字段)/.exec(stripped)
    let target = 'input'
    if (boxMatch) {
      const label = boxMatch[1]?.trim() ?? ''
      const boxWord = boxMatch[2] ?? ''
      target = label || (boxWord === '搜索框' ? '搜索' : 'input')
    }
    // fill 值：输入动词后的宾语（语义对齐断言效果），清洗连接词尾巴；
    // 输入(?!框|域)排除框名词里的「输入」（「在输入框输入内容」取第二个动词）；
    // 无有效宾语回退固定「测试输入」（与旧口径兼容）
    const valueRaw = /(?:输入(?!框|域)|键入|填写|填入|录入)\s*[「'"“]?([^」'"”，。,]{1,12})/.exec(text)?.[1] ?? ''
    const value = valueRaw.replace(/(?:之后|然后|后|并|时|前).*$/, '').trim()
    return { kind: 'fill', target, ...(value && value !== target ? { value } : {}) }
  }
  // 下拉选择类（M-4）：选择XX / 下拉选XX / 切换到XX
  const selectMatch = /(?:选择|下拉选?|切换到?)\s*[「'"“]?([^」'"”，。,]{1,12})/.exec(text)
  if (selectMatch) {
    const target = selectMatch[1]?.trim()
    if (target) return { kind: 'select', target }
  }
  return undefined
}

/** 解析效果：坐标增减/移动方向/显隐/条目增减/文本变化。 */
function parseEffect(raw: string): BehaviorEffect | undefined {
  const text = raw.trim()
  // 位移类：x 坐标增加/向右移动/右移/水平右移……（SVG transform/CSS translate/left 均为同义实现）
  const MOVE_KEYWORDS = ['translate', 'transform', 'left', 'right', 'top', 'bottom', 'margin', 'grid', 'flex']
  if (/(x\s*坐标|横坐标|水平方向|向右|右移|往右)/.test(text) && /(增加|变大|增大|移动|前进|加速)/.test(text)) {
    return { kind: 'move-right', keywords: MOVE_KEYWORDS }
  }
  if (/(x\s*坐标|横坐标|水平方向|向左|左移|往左)/.test(text) && /(减小|减少|变小|移动|后退|倒退)/.test(text)) {
    return { kind: 'move-left', keywords: MOVE_KEYWORDS }
  }
  if (/(y\s*坐标|纵坐标|垂直方向|向下|下移|往下)/.test(text) && /(增加|变大|移动|下降|下落)/.test(text)) {
    return { kind: 'move-down', keywords: MOVE_KEYWORDS }
  }
  if (/(y\s*坐标|纵坐标|垂直方向|向上|上移|往上)/.test(text) && /(减小|减少|变小|移动|上升|上浮)/.test(text)) {
    return { kind: 'move-up', keywords: MOVE_KEYWORDS }
  }
  if (/(隐藏|消失|不见了|关闭|收起)/.test(text)) {
    return { kind: 'hide', keywords: ['hidden', 'display', 'visibility', 'opacity', 'remove', 'classList'] }
  }
  if (/(显示|出现|可见|展开|弹出)/.test(text)) {
    return { kind: 'show', keywords: ['display', 'visibility', 'opacity', 'classList', 'style'] }
  }
  if (/(新增|添加|加入|多一条|增加一条|记录一条|保存一条|生成一条|入账)/.test(text)) {
    return { kind: 'add-item', keywords: ['appendChild', 'insertAdjacentHTML', 'createElement', 'innerHTML', 'push(', 'unshift('] }
  }
  if (/(?:文字|文本|内容|数值|数字|状态|结果|计数|计时|时间|分数|得分|余额|数量).{0,6}(?:变化|改变|更新|刷新|变化为|变为|显示为|启动|停止|暂停|继续|清零|归零|重置)/.test(text)) {
    return { kind: 'text-change', keywords: ['textContent', 'innerText', 'innerHTML', 'value'] }
  }
  return undefined
}

/** 效果种类 → 用户可读动词（GWT 骨架 When/Then 与失败原因共用）。 */
export function describeEffect(effect: BehaviorEffect): string {
  const copy: Record<BehaviorEffect['kind'], string> = {
    'move-right': '目标元素向右位移',
    'move-left': '目标元素向左位移',
    'move-up': '目标元素向上位移',
    'move-down': '目标元素向下位移',
    hide: '目标元素隐藏或消失',
    show: '目标元素显示或出现',
    'add-item': '列表新增一条记录',
    'text-change': '页面文字或数值发生变化',
  }
  return copy[effect.kind]
}

/** 触发器 → 用户可读动词（GWT 骨架 When 用）。 */
export function describeTrigger(trigger: BehaviorTrigger): string {
  if (trigger.kind === 'key') {
    const keyCopy: Record<string, string> = {
      ArrowRight: '按下右方向键',
      ArrowLeft: '按下左方向键',
      ArrowUp: '按下上方向键',
      ArrowDown: '按下下方向键',
      ' ': '按下空格键',
      Enter: '按下回车键',
      Escape: '按下 Esc 键',
      Backspace: '按下退格键',
    }
    return keyCopy[trigger.key ?? ''] ?? `按下 ${trigger.key ?? ''} 键`
  }
  if (trigger.kind === 'dblclick') return `双击「${trigger.target ?? ''}」目标`
  if (trigger.kind === 'fill') return trigger.target === 'input' ? '在输入框输入内容' : `在「${trigger.target ?? ''}」输入框输入内容`
  if (trigger.kind === 'select') return `选择「${trigger.target ?? ''}」选项`
  return `点击「${trigger.target ?? ''}」控件`
}
