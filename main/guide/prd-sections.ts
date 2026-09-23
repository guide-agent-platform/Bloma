/**
 * PRD 章节 schema 与必填矩阵（2026-09-02 周计划 §5 P1；方案 §5.1）。
 *
 * 一份章节定义 = {id, 必填矩阵（模式×硬约束等级）, 数据源, 消费者清单}，带版本字段。
 * 章节是**背板字段的视图映射**，不是新存储层——背板（sketch-engine.ts PrdBackplane）
 * 是唯一真相源，本模块只定义「哪些章节、何时必填、数据从哪来、谁消费」，
 * 防 Kiro 三件套式独立文档结构引入双真相源（纪律第 3 条）。
 *
 * 必填矩阵展开 PRD 12.4（方案 §二）：
 * - 宽松（personal_tool）：定位/功能/页面/GWT/范围外五必填（quick 基底）；
 * - 标准（web_fullstack/desktop_tool）：+ 目标用户（personas）+ 验收标准（assertions
 *   完备性升级）+ API Spec（interface_spec）；
 * - 严格：+ 用户故事/竞品分析（二期，不做，类型保留）。
 *
 * 调研对照（research/P1-章节schema与EARS词表-借鉴笔记.md）：
 * - Spec Kit 的 NEEDS CLARIFICATION 上限 3 + 按 impact 排序 → 澄清问题框架（注入点②）；
 * - OpenSpec「不许为满足校验编造需求」→ 完备性检查只标记 missing，不要求 LLM 编内容；
 * - 12.4 的「项目名称」= name（已有字段，不设章节）、「核心功能」= requirements。
 */

import type { PrdBackplane, PrdSectionId } from '../coding/sketch-engine'
import { requirementPriority } from '../coding/sketch-engine'
import type { ConstraintLevel, ProjectMode } from '../../shared/types'

/** 章节 schema 版本（结构变更时 +1；§6 注入点⑧ judge 轻量版本一致性校验消费）。 */
export const PRD_SECTIONS_SCHEMA_VERSION = 1

/** 章节数据源类别（方案 §5.1：背板字段 | LLM | 用户输入 | 派生）。 */
export type PrdSectionSource = 'backplane' | 'llm' | 'user_input' | 'derived'

export interface PrdSectionDef {
  id: PrdSectionId
  /** 中文标题（PRD 过目卡/文档渲染共用） */
  label: string
  /** quick 模式必填（模板等级另查 sectionRequiredFor；此字段=quick×该模板缺省等级） */
  quickRequired: boolean
  /** longterm 模式必填 */
  longtermRequired: boolean
  /** 数据源类别 */
  source: PrdSectionSource
  /** 背板字段说明（数据源=backplane 时；derived 说明派生链） */
  dataFrom: string
  /** 消费者清单（= §6 注入点；模板永不整本进上下文，按此切片） */
  consumers: string[]
  /** 仅指定等级起必填（undefined=不分等级）；如 interface_spec 标准级起 */
  requiredFromLevel?: ConstraintLevel
}

/**
 * 章节定义全集（顺序即 PRD 呈现顺序）。
 * gwt 为 derived 章节：数据源 = assertions 经 ears-vocabulary.deriveGwtSkeleton 派生，
 * 完备性判定 = P0 项派生场景数达标（见 checkSectionCompleteness）。
 */
export const PRD_SECTIONS: PrdSectionDef[] = [
  {
    id: 'positioning',
    label: '产品定位',
    quickRequired: true,
    longtermRequired: true,
    source: 'backplane',
    dataFrom: 'positioning（F-001 主题锚点 / LLM 提炼）',
    consumers: ['PRD 过目卡', 'MVP loop 背板锚定段', '草图 prompt'],
  },
  {
    id: 'prd_document',
    label: 'PRD 全文（长文本）',
    // 2026-09-03 形态切换第一步（需求工程链归向导）：先落字段与消费链路（过目卡主展示
    // + loop 锚定常驻），暂不进必填矩阵——升格必填待线上验证后拍板，避免旧项目误标 missing
    quickRequired: false,
    longtermRequired: false,
    source: 'llm',
    dataFrom: 'prd_document（向导工程腿与结构化字段同调用产出；降级走 buildPrdDocumentFallback 机械拼装）',
    consumers: ['PRD 过目卡（主展示对象）', 'MVP loop 背板锚定段'],
  },
  {
    id: 'requirements',
    label: '功能清单',
    quickRequired: true,
    longtermRequired: true,
    source: 'backplane',
    dataFrom: 'requirements[]（澄清冻结，F-001 主题锚点不变式）',
    consumers: ['全部下游（唯一需求事实源）'],
  },
  {
    id: 'pages',
    label: '页面清单',
    quickRequired: true,
    longtermRequired: true,
    source: 'backplane',
    dataFrom: 'pages[]（quick ≤3；缺省从 requirements 前 3 项派生）',
    consumers: ['草图引擎（升格 max_pages）', '注入点⑤ sketch prompt'],
  },
  {
    id: 'assertions',
    label: '行为断言（EARS）',
    quickRequired: true,
    longtermRequired: true,
    source: 'backplane',
    dataFrom: 'requirements[].behavior_assertions（P0 必测；EARS 化升级句式）',
    consumers: ['GWT 派生', 'judge 门禁', '注入点④内审 EARS 可测性'],
  },
  {
    id: 'gwt',
    label: 'GWT 验收场景',
    quickRequired: true,
    longtermRequired: true,
    source: 'derived',
    dataFrom: 'assertions 经 ears-vocabulary deriveGwtSkeleton 纯句式派生（不落盘）',
    consumers: ['gwt-runner 行为探针', 'test-report', '注入点⑦'],
  },
  {
    id: 'out_of_scope',
    label: '范围外',
    quickRequired: true,
    longtermRequired: true,
    source: 'backplane',
    dataFrom: 'out_of_scope[]（用户拒绝项 + normalizer 判定；可为空数组但章节必须存在）',
    consumers: ['MVP loop 防扩功能', '内审 G 维'],
  },
  {
    id: 'constraints',
    label: '用户约束',
    // 不进必填矩阵（机器契约可选）：document 渲染时恒有「用户约束」节（可空写「无特殊约束」）；
    // constraints 背板字段可选，旧背板可能缺失——标 missing 会误伤存量项目。
    quickRequired: false,
    longtermRequired: false,
    source: 'backplane',
    dataFrom: 'constraints[]（T4-L1 用户声明约束：不含登录/必须离线等；可为空数组）',
    consumers: ['MVP loop 防扩功能', 'PRD 过目卡'],
  },
  {
    id: 'assumptions',
    label: '后台假设',
    // 同上：document 章节（可空），不进机器必填矩阵。
    quickRequired: false,
    longtermRequired: false,
    source: 'backplane',
    dataFrom: 'assumptions[]（后台技术/产品决策：单位/存储/排序/默认值；可为空数组）',
    consumers: ['decisions 回溯', 'PRD 过目卡'],
  },
  {
    id: 'personas',
    label: '目标用户',
    quickRequired: false,
    longtermRequired: true,
    source: 'backplane',
    dataFrom: 'personas[]（12.4 标准级「目标用户」行）',
    consumers: ['PRD 过目卡', 'GWT 场景分布'],
  },
  {
    id: 'glossary',
    label: '术语表',
    quickRequired: false,
    longtermRequired: true,
    source: 'llm',
    dataFrom: 'glossary[]（LLM 提取 + 纠错回流）',
    consumers: ['全 prompt 注入点统一术语'],
  },
  {
    id: 'data_model',
    label: '数据模型',
    quickRequired: false,
    longtermRequired: false,
    source: 'llm',
    dataFrom: 'data_model（选填；涉及持久化数据时激活）',
    consumers: ['MVP loop', 'judge 对照'],
  },
  {
    id: 'interface_spec',
    label: 'API Spec',
    quickRequired: false,
    longtermRequired: true,
    source: 'llm',
    dataFrom: 'interface_spec[]（12.4 标准级起；按需输出：有数据留存/后端/AI 能用时逐端点列出）',
    consumers: ['MVP loop', 'judge 对照'],
    requiredFromLevel: 'standard',
  },
  {
    id: 'gdd',
    label: '设计文档（GDD）',
    // P1-7（2026-09-04）：game 类型的玩法真相源，不进必填矩阵（非 game 不生成；
    // game 缺 GDD 由生成侧降级，不标 missing——对齐 prd_document 的「暂不进必填」口径）。
    quickRequired: false,
    longtermRequired: false,
    source: 'llm',
    dataFrom: 'gdd（game 类型玩法真相源：核心幻想/支柱/核心循环/数值基准）',
    consumers: ['PRD 生成（从 GDD 切片）', 'loop 背板锚定段'],
  },
]

/** 章节 id → 定义（完备性检查/prompt 渲染共用）。 */
export const PRD_SECTION_BY_ID: ReadonlyMap<PrdSectionId, PrdSectionDef> = new Map(
  PRD_SECTIONS.map((section) => [section.id, section]),
)

/**
 * 每章节在 prd_document 长文本里的填充指令（P2-10，2026-09-04）：
 * document 章节由 schema 驱动——章节标题/顺序/填充要求单一来源，不再硬编码「八节」。
 * 空章节写「无/待确定」不编内容（OpenSpec 纪律）。
 */
export const DOCUMENT_SECTION_INSTRUCTIONS: Record<PrdSectionId, string> = {
  positioning: '三要素（给谁用/什么场景/解决什么）+ 为什么做这件事（对话中用户表达的动机）',
  prd_document: '', // 全文本身，不参与章节渲染
  requirements: '逐功能项一段「作为<角色>，我想<功能>，以便<价值>」，并逐项给编号、优先级（P0/P1/P2）、验收要点（与 acceptance 逐字同源）',
  pages: '对话能推出的界面形态与交互方式；推不出就写「待草图阶段确定」，不要编',
  assertions: '逐功能项列出行为断言（EARS 形态，可执行可断言）',
  gwt: '从行为断言派生的验收场景；无行为断言则写「由 P0 行为断言派生」',
  out_of_scope: '与 out_of_scope 逐字同源；为空时写「本轮无明确排除项」',
  constraints: '用户说过的「必须/不要」类要求与性能/隐私类诉求；无则写「无特殊约束」',
  assumptions: '与 assumptions 逐字同源；为空时写「无」',
  personas: '从对话提炼目标用户；对话没说清的按常见合理预期补一句并保持克制',
  glossary: '对话中关键术语及定义；无则写「无」',
  data_model: '涉及持久化数据时列出实体与关系；无则写「本轮无持久化数据」',
  interface_spec: '端点定义（描述目标产品契约，不描述草图能力限制；确无外部接口的纯展示产物写「无外部接口」）',
  gdd: '游戏设计文档四要素：核心幻想 / 设计支柱 / 核心循环 / 数值基准（仅 game 类型输出）',
}

/** 中文数字序号（章节标题「一、二、…十三」用；超出范围回退阿拉伯数字）。 */
const CN_NUMBERS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十']
function toChineseNumber(n: number): string {
  return CN_NUMBERS[n] ?? String(n)
}

/**
 * 渲染 prd_document 的章节骨架（P2-10）：按 PRD_SECTIONS 顺序、跳过 prd_document 自身，
 * 每章输出「## N、label —— 填充指令」。prd-engine-llm 的 system prompt 用它拼装，
 * 章节与 schema 严格同源（加章节自动同步，不再硬编码八节）。
 */
export function renderDocumentSectionSpec(): string {
  return PRD_SECTIONS
    .filter((section) => section.id !== 'prd_document')
    .map((section, index) => `## ${toChineseNumber(index + 1)}、${section.label} —— ${DOCUMENT_SECTION_INSTRUCTIONS[section.id]}`)
    .join('\n')
}

/** 等级序（loose < standard < strict；requiredFromLevel 判定用）。 */
const LEVEL_ORDER: Record<ConstraintLevel, number> = { loose: 0, standard: 1, strict: 2 }

/**
 * 指定模式×等级下的必填章节集（模板「PRD 章节必填子集」的程序形态；
 * quick×loose = 五必填，longterm×standard = +personas/glossary/interface_spec）。
 */
export function requiredSections(mode: ProjectMode, level: ConstraintLevel): PrdSectionDef[] {
  return PRD_SECTIONS.filter((section) => {
    const modeRequired = mode === 'quick' ? section.quickRequired : section.longtermRequired
    if (!modeRequired) return false
    if (!section.requiredFromLevel) return true
    return LEVEL_ORDER[level] >= LEVEL_ORDER[section.requiredFromLevel]
  })
}

/** 章节完备性检查结果：missing = 必填章节数据缺失（只标记，不要求编内容填充）。 */
export interface SectionCompleteness {
  missing: Array<{ section: PrdSectionDef; reason: string }>
  present: PrdSectionId[]
  /** 参与检查的模式×等级（决策日志/内审卡面如实呈现） */
  mode: ProjectMode
  level: ConstraintLevel
}

/**
 * 章节完备性检查（注入点②③④消费：澄清问题框架 / PRD 生成校验 / 内审检查表追加）。
 *
 * 判定口径（OpenSpec「不许编造」纪律：missing 只标记，绝不让 LLM 填充凑数）：
 * - positioning：非空字符串；
 * - requirements：≥1 项；
 * - pages：backplanePages 非空（缺省派生路径保证 quick 恒可满足，除非 requirements 也空）；
 * - assertions：每个 P0 项 requirementAssertions 非默认兜底（EARS 化目标态）；宽松级
 *   放宽为「至少一个 P0 项有真实断言」——quick 现状（enricher 可选）兼容；
 * - gwt：assertions 派生可达（有 ≥1 条可派生断言即视为章节成立；逐场景覆盖在 §7 实验度量）；
 * - out_of_scope：字段存在（可为空数组——「用户没拒绝任何东西」是合法事实）；
 * - personas/glossary：非空数组；
 * - interface_spec：字段存在（可为空数组——仅当目标产品确无外部接口时合法，不以草图为由豁免）。
 */
export function checkSectionCompleteness(
  backplane: PrdBackplane,
  mode: ProjectMode,
  level: ConstraintLevel,
): SectionCompleteness {
  const missing: Array<{ section: PrdSectionDef; reason: string }> = []
  const present: PrdSectionId[] = []
  const required = requiredSections(mode, level)

  const mark = (id: PrdSectionId, ok: boolean, reason: string): void => {
    const section = PRD_SECTION_BY_ID.get(id)
    if (!section) return
    if (ok) present.push(id)
    else missing.push({ section, reason })
  }

  for (const section of required) {
    switch (section.id) {
      case 'positioning':
        mark('positioning', backplane.positioning.trim().length > 0, '产品定位为空')
        break
      case 'requirements':
        mark('requirements', backplane.requirements.length > 0, '功能清单为空')
        break
      case 'pages': {
        const pages = backplane.pages ?? []
        const derived = pages.length === 0 && backplane.requirements.length > 0
        mark('pages', pages.length > 0 || derived, '页面清单为空且无功能项可派生')
        break
      }
      case 'assertions': {
        const p0Items = backplane.requirements.filter((item) => requirementPriority(item) === 'P0')
        const hasAssertion = (item: (typeof backplane.requirements)[number]): boolean =>
          (item.behavior_assertions ?? []).some((value) => value.trim().length > 0)
        const ok =
          level === 'loose'
            ? p0Items.some(hasAssertion)
            : p0Items.length > 0 && p0Items.every(hasAssertion)
        mark('assertions', ok, level === 'loose' ? '没有任何 P0 项带行为断言' : '存在 P0 项缺行为断言')
        break
      }
      case 'gwt': {
        // derived 章节：有任一断言（含默认兜底断言）即可派生 ≥1 场景；逐场景率是 §7 指标不是章节门槛
        const anyAssertion = backplane.requirements.some((item) =>
          (item.behavior_assertions ?? []).some((value) => value.trim().length > 0),
        )
        mark('gwt', anyAssertion || backplane.requirements.length > 0, '无可派生 GWT 场景的功能项')
        break
      }
      case 'out_of_scope':
        mark('out_of_scope', Array.isArray(backplane.out_of_scope), '范围外字段缺失')
        break
      case 'personas':
        mark('personas', (backplane.personas ?? []).length > 0, '目标用户为空')
        break
      case 'glossary':
        mark('glossary', (backplane.glossary ?? []).length > 0, '术语表为空')
        break
      case 'interface_spec':
        mark('interface_spec', Array.isArray(backplane.interface_spec), 'API Spec 字段缺失')
        break
      case 'constraints':
        mark('constraints', Array.isArray(backplane.constraints), '用户约束字段缺失')
        break
      case 'assumptions':
        mark('assumptions', Array.isArray(backplane.assumptions), '后台假设字段缺失')
        break
      case 'data_model':
        // 选填章节不进 missing（requiredSections 已过滤，此处仅为穷尽性保护）
        present.push('data_model')
        break
      case 'gdd':
        // 选填章节（game 类型专属）不进 missing——game 缺 GDD 由生成侧降级，不标 missing
        present.push('gdd')
        break
    }
  }
  return { missing, present, mode, level }
}

/**
 * 澄清缺口章节 → 澄清问题框架提示（注入点②）：
 * 必填章节 missing 时按 Spec Kit NEEDS CLARIFICATION 纪律（上限 3 问、按影响排序）
 * 构造「只问缺口」的框架文本；无缺口返回 null（澄清链不再为已完备章节发问）。
 */
export function clarifyGapSections(mode: ProjectMode, level: ConstraintLevel, completeness: SectionCompleteness): string[] {
  if (completeness.missing.length === 0) return []
  return completeness.missing.slice(0, 3).map((entry) => `${entry.section.label}：${entry.reason}`)
}
