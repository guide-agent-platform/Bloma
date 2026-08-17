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

/** 用户侧触发器：按键（含方向/空格/回车/字母数字）或点击（按钮文本/语义 class 提示）。 */
export interface BehaviorTrigger {
  kind: 'key' | 'click'
  /** KeyboardEvent.key（kind=key 时） */
  key?: string
  /** 点击目标提示：按钮文本或语义化 class 片段（kind=click 时） */
  target?: string
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

/** 触发→效果分隔符：「→」「->」「之后就」「之后」「时」「后」。 */
const ARROW_RE = /^(.+?)(?:→|->|=>|之后就|之后|的时候|时|后)(.+)$/

/**
 * 解析单条行为断言。
 *
 * 结构约定（normalizer 提示词产出形态）：「<触发>→<效果>」，如
 * 「按右方向键→车辆 x 坐标增加」「点击保存按钮→列表新增一条记录」。
 * 触发器与效果都解析成功才是行为探针；否则 presenceFallback。
 */
export function parseBehaviorAssertion(assertion: string): AssertionPlan {
  const text = assertion.trim()
  const match = ARROW_RE.exec(text)
  if (!match) return { assertion: text, presenceFallback: true }
  const trigger = parseTrigger(match[1])
  const effect = parseEffect(match[2])
  if (!trigger || !effect) return { assertion: text, presenceFallback: true }
  return { assertion: text, trigger, effect, presenceFallback: false }
}

/** 解析触发器：按/点击 + 按键名或按钮提示。 */
function parseTrigger(raw: string): BehaviorTrigger | undefined {
  const text = raw.trim()
  // 按键类：按右(方向键)/按左键/按上/按下方向键/按空格/按回车/按 W 键
  if (/(按|敲|触发)/.test(text)) {
    if (/右/.test(text)) return { kind: 'key', key: 'ArrowRight' }
    if (/左/.test(text)) return { kind: 'key', key: 'ArrowLeft' }
    if (/上/.test(text)) return { kind: 'key', key: 'ArrowUp' }
    if (/下/.test(text)) return { kind: 'key', key: 'ArrowDown' }
    if (/空格|space/i.test(text)) return { kind: 'key', key: ' ' }
    if (/回车|enter/i.test(text)) return { kind: 'key', key: 'Enter' }
    if (/esc|退出键/i.test(text)) return { kind: 'key', key: 'Escape' }
    if (/删除|退格|backspace/i.test(text)) return { kind: 'key', key: 'Backspace' }
    // 「按 W 键」「按 1」等单字符键
    const singleKey = /按\s*([A-Za-z0-9])\s*键?/.exec(text)
    if (singleKey) return { kind: 'key', key: singleKey[1].toUpperCase() === singleKey[1] ? singleKey[1] : singleKey[1].toUpperCase() }
  }
  // 点击类：点击保存按钮 / 点「开始」 / 单击提交
  const clickMatch = /(点击|单击|点按|按下|点)\s*[「「'"“]?([^」」'"”]+?)[」」'"”]?\s*(?:按钮|键|控件|图标)?$/.exec(text)
  if (clickMatch) {
    const target = clickMatch[2]?.trim()
    if (target && target.length <= 12) return { kind: 'click', target }
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
  if (/(文字|文本|内容|数值|数字|状态|结果).{0,6}(变化|改变|更新|刷新|变化为|变为)/.test(text)) {
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
  return `点击「${trigger.target ?? ''}」控件`
}
