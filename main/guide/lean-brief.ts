import { createHash } from 'node:crypto'
import type { PrdBackplane, SketchRequirement } from '../model/prd-backplane'
import { bindAcceptance } from '../project/requirement-contract'

const texts = (value: unknown): string[] => Array.isArray(value) && value.every(x => typeof x === 'string' && x.trim()) ? value : []
const object = (x: unknown): x is Record<string, unknown> => Boolean(x && typeof x === 'object' && !Array.isArray(x))

export const LEAN_BRIEF_PROMPT = `把用户目标整理为可执行的短任务单。只问真正阻塞成品方向的疑问，不问内部技术选择，不凑问题或功能数量，不自动增加删除、账号、联网等功能。
原话与材料完整保留，历史仅作参考，最新明确意见优先；旧功能不得悄悄丢弃。保留既有F编号，新增能力不挤占旧编号。每项必需能力写一个可观察结果，不展开对象、规则、流程或三类状态图谱。未知关键条件只输出 {"action":"clarify","question":"关键问题","options":["选项"]}。
“先给我看草图、确认后开工”属于制作流程，保留在原话，不列为成品功能；成品本身需要的画图或审批功能仍须保留。
目标明确输出 {"action":"brief","name":"简短项目名","goal":"目标","ui":"required|none","requirements":[{"id":"已有F编号或省略","description":"必需能力","expected":"实际应看到什么"}],"constraints":[],"out_of_scope":[],"assumptions":[]}。不另写PRD正文、审计报告或实现代码。只输出JSON。`

export function parseLeanBrief(raw: string, context: { projectId: string; sessionId: string; source: string; previous: PrdBackplane; software?: boolean }):
  { action: 'clarify'; question: string; options: string[] } | { action: 'brief'; brief: PrdBackplane } | undefined {
  let value: unknown
  try { value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) } catch { return }
  if (!object(value)) return
  if (value.action === 'clarify' && typeof value.question === 'string' && value.question.trim()) {
    return { action: 'clarify', question: value.question, options: texts(value.options) }
  }
  if (value.action !== 'brief' || typeof value.goal !== 'string' || !value.goal.trim() || !['required', 'none'].includes(String(value.ui))
    || !Array.isArray(value.requirements) || !value.requirements.length) return
  const delivery = value.delivery ?? context.previous.lean_brief?.delivery ?? (value.ui === 'none' ? 'command' : 'desktop')
  const distribution = value.distribution ?? context.previous.lean_brief?.distribution
  if (context.software && distribution !== undefined && !['local', 'portable', 'installer', 'source'].includes(String(distribution))) return
  if (context.software && (!['desktop', 'browser', 'command'].includes(String(delivery)) || value.ui === 'none' && delivery !== 'command' || value.ui === 'required' && delivery === 'command')) return
  let next = Math.max(0, ...context.previous.requirements.map(row => Number(/^F-(\d+)$/.exec(row.id)?.[1] ?? 0))) + 1
  const used = new Set<string>(), requirements: SketchRequirement[] = [], acceptance: Record<string, string> = {}
  for (const row of value.requirements) {
    if (!object(row) || typeof row.description !== 'string' || !row.description.trim() || typeof row.expected !== 'string' || !row.expected.trim()) return
    const prior = context.previous.requirements.find(old => old.id === row.id || old.description === row.description)
    const id = prior?.id ?? `F-${String(next++).padStart(3, '0')}`
    if (used.has(id)) return
    used.add(id)
    requirements.push({ id, description: row.description, priority: 'P0', behavior_assertions: [row.expected] })
    acceptance[id] = row.expected
  }
  return { action: 'brief', brief: bindAcceptance({ project_id: context.projectId,
    name: typeof value.name === 'string' && value.name.trim() ? value.name : context.previous.name,
    positioning: value.goal, requirements, acceptance, constraints: texts(value.constraints), out_of_scope: texts(value.out_of_scope), assumptions: texts(value.assumptions),
    lean_brief: { version: 1, ui: value.ui as 'required' | 'none', source_session_id: context.sessionId,
      ...(context.software ? { delivery: delivery as 'desktop' | 'browser' | 'command' } : {}),
      ...(context.software && distribution !== undefined ? { distribution: distribution as 'local' | 'portable' | 'installer' | 'source' } : {}),
      source_sha256: createHash('sha256').update(context.source).digest('hex') } }) }
}

export function renderLeanBrief(brief: PrdBackplane): string {
  return [brief.positioning, ...brief.requirements.map(row => `${row.id} ${row.description}\n完成应看到：${brief.acceptance[row.id] ?? ''}`),
    ...(brief.lean_brief?.delivery ? ['使用方式：' + ({ desktop: '桌面软件，一键启动', browser: '在本机浏览器使用', command: '命令工具' }[brief.lean_brief.delivery])] : []),
    ...(brief.lean_brief?.distribution ? ['交付方式：' + ({ local: '在本机直接使用', portable: '可复制到其他电脑直接使用', installer: '可在其他电脑安装使用', source: '移交源码' }[brief.lean_brief.distribution])] : []),
    ...(brief.lean_brief?.preview === 'reuse' ? ['界面沿用已确认外观，在制作时按新增功能调整。'] : []),
    ...(brief.lean_brief?.preview === 'skip' ? ['按你的授权直接制作，不再生成草图。'] : []),
    ...(brief.constraints?.length ? ['约束：' + brief.constraints.join('；')] : []),
    ...(brief.out_of_scope.length ? ['不做：' + brief.out_of_scope.join('；')] : []),
    ...(brief.assumptions.length ? ['假设：' + brief.assumptions.join('；')] : [])].join('\n\n')
}
