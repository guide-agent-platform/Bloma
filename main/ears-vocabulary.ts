/**
 * EARS 词表与句式解析——单点真相源（2026-09-02 周计划 §5，P1）。
 *
 * 三处消费方一律 import 本模块（陷阱 22「行为断言三处口径」教训前置规避）：
 * - EARS 化改写 prompt（requirement-earsifier，P3）——trigger/response 词表进提示词；
 * - GWT 派生（gwt-runner/gwt-service，P5 注入点⑦）——句式 → Given/When/Then 映射；
 * - judge 静态校验（judge-engine，P6）——禁词表直查 + 单 trigger 纪律检查。
 *
 * 句式集（方案 §4.1 拍板，只取 3；Mavin 2009 五句式砍 WHERE/ubiquitous——
 * 沙箱单页应用无 feature-flag 场景，无条件恒真句式不可探针）：
 * - WHEN <trigger> → <response>：事件驱动（主力，GWT 的 When）
 * - WHILE <state> → <response>：状态驱动（空态/加载态，GWT 的 Given）
 * - IF <condition> → <response>：非期望输入（异常边界必测，GWT 的 When + 异常类别）
 *
 * 目标形态刻意保留「触发→效果」中轴（与 behavior-assertions.ts 的
 * ARROW_RE 同构）：EARS 化是既有断言格式的**前缀升级**，不是平行格式——
 * 无前缀的存量断言按现状语义视为 WHEN，新旧断言同一解析链、零迁移。
 * 前缀段与中轴之间的兼容性由本模块测试与 parseBehaviorAssertion 联合锁定。
 */

// ---------------------------------------------------------------------------
// 句式
// ---------------------------------------------------------------------------

/** EARS 句式类别（无前缀的存量断言解析为 when，与现状「触发→效果」语义一致）。 */
export type EarsPatternKind = 'when' | 'while' | 'if'

/** 句式前缀（大小写不敏感；中文场景词与英文 EARS 关键词并认）。 */
const PATTERN_PREFIXES: Array<{ kind: EarsPatternKind; re: RegExp }> = [
  { kind: 'when', re: /^\s*(?:WHEN|当)\s*[:：]?\s*/i },
  { kind: 'while', re: /^\s*(?:WHILE|当处于|处于)\s*[:：]?\s*/i },
  { kind: 'if', re: /^\s*(?:IF|如果|若)\s*[:：]?\s*/i },
]

// ---------------------------------------------------------------------------
// trigger 词表（→ Playwright 事件映射；EARS 化 prompt 与 GWT 派生共用）
// ---------------------------------------------------------------------------

export interface TriggerVocabEntry {
  /** 中文动词/短语（正则源，EARS 化 prompt 展示为词表清单） */
  pattern: RegExp
  /** 对应 Playwright locator/动作类别（GWT 派生的 When 形态） */
  playwrightAction:
    | 'click'
    | 'dblclick'
    | 'fill'
    | 'selectOption'
    | 'setInputFiles'
    | 'check'
    | 'uncheck'
    | 'press'
    | 'hover'
    | 'dragTo'
    | 'scroll'
    | 'focus'
  /** 用户可读动作名（GWT 场景文本用） */
  label: string
}

/**
 * trigger 词表：按可映射 Playwright 事件的中文动词组织（方案 §4.2）。
 * 纪律约束（第四处口径）：其中按键/点击子集必须可被 behavior-assertions.ts
 * 的 parseTrigger 解析——词表新增条目时同步验证，测试锁定（本文件测试 +
 * behavior-assertions 测试互查），否则 EARS 化产物退化为 presenceFallback，
 * GWT 探针率不升反降。
 */
export const TRIGGER_VOCABULARY: TriggerVocabEntry[] = [
  { pattern: /双击|双(?:击|按)/, playwrightAction: 'dblclick', label: '双击' },
  { pattern: /点击|单击|点按|点「|按下|勾选/, playwrightAction: 'click', label: '点击' },
  { pattern: /输入|键入|填写|填入|录入/, playwrightAction: 'fill', label: '输入' },
  { pattern: /选择|选中|切换(?:到)?|下拉/, playwrightAction: 'selectOption', label: '选择' },
  { pattern: /上传|附加|导入文件/, playwrightAction: 'setInputFiles', label: '上传' },
  { pattern: /勾掉|取消勾选|取消选中/, playwrightAction: 'uncheck', label: '取消勾选' },
  { pattern: /按\s*(?:右|左|上|下)?(?:方向键|键)|按\s*[A-Za-z0-9]\s*键|按空格|按回车|按\s*esc|按下\s*(?:右|左|上|下)/i, playwrightAction: 'press', label: '按键' },
  { pattern: /悬停|移入|鼠标(?:移|停)/, playwrightAction: 'hover', label: '悬停' },
  { pattern: /拖(?:拽|动|到)/, playwrightAction: 'dragTo', label: '拖拽' },
  { pattern: /滚动|下滑|上滑|翻页/, playwrightAction: 'scroll', label: '滚动' },
  { pattern: /聚焦|光标(?:进入|定位)/, playwrightAction: 'focus', label: '聚焦' },
  // 注：「提交/保存/登录」等是「点击」的目标语义（UI 上均为 click 触发），不单列词表类——
  // 否则「点击保存按钮」被双类计数误判复合（单 trigger 纪律）；EARS 化 prompt 指导
  // 写成「点击保存按钮」形态。
]

// ---------------------------------------------------------------------------
// response 词表（→ 可断言终态；效果种类与 parseEffect 八类对齐）
// ---------------------------------------------------------------------------

export interface ResponseVocabEntry {
  pattern: RegExp
  /** 可断言终态类别（GWT 派生的 Then 断言形态） */
  assertionKind:
    | 'visible'
    | 'hidden'
    | 'disabled'
    | 'enabled'
    | 'navigation'
    | 'unchanged'
    | 'item-added'
    | 'text-change'
    | 'persisted'
    | 'prompt'
  label: string
}

/** response 词表：可断言终态（EARS 化 prompt 展示 + GWT Then 派生）。 */
export const RESPONSE_VOCABULARY: ResponseVocabEntry[] = [
  { pattern: /显示|出现|可见|弹出|展开/, assertionKind: 'visible', label: '显示/可见' },
  { pattern: /隐藏|消失|收起|关闭/, assertionKind: 'hidden', label: '隐藏/消失' },
  { pattern: /禁用|置灰|不可点/, assertionKind: 'disabled', label: '禁用/置灰' },
  { pattern: /可点击|可点|启用|恢复可用/, assertionKind: 'enabled', label: '可点击/启用' },
  { pattern: /跳转(?:至|到)|导航(?:至|到)|前往|进入.*页/, assertionKind: 'navigation', label: '跳转/导航' },
  { pattern: /保持|仍|不变|维持/, assertionKind: 'unchanged', label: '保持不变' },
  { pattern: /新增|添加|多一条|增加一条|生成一条|入列/, assertionKind: 'item-added', label: '新增条目' },
  { pattern: /(?:文字|文本|内容|数值|数字|状态|结果|计数).{0,6}(?:变化|改变|更新|刷新|变为)|显示为/, assertionKind: 'text-change', label: '文本/数值变化' },
  { pattern: /持久(?:化|保存)|保存后仍在|重开(?:后|时)仍|刷新(?:后|时)仍/, assertionKind: 'persisted', label: '持久化' },
  { pattern: /提示|警示|报错|错误信息|校验|拒绝/, assertionKind: 'prompt', label: '提示/校验' },
]

/**
 * response 禁词表（内审 EARS 可测性维度直查，方案 §4.2）：
 * 命中即「不可测措辞」——模糊程度高到无法写出确定断言（Kiro Analyze
 * Requirements 对 "large files"/"fast response times" 类措辞的同款判定）。
 * longterm 内审命中 → major issue（§九验收 7）。
 */
export const RESPONSE_FORBIDDEN_TERMS: string[] = [
  '优雅处理',
  '优雅地',
  '合理',
  '正确地',
  '友好',
  '尽量',
  '适当',
  '良好',
  '美观',
  '快速地',
  '高效地',
  '完美',
  '正常工作',
  '不出错',
]

// ---------------------------------------------------------------------------
// 解析（纯函数，供三处消费方共用）
// ---------------------------------------------------------------------------

/** EARS 断言解析结果。 */
export interface EarsAssertion {
  /** 原始断言全文 */
  raw: string
  /** 句式（无前缀存量断言 → when） */
  kind: EarsPatternKind
  /** 触发段（WHILE 句式为状态描述；无中轴分隔时为 undefined） */
  trigger: string | undefined
  /** 效果段 */
  response: string | undefined
  /** 单 trigger 纪律违规（trigger 段命中 ≥2 个不同触发动词，Mavin 消歧规则） */
  compoundTrigger: boolean
  /** 禁词命中（response 段含不可测措辞） */
  forbiddenResponse: boolean
  /** 结构完整：有句式前缀 + 中轴两侧都有内容 */
  wellFormed: boolean
}

/** 中轴分隔符：与 behavior-assertions.ts 的 ARROW_RE 同款家族（→/->/=>/之后就/之后/时/后）。 */
const EARS_ARROW_RE = /^(.+?)(?:→|->|=>|之后就|之后|的时候|时|后)(.+)$/

/** 解析单条 EARS 断言（词表与句式的唯一解析入口；judge/GWT/EARS 化共用）。 */
export function parseEarsAssertion(assertion: string): EarsAssertion {
  const text = assertion.trim()
  // 句式前缀识别（WHILE 先于 WHEN 匹配，防「当处于」被「当」截走）
  let kind: EarsPatternKind = 'when'
  let rest = text
  for (const entry of PATTERN_PREFIXES) {
    if (entry.re.test(rest)) {
      kind = entry.kind
      rest = rest.replace(entry.re, '')
      break
    }
  }
  const arrow = EARS_ARROW_RE.exec(rest)
  const trigger = arrow?.[1]?.trim() || undefined
  const response = arrow?.[2]?.trim() || undefined
  return {
    raw: text,
    kind,
    trigger,
    response,
    compoundTrigger: trigger ? isCompoundTrigger(trigger) : false,
    forbiddenResponse: response ? hasForbiddenResponse(response) : false,
    wellFormed: Boolean(trigger && response && trigger.length > 0 && response.length > 0),
  }
}

/**
 * 单 trigger 纪律（Mavin 消歧 + Cucumber 单 When 共同结论，方案 §4.2）：
 * 一条 EARS 只许一个 trigger。判定 = trigger 段命中 ≥2 个**不同**触发动词类
 * （「点击保存并点击取消」= click×2 计 1 类但明显复合，另以连接词佐证）。
 * 用「不同动词类计数 ≥2」为主判据，兼顾「和/或/并且/然后/同时」连接词佐证，
 * 避免单字「和」误伤「总和」类正常词汇。
 */
export function isCompoundTrigger(trigger: string): boolean {
  const matchedKinds = new Set<string>()
  for (const entry of TRIGGER_VOCABULARY) {
    if (entry.pattern.test(trigger)) matchedKinds.add(entry.label)
  }
  if (matchedKinds.size >= 2) return true
  // 单类动词 + 显式并列连接词 → 复合（「点击 A 和 B」「输入 x 然后 submit」；
  // 「并」单字仅出现在 trigger 段动作链中，正常语汇「合并」不进 trigger 段）
  return /(并且|并|然后|同时|以及|，之后|后再)/.test(trigger)
}

/** response 禁词直查（内审 EARS 可测性维度 / EARS 化改写自检共用）。 */
export function hasForbiddenResponse(response: string): boolean {
  return RESPONSE_FORBIDDEN_TERMS.some((term) => response.includes(term))
}

/** trigger 段命中词表的动作类别（GWT 派生 When 形态路由；未命中返回 undefined）。 */
export function matchTriggerAction(trigger: string): TriggerVocabEntry | undefined {
  return TRIGGER_VOCABULARY.find((entry) => entry.pattern.test(trigger))
}

/** response 段命中词表的可断言终态类别（GWT 派生 Then 形态路由）。 */
export function matchResponseAssertion(response: string): ResponseVocabEntry | undefined {
  return RESPONSE_VOCABULARY.find((entry) => entry.pattern.test(response))
}

// ---------------------------------------------------------------------------
// GWT 派生映射（句式 → Given/When/Then 骨架文本；场景执行由 gwt-runner 承担）
// ---------------------------------------------------------------------------

/** GWT 骨架（§7 实验「GWT 可派生率」的判定单位）。 */
export interface GwtSkeleton {
  given: string
  when: string
  then: string
  /** 句式（WHILE → given 承载状态；IF 标记异常类别） */
  kind: EarsPatternKind
}

/**
 * EARS 断言 → GWT 骨架（纯句式转换，§九验收 2）：
 * - WHEN：Given 默认入口，When = trigger，Then = response；
 * - WHILE：Given = trigger（状态即前置），When = 造一个探针动作（进入该状态所在界面），
 *   Then = response（空态/加载态断言）；
 * - IF：Given 默认入口，When = trigger（非期望输入），Then = response，标记异常类别。
 * 非良构断言（无中轴/缺侧）返回 null——由调用方走 presenceFallback，不硬造场景。
 */
export function deriveGwtSkeleton(assertion: string): GwtSkeleton | null {
  const parsed = parseEarsAssertion(assertion)
  if (!parsed.wellFormed || !parsed.trigger || !parsed.response) return null
  switch (parsed.kind) {
    case 'while':
      return {
        given: parsed.trigger,
        when: '用户进入该界面（触发上述状态的加载/呈现）',
        then: parsed.response,
        kind: 'while',
      }
    case 'if':
      return { given: '用户位于该功能界面', when: parsed.trigger, then: parsed.response, kind: 'if' }
    case 'when':
    default:
      return { given: '用户位于该功能界面', when: parsed.trigger, then: parsed.response, kind: 'when' }
  }
}

// ---------------------------------------------------------------------------
// prompt 用词表渲染（EARS 化 prompt 与校验器共用同一份常量的文本形态）
// ---------------------------------------------------------------------------

/** trigger 词表文本（进 EARS 化 prompt 的「允许触发动词」清单）。 */
export function renderTriggerVocabularyForPrompt(): string {
  return [...new Set(TRIGGER_VOCABULARY.map((entry) => entry.label))].join('、')
}

/** response 词表文本（进 EARS 化 prompt 的「允许效果措辞」清单）。 */
export function renderResponseVocabularyForPrompt(): string {
  return [...new Set(RESPONSE_VOCABULARY.map((entry) => entry.label))].join('、')
}

/** 禁词表文本（进 EARS 化 prompt 的「禁止措辞」清单与内审说明）。 */
export function renderForbiddenTermsForPrompt(): string {
  return RESPONSE_FORBIDDEN_TERMS.join('、')
}
