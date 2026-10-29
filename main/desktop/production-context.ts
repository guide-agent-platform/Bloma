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
import { softwareResumeContext } from '../software/run-state'
import { SOFTWARE_LAUNCH_GUIDANCE } from './launch-smoke'
import { readIndependentDesign, readIndependentPolicy } from '../software/independent-design'
import { readLongtermState, isLongtermSoftware } from '../software/longterm-state'
import { SOFTWARE_CONTEXT_CATALOG } from '../software/context-catalog'
import { softwareWorkingContext } from '../software/working-context'
import { DOCUMENT_GUIDANCE } from '../software/document-capability'
import { COUNTEREXAMPLE_GUIDANCE } from '../software/acceptance-counterexamples'
import { MULTIMODAL_GUIDANCE, HTTP_GUIDANCE, VISION_GUIDANCE, AI_SERVICE_GUIDANCE, PRODUCT_COMPONENT_RECIPES } from '../software/integration-capabilities'
import {softwareDiagnosticContext} from '../software/diagnostic-context'

/** Read the authoritative scope on demand; never rewrite or truncate business requirements. */
export function productionContext(backplane: PrdBackplane, topic: string, featureIds: string[] = []): unknown {
  const known = new Set(backplane.requirements.map(item => item.id))
  if (featureIds.some(id => !known.has(id))) throw new Error('PRODUCTION_UNKNOWN_FEATURE')
  const selected = new Set(featureIds.length ? featureIds : known)
  if (topic === 'launch') return { protocol: SOFTWARE_LAUNCH_GUIDANCE }
  if (topic === 'prd') return { prd_document: backplane.prd_document ?? '', note: '正文与结构化需求冲突时报告，不能自行扩大或削减范围。' }
  if (topic === 'verification') return { protocol: backplane.lean_brief
    ? '用register_gui_check或register_cli_check登记固定输入与任务单预期，宿主操作实际入口。无需另写自报PASS脚本；CORE_CHECK.json只在特殊能力需要时登记llm或speech入口。数据目录使用APP_DATA_DIR。'
    : CORE_DECLARATION_BRIEF }
  if (topic === 'verification-llm') return { protocol: MODEL_VERIFICATION_BRIEF }
  if (topic === 'verification-speech') return { protocol: SPEECH_VERIFICATION_BRIEF }
  if (topic === 'overview') return {
    positioning: backplane.positioning, features: backplane.requirements.map(({ id, description, priority }) => ({ id, description, priority })),
    ...(backplane.lean_brief ? { delivery: backplane.lean_brief.delivery, distribution: backplane.lean_brief.distribution, ui: backplane.lean_brief.ui } : {}),
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
    description: '只读按需上下文：components看可复用组合，ai-service看通用AI模板与Key/路由；diagnostics汇总故障现场。capabilities列目录；documents/vision/multimodal/http-integration看能力；existing-project/working-state看工程与现场，features看范围，verification-gui/llm/speech看验收协议。',
    input_schema: { type: 'object', properties: {
      topic: { type: 'string', enum: ['capabilities','components','ai-service','diagnostics','execution','working-state','documents','multimodal','vision','http-integration','acceptance-counterexamples','existing-project','overview', 'features', 'prd', 'launch', 'verification', 'verification-llm', 'verification-speech', 'verification-gui', 'data-update', 'delivery', 'resume', 'independent-design', 'longterm'] },
      feature_ids: { type: 'array', items: { type: 'string' }, description: 'features主题的功能编号，如F-001；未知编号拒绝，不默默过滤。' },
    }, required: ['topic'] },
    execute: async (input, ctx) => {
      try {
        if (ctx.projectId !== projectId) throw Error('PRODUCTION_CONTEXT_PROJECT_MISMATCH')
        if (isSoftwareProject(projectId) && input.topic === 'capabilities') return { output: JSON.stringify({ catalog: SOFTWARE_CONTEXT_CATALOG, note: '目录不代表本轮需求或环境已就绪；按topic读取需要的说明，不扩大目标。' }) }
        if(isSoftwareProject(projectId)&&input.topic==='components')return{output:JSON.stringify(PRODUCT_COMPONENT_RECIPES)}
        if(isSoftwareProject(projectId)&&input.topic==='ai-service')return{output:JSON.stringify(AI_SERVICE_GUIDANCE)}
        if(isSoftwareProject(projectId)&&input.topic==='diagnostics')return{output:JSON.stringify(softwareDiagnosticContext(projectId,ctx.sessionId))}
        if (isSoftwareProject(projectId) && input.topic === 'documents') return { output: JSON.stringify(DOCUMENT_GUIDANCE) }
        if (isSoftwareProject(projectId) && input.topic === 'multimodal') return { output: JSON.stringify(MULTIMODAL_GUIDANCE) }
        if (isSoftwareProject(projectId) && input.topic === 'vision') return { output: JSON.stringify(VISION_GUIDANCE) }
        if (isSoftwareProject(projectId) && input.topic === 'http-integration') return { output: JSON.stringify(HTTP_GUIDANCE) }
        if (isSoftwareProject(projectId) && input.topic === 'acceptance-counterexamples') return { output: JSON.stringify(COUNTEREXAMPLE_GUIDANCE) }
        if (isSoftwareProject(projectId) && input.topic === 'existing-project') return { output: JSON.stringify({
          inspect: 'inspect_repository({mode:"overview"})定位原脚本/锁文件/测试；file/search按需定位；changes对比导入时实际字节和当前副本，原用户脏修改已包含在导入基线，不算本轮新增。',
          baseline: '先用原项目命令实际运行原测试，保留退出码与失败事实；修改后分别运行原测试和新增案例，已有失败不能默认为本轮引入，也不能忽略新失败。检查实际用户入口与数据兼容。',
          boundary: '原目录只读，工作在副本；不自动写回、push或删除原测试。差异清单不是行为验证，未导入项目不能捏造原工程基线。' }) }
        if (isSoftwareProject(projectId) && input.topic === 'execution') return { output: JSON.stringify({
          run: '短命令可同步；安装/构建/测试可run_command({command:[...],yield_ms:1000,timeout_ms:300000})。process_id表示同一命令继续运行，不应重复启动。',
          read: 'read_process({process_id,since_seq:上次next_seq,wait_ms:10000})等待新增日志或退出。output_truncated表示旧输出截断；stdin用write_process({process_id,text,close_stdin})，bytes_queued不等于应用已处理。',
          stop: 'stop_process仅终止本会话拥有的进程树。宿主重启后interrupted不会接管旧PID。单命令超时、用户取消和费用/请求保护保留。',
          completion: '命令结束、本轮结束、最近验证和项目交付是不同事实。仍运行的命令先接续读取；命令成功不签发产品通过。' }) }
        if (isSoftwareProject(projectId) && input.topic === 'working-state') return { output: JSON.stringify(softwareWorkingContext(projectId)) }
        if (ctx.projectId !== projectId) throw new Error('PRODUCTION_CONTEXT_MISMATCH')
        if(input.topic==='longterm'){
          const state=isLongtermSoftware(projectId)?readLongtermState(projectId):undefined
          return{output:JSON.stringify({enabled:isLongtermSoftware(projectId),current:state?.milestones.find(item=>item.id===state.current_id),backlog:state?.backlog.slice(-20),decisions:state?.decisions.slice(-12),
            note:'待办和历史决策是上下文，不是当前范围或通过证据。只有已确认的当前任务单可实现；复杂能力/接口/数据变化时记录影响、兼容和迁移决定，不重做整套旧架构流程。'})}
        }
        if(input.topic==='independent-design')return{output:JSON.stringify({enabled:readIndependentPolicy(projectId)?.enabled??false,design:readIndependentDesign(projectId)??{status:'disabled',reason:'未启用第二模型验收设计；当前为单模型验收。'},
          adapter:'启用时，在项目根INDEPENDENT_ADAPTER.json提供{version:1,design_digest:冻结设计digest,controls:{逻辑控件名:静态CSS选择器}}。不得包含输入、预期或脚本；宿主按冻结业务设计编排并执行，B的文字不能签发PASS。'})}
        if(input.topic==='verification-speech'&&isSoftwareProject(projectId))return{output:JSON.stringify({protocol:SPEECH_VERIFICATION_BRIEF,
          prepare:'先inspect_software_capabilities；准备用prepare_software_capability({capability:"speech"})，缺资源可显式download_models:true下载固定公开资产；普通pip不会物化平台组件。',
          python:'from speech_runtime import SpeechEngine；CORE_CHECK.json speech:{module:"speech_runtime",factory:"SpeechEngine",method:"transcribe",rate_argument:true}，指向产品实际使用入口。',
          node:'const {transcribeWav}=require("./speech_bridge.cjs"); await transcribeWav(APP_DATA_DIR内PCM16 WAV绝对路径,{signal,timeoutMs:90000})；由宿主BLOMA_SPEECH_PYTHON绑定项目.venv，不要求用户安装Python或借用平台语音IPC。',
          verification:'固定音频/真实解码、GUI产品路径、真实麦克风和独立机器交付分开报告；未授权不录音，缺能力不能文本模拟过关。'})}
        if (input.topic === 'data-update' && isSoftwareProject(projectId)) return { output: SOFTWARE_DATA_UPDATE_GUIDANCE }
        if (input.topic === 'delivery' && isSoftwareProject(projectId)) return { output: SOFTWARE_LAUNCH_GUIDANCE + '\n' + SOFTWARE_DELIVERY_GUIDANCE }
        if (input.topic === 'resume' && isSoftwareProject(projectId)) return { output: JSON.stringify(softwareResumeContext(projectId)) }
        if (['verification', 'verification-gui'].includes(String(input.topic)) && isSoftwareProject(projectId)) {
          const brief = readPrdBackplane(projectId)
          return { output: JSON.stringify({ launch: SOFTWARE_LAUNCH_GUIDANCE, protocol: '界面测试可直接verify_app({script:"tests/acceptance.mjs"})，不必展开动作表；使用模块参数提供的test/expect/assert。旧steps+acceptance_refs仍兼容，kind不是action，精确预期填equals。开发观察不等于验收。CLI仍用register_cli_check固定args/stdout/exit_code和任务单expectations。',
            native_tests: {call:'verify_app({script:"tests/acceptance.mjs"})',
              example:'export default async({test,page,expect,assert,dataDir,phase})=>{ await test("F-001 主路径",async()=>{await page.locator("#input").fill("已确认输入");await page.locator("#save").click();await expect(page.locator("#result")).toHaveText("已确认预期")}) }',
              rules:'使用参数中的test/expect/assert，每个业务案例名含一个F编号。开发测试与探针用inspect_app自由调试。verify_app先检查实际入口与依赖，只封存入口引用的模块/夹具，保留工程相对路径；动态资产可在脚本同目录native-inputs.json的files中列出工程相对路径，无关探针不参与封存。允许追加检查、修定位、有界等待100–30000ms和导航等待选项；未执行过的引导计划按宿主失败凭据修复并留痕，已执行的业务输入/断言及共享业务逻辑不能降低。截图报告写evidenceDir；宿主诊断截图失败单列告警，不代表视觉通过。phase===reopened触发真实重开，不从宿主源码猜协议。'},
            gui_step_schema: guiStepsSchema(96, SOFTWARE_GUI_ACTION_KINDS), gui_fixture_schema: GUI_FIXTURE_SCHEMA, example: GUI_CHECK_EXAMPLE,
            selector_guidance: '列表记录按稳定身份定位，避免nth-child随着新增/编辑后的排序改变。Electron/浏览器观察器支持Playwright可见文本选择器，如#note-list .note-item:has-text("笔记B")；Python固定观察器仍需真实CSS。修正selector可以，不能降低固定输入/预期。',
            authoritative_expectations: Object.fromEntries(brief.requirements.map(row => [row.id, trustedAcceptance(brief, row)])),
            control_bindings: guiControlBindings(projectId), data_directory: 'APP_DATA_DIR' }) }
        }
        if (input.topic === 'verification-llm' && isSoftwareProject(projectId)) return { output: JSON.stringify({ vision:VISION_GUIDANCE.verify, protocol:
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
