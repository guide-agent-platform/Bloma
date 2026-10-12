import { existsSync, readFileSync } from 'node:fs'
import { getAgentSessionPath } from '../../storage/config-paths'
import type { RequirementSource } from '../model/requirements-model'

/** Read complete user turns (including multiline requests); assistant assertions are not user evidence. */
export function readRequirementSources(sessionId: string): RequirementSource[] {
  const path = getAgentSessionPath(sessionId)
  if (!existsSync(path)) return []
  const sources: RequirementSource[] = []
  const seen = new Set<string>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let message: { role?: string; content?: unknown }
    try { message = JSON.parse(line) } catch { continue }
    if (message.role !== 'user') continue
    const content = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
      ? message.content.flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n') : ''
    // Control choices are decisions, not capabilities. Meaningful clarification answers remain sources.
    if (/^(?:确认无误|确认|继续|开始吧|你帮我决定|随便|全部交给向导决定|好的|可以)[。！!\s]*$/.test(content.trim())) continue
    for (const paragraph of content.split(/\r?\n+/)) {
      const value = paragraph.trim()
      if (!value || seen.has(value)) continue
      seen.add(value)
      sources.push({ id: `S-${String(sources.length + 1).padStart(3, '0')}`, text: value })
    }
  }
  return sources
}

/** Output contract replaces the old frozen-theme protocol even when a local prompt override exists. */
export const ORGANIZED_PRD_SYSTEM_PROMPT = `你是 Bloma 的需求分析师。把用户的目标整理为一份可实施、可验收的结构化需求模型。只输出一个 JSON 对象。
原话、目标、功能是不同层次。候选功能尚未冻结，可拆分/合并；不把整段原话或“你帮我决定”变成 F-001。功能数量由独立业务边界决定，没有 3~5 项上限，也不按按钮机械拆分。
输出顶层 name、positioning、form、requirements、requirements_model、out_of_scope、assumptions，并按实际产品输出 ux、shape、gdd 等已有补充契约。
requirements:[{id:"F-001",description:"独立能力",story:"用户为什么需要它",priority:"P0|P1|P2",origin:"user|guide"}]。描述说清能力，不复制全文；不丢用户指定的实现/运行约束。首次编号从 F-001 顺序递增；重整已有结构化模型时沿用已有同义功能编号，新增取最大编号+1，不能将旧编号分配给另一件事。
requirements_model:{
 version:1, goal:"谁在什么场景下解决什么问题", target_users:["目标用户"],
 entities:[{id:"O-001",name:"业务对象",description:"含义与生命周期",attributes:["重要属性"]}],
 relations:[{from:"O-001",to:"O-002",description:"关系与归属"}],
 workflows:[{id:"W-001",name:"完整用户任务",steps:["从开始到成功的操作步骤"],feature_ids:["F-001"]}],
 rules:[{id:"BR-001",statement:"业务上必须成立的事实",feature_ids:["F-001"],source_ids:["S-001"],origin:"user|assumption"}],
 scenarios:[{id:"AC-001",feature_id:"F-001",kind:"normal|boundary|exception",given:"具体前提或输入",when:"用户操作",then:"可观察且可判定的结果",rule_ids:["BR-001"]}],
 coverage:[{source_id:"S-001",feature_ids:["F-001"],rule_ids:["BR-001"],disposition:"included|context|out_of_scope|superseded",reason:"如何采纳或为什么不纳入"}],
 open_questions:["无法由原话或合理默认决定的关键业务问题"]
}
不要输出 sources；平台提供不可篡改的 S 编号来源。coverage 必须逐条处理全部来源；背景可标 context、后续原话明确替代旧要求可标 superseded 并说明依据，不得以背景名义隐藏真实功能/数值/异常要求。材料来源仍用 source_refs 的原契约。
每个功能至少进入一条流程。每条业务规则列出它约束的所有功能，例如用量守恒同时约束计算、保存、导入；每个关联功能至少有一个非豁免场景检验该规则。用户明说的规则引用 S 来源；合理补充的规则标 assumption，不能冒充用户要求，并在 assumptions 中披露。
每个功能必须有 normal、boundary、exception 三类场景。正常路径不能豁免；其他确实不适用时省略 GWT，改填 not_applicable:"至少20字的具体理由"，rule_ids=[]。不要固定造三个相同场景，不用“正常工作/不崩溃”代替可观察结果。
对象和独立规则按产品实际需要表达，简单无状态工具可用空 entities/relations/rules，但仍要说清操作流程与验收。复杂任务必须表达对象归属、历史/状态变化、数值不变量及异常副作用。
不编造用户没说过的硬约束。用户让渡时选择合理默认并公开假设，不重复追问已回答事项；不能用默认省略用户已明确的功能。确实无法可靠决定时保留 open_questions，平台会在确认前处理。
不用另写 document 或 acceptance：正式正文与验收兼容视图由平台从本模型生成。这样用户与工程/验收看到同一套规则和编号。
shape 保留既有产品形态契约：host_template、modules、primary_loop、fact_source、needs_resident、needs_network、task_duration、destructive_ops、llm_role、job_policy、candidates、architecture_open_questions；按真实工作方式判断，不因功能少而假定无持久化。
ux 保留 states=[{id,observable}]、feedback_rules。游戏才输出 gdd={core_fantasy,pillars,core_loop,numbers}。用户给定产品名优先沿用。
本输出协议优先于风格补充中的旧版“冻结功能/主题锚点/输出document”要求。`
