import { guiControlBindings } from './gui-acceptance-preparation'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import type { PrdBackplane } from '../model/prd-backplane'
import { readPrdBackplane } from '../project/prd-store'
import { isSoftwareProject } from './workflow-policy'
import { readDesktopRequirementsDigest } from './requirement-digest'
import { CORE_DECLARATION_BRIEF, MODEL_VERIFICATION_BRIEF, SPEECH_VERIFICATION_BRIEF } from './core-verification'
import { requirementEvidenceHash, trustedAcceptance, acceptanceAssociationIssues } from '../project/requirement-contract'
import type { DispatchExperiment } from './dispatch-experiment'
import type { RequirementsModel } from '../model/requirements-model'
import { guiStepsSchema, GUI_CHECK_EXAMPLE, SOFTWARE_GUI_ACTION_KINDS } from './gui-tool-contract'
import { GUI_FIXTURE_SCHEMA } from './gui-fixtures'
import { SOFTWARE_DATA_UPDATE_GUIDANCE } from '../software/data-update'
import { SOFTWARE_DELIVERY_GUIDANCE } from '../software/artifact-qualification'

/** Read the authoritative scope on demand; never rewrite or truncate business requirements. */
export function productionContext(backplane: PrdBackplane, topic: string, featureIds: string[] = []): unknown {
  const known = new Set(backplane.requirements.map(item => item.id))
  if (featureIds.some(id => !known.has(id))) throw new Error('PRODUCTION_UNKNOWN_FEATURE')
  const selected = new Set(featureIds.length ? featureIds : known)
  if (topic === 'prd') return { prd_document: backplane.prd_document ?? '', note: '正文与结构化需求冲突时报告，不能自行扩大或削减范围。' }
  if (topic === 'verification') return { protocol: backplane.lean_brief
    ? '用register_gui_check或register_cli_check登记固定输入与任务单预期，宿主操作实际入口。无需另写自报PASS脚本；CORE_CHECK.json只在特殊能力需要时登记llm或speech入口。数据目录使用APP_DATA_DIR。'
    : CORE_DECLARATION_BRIEF }
  if (topic === 'verification-llm') return { protocol: MODEL_VERIFICATION_BRIEF }
  if (topic === 'verification-speech') return { protocol: SPEECH_VERIFICATION_BRIEF }
  if (topic === 'overview') return {
    positioning: backplane.positioning, features: backplane.requirements.map(({ id, description, priority }) => ({ id, description, priority })),
    constraints: backplane.constraints, out_of_scope: backplane.out_of_scope, assumptions: backplane.assumptions,
    ux_files: ['00_UX/confirmed.json', '00_UX/confirmed.html'],
    note: '按职责读取 features；界面职责读取确认UX，环境事实使用 inspect_project_resources。完整PRD和验证协议可按topic读取。',
  }
  if (topic !== 'features') throw new Error('PRODUCTION_UNKNOWN_TOPIC')
  const model = backplane.requirements_model
  return {
    requirements: backplane.requirements.filter(item => selected.has(item.id)).map(item => ({ ...item,
      requirement_hash: requirementEvidenceHash(backplane, item), acceptance: trustedAcceptance(backplane, item) })),
    acceptance_integrity_issues: acceptanceAssociationIssues(backplane), constraints: backplane.constraints, out_of_scope: backplane.out_of_scope, assumptions: backplane.assumptions,
    // Include shared objects and provenance intact. Filter only explicitly linked feature rows.
    requirements_model: model && { ...model,
      workflows: model.workflows.filter(item => item.feature_ids.some(id => selected.has(id))),
      rules: model.rules.filter(item => item.feature_ids.some(id => selected.has(id))),
      scenarios: model.scenarios.filter(item => selected.has(item.feature_id)),
    }, ux: backplane.ux, shape: backplane.shape,
    note: '这是职责阅读视图，未改变全局交付范围。跨功能规则保留完整引用；feature_ids省略时返回全部。',
  }
}

export function buildProductionContextTool(projectId: string): AgentLoopTool {
  return { name: 'read_production_context', parallelSafe: true,
    description: '只读制作交接：overview看范围，features按feature_ids读完整功能/规则/流程/验收（省略编号返回全部），prd读正文，verification读通用验证登记；模型或语音业务分别用verification-llm/verification-speech。按职责读取，避免重复通读。',
    input_schema: { type: 'object', properties: {
      topic: { type: 'string', enum: ['overview', 'features', 'prd', 'verification', 'verification-llm', 'verification-speech', 'verification-gui', 'data-update', 'delivery'] },
      feature_ids: { type: 'array', items: { type: 'string' }, description: 'features主题的功能编号，如F-001；未知编号拒绝，不默默过滤。' },
    }, required: ['topic'] },
    execute: async (input, ctx) => {
      try {
        if (ctx.projectId !== projectId) throw new Error('PRODUCTION_CONTEXT_MISMATCH')
        if (input.topic === 'data-update' && isSoftwareProject(projectId)) return { output: SOFTWARE_DATA_UPDATE_GUIDANCE }
        if (input.topic === 'delivery' && isSoftwareProject(projectId)) return { output: SOFTWARE_DELIVERY_GUIDANCE }
        if (['verification', 'verification-gui'].includes(String(input.topic)) && isSoftwareProject(projectId)) {
          const brief = readPrdBackplane(projectId)
          return { output: JSON.stringify({ protocol: 'GUI登记只需steps和acceptance_refs，宿主绑定已确认目标，不必复述expectations。kind不是action，expect精确预期填equals。restart前后每段都需expect，仅留存任务才需restart。开发观察不等于最终验收。CLI仍用register_cli_check固定args/stdout/exit_code和任务单expectations。',
            gui_step_schema: guiStepsSchema(96, SOFTWARE_GUI_ACTION_KINDS), gui_fixture_schema: GUI_FIXTURE_SCHEMA, example: GUI_CHECK_EXAMPLE,
            authoritative_expectations: Object.fromEntries(brief.requirements.map(row => [row.id, trustedAcceptance(brief, row)])),
            control_bindings: guiControlBindings(projectId), data_directory: 'APP_DATA_DIR' }) }
        }
        if (input.topic === 'verification-llm' && isSoftwareProject(projectId)) return { output: JSON.stringify({ protocol:
          '登记CORE_CHECK.json llm:{runtime:"node",module:"src/llm-client.cjs",factory:"Client",method:"enhance",covers:["模型功能F编号"]}。Node模块须是产品实际使用的入口，导出可无参new的类；method异步接收{prompt,config:{endpoint,model,api_key,provider,timeout}}，返回{ok,kind,text/message}，kind为success/auth_error/model_error/rate_limited/invalid_response/unconfigured。宿主调用真实客户端验证本机HTTP请求及5类异常，不请求付费端点。Python入口沿用module/factory/method协议（不填runtime）。不能登记只为探针伪造的替身；外部质量另列待实测。' }) }
        if (input.topic === 'verification-gui') return { output: JSON.stringify({ control_bindings: guiControlBindings(projectId), note: '实现需保留这些已确认控件身份，固定业务期望由宿主管理。' }) }
        if (input.feature_ids !== undefined && (!Array.isArray(input.feature_ids) || input.feature_ids.some(id => typeof id !== 'string'))) throw new Error('PRODUCTION_INVALID_FEATURES')
        return { output: JSON.stringify(productionContext(readPrdBackplane(projectId), String(input.topic), input.feature_ids as string[] | undefined)) }
      } catch (error) { return { isError: true, output: error instanceof Error ? error.message : String(error) } }
    } }
}

/** Keep all structured obligations in the system; read duplicate prose through the context tool. */
export function readProductionDigest(projectId: string): string | undefined {
  return readDesktopRequirementsDigest(projectId, { includePrdDocument: false })
}

/** Inline business obligations once; bulky source/coverage provenance remains in the read-only tool. */
export function inlineProductionContext(backplane: PrdBackplane, ids: string[]): unknown {
  const view = productionContext(backplane, 'features', ids) as Record<string, unknown> & { requirements_model?: RequirementsModel }
  const model = view.requirements_model
  if (!model) return view
  const { sources: _sources, coverage: _coverage, ...business } = model
  return { ...view, requirements_model: business, provenance: '来源原文与完整coverage可通过read_production_context(topic=features)追溯；需求哈希依据完整权威模型计算。' }
}

export function scopedProductionDigest(projectId: string, config: DispatchExperiment | undefined, childSessionId: string, fallback?: string): string | undefined {
  const worker = config && Object.values(config.workers).find(item => item.child_session_id === childSessionId)
  const tasks = worker && config!.tasks.filter(task => worker.task_ids.includes(task.id))
  // Unannotated work retains the complete structured scope; never guess ownership from prose.
  if (!tasks?.length || tasks.some(task => !task.feature_ids?.length)) return fallback
  const ids = [...new Set(tasks.flatMap(task => task.feature_ids!))]
  const backplane = readPrdBackplane(projectId)
  return '【本次职责的完整需求与共享约束】\n' + JSON.stringify(inlineProductionContext(backplane, ids))
    + '\n其他功能仍属全局交付范围，完整项目概览和正文可用read_production_context查询。'
}
