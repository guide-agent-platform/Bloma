import type { ProjectMode, TemplateType } from '../shared/types'
import { loadProjectTemplate, templateSection, type ProjectTemplate } from './project-templates'
import { backplanePages, type PrdBackplane } from './sketch-engine'

/**
 * TemplateInjection — §6 注入点开关与切片构造（2026-09-02 周计划 §6 P5）。
 *
 * 八注入点（方案 §六接线表）每点独立开关 = §7 三形态实验变量：
 * - ②clarify（澄清框架）/ ③prd（PRD 生成校验+few-shot）/ ⑤sketch / ⑥loop / ⑦gwt
 *   在本模块登记（①在 P2 template_meta、④⑧在 P6 内审/judge 变体，同用 isInjectionEnabled）。
 * 开关形态：环境变量 `BLOMA_INJECT_{POINT}`，值 0/off/false（不区分大小写）关闭，
 * 缺省全开（本周交付的模板体系开箱即用；关闭后行为=现状，§九验收 6）。
 *
 * 纪律（§六）：按消费者切片注入，模板永不整本进上下文、不进对话历史——
 * 每个切片函数只返回该注入点需要的段落文本，null 表示无内容可注入（含开关关闭）。
 */

/** 注入点标识（①④⑧由 P2/P6 消费，此处统一登记开关语义）。 */
export type InjectionPoint = 'template_select' | 'clarify' | 'prd' | 'sketch' | 'loop' | 'gwt' | 'audit' | 'judge'

const INJECTION_ENV_KEYS: Record<InjectionPoint, string> = {
  template_select: 'BLOMA_INJECT_TEMPLATE_SELECT',
  clarify: 'BLOMA_INJECT_CLARIFY',
  prd: 'BLOMA_INJECT_PRD',
  sketch: 'BLOMA_INJECT_SKETCH',
  loop: 'BLOMA_INJECT_LOOP',
  gwt: 'BLOMA_INJECT_GWT',
  audit: 'BLOMA_INJECT_AUDIT',
  judge: 'BLOMA_INJECT_JUDGE',
}

/** 注入点开关：缺省开；环境变量 0/off/false 关闭（实验变量=单点独立关闭）。 */
export function isInjectionEnabled(point: InjectionPoint): boolean {
  const raw = process.env[INJECTION_ENV_KEYS[point]]
  if (!raw) return true
  const value = raw.trim().toLowerCase()
  return value !== '0' && value !== 'off' && value !== 'false'
}

/** 模板加载薄封装：开关关闭直接 null（调用方零分支）。 */
function templateIfEnabled(point: InjectionPoint, type: TemplateType, logContext?: { project_id?: string; session_id?: string }): ProjectTemplate | null {
  if (!isInjectionEnabled(point)) return null
  return loadProjectTemplate(type, logContext)
}

/**
 * 注入点②：澄清框架切片（quick 只问必填章缺口 ≤3；longterm 全章节框架+完备性检查）。
 * 追加于 guide system prompt 末尾；null = 不注入（开关关闭/模板缺失）。
 */
export function buildClarifyInjection(type: TemplateType, mode: ProjectMode): string | null {
  const template = templateIfEnabled('clarify', type)
  if (!template) return null
  const quickGaps = '产品定位 / 功能清单 / 页面清单(≤3) / 行为断言(EARS) / 范围外'
  const quickRule = `快消模式开工前至少明确这五项：${quickGaps}。一次只问当前最关键的缺口（至多 3 问）；用户没说的细节按行业常规默认并在后台记假设，不要追问。`
  const longtermRule = '长期模式按全章节框架澄清：除快消五项外，还需明确目标用户与关键术语；对功能项逐项确认行为断言（触发→效果）可测。'
  return [
    `【项目类型：${template.name}（${template.level === 'loose' ? '宽松' : '标准'}级约束）】`,
    mode === 'quick' ? quickRule : longtermRule,
    `模板测试口径：${templateSection(template, '测试策略').split('\n').slice(0, 2).join('；')}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 注入点③：PRD 生成 few-shot 切片（同类型脱敏样例，硬截断 500 token 配额）。
 * 追加于 PRD 生成 prompt；null = 不注入。
 */
export function buildPrdFewShotInjection(type: TemplateType): string | null {
  const template = templateIfEnabled('prd', type)
  if (!template || !template.sample) return null
  return [`【同类型产品示例（仅参考措辞与粒度，不要照抄内容）】`, template.sample].join('\n')
}

/**
 * 注入点⑤：草图切片（pages 清单 quick/longterm 全量；longterm + 布局惯例）。
 * pages 来自背板（缺省从 requirements 派生，与 backplanePages 兜底同源）。
 */
export function buildSketchInjection(type: TemplateType, mode: ProjectMode, backplane: PrdBackplane): string | null {
  const template = templateIfEnabled('sketch', type)
  if (!template) return null
  const pages = backplanePages(backplane, mode)
  const pageLines = pages.map((page) => `- ${page.name}${page.purpose ? `：${page.purpose}` : ''}`).join('\n')
  const layout = mode === 'longterm' ? templateSection(template, 'tech_skeleton') : ''
  return [
    '【页面清单（按此结构出草图，不要自创页面）】',
    pageLines,
    mode === 'quick' ? '快消模式页面不超过 3 个，单屏聚焦核心流程。' : '',
    layout ? `【布局惯例】\n${layout}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 注入点⑥：MVP loop 切片（tech_skeleton/目录约定/依赖白名单进背板锚定段）。
 * 追加于 buildAgentLoopSystemPrompt 项目锚之后。护栏话术如实描述机制边界（M-9）：
 * 工具层拦截的是 HTML 静态外链（agent-tools externalResourceViolation）；外置模板把
 * 白名单改宽不会同步工具层与 CSP——两者与模板白名单内容无关，不宣称「同源」。
 */
export function buildLoopInjection(type: TemplateType): string | null {
  const template = templateIfEnabled('loop', type)
  if (!template) return null
  const skeleton = templateSection(template, 'tech_skeleton')
  const allowlist = templateSection(template, '依赖白名单')
  return [
    `【工程模板（${template.name}，${template.level === 'loose' ? '宽松' : '标准'}级）】`,
    skeleton ? `技术骨架与目录约定：\n${skeleton}` : '',
    allowlist ? `依赖白名单：\n${allowlist}` : '',
    '沙箱一律禁止外部资源：HTML 中的外部 CDN/第三方脚本/样式引用（含无引号写法）会被写入检查拦截；',
    'JS/CSS 动态加载外网资源会被安全扫描阻断；CSP（script-src self / connect-src none）在预览运行时兑底。',
    '以上机制与模板白名单内容无关——即使模板文本看似允许，也不要引用或加载任何外部资源。',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 注入点⑦：GWT 必测类别（quick=P0 主路径；longterm=+边界/空态/异常）。
 * 消费方：document-engine renderGwtSkeleton（feature 文件头部标注）+ P6 judge。
 */
export function gwtRequiredCategories(mode: ProjectMode, level: 'loose' | 'standard'): string[] {
  if (!isInjectionEnabled('gwt')) return []
  const base = ['主路径(P0)']
  if (mode === 'longterm' || level === 'standard') return [...base, '边界', '空态', '异常']
  return [...base, '边界', '异常']
}
