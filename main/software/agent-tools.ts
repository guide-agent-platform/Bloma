import { buildAgentTools } from '../agent/tools/agent-tools'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import type { DelegationRunRole } from '../../shared/delegation-run-context'
import { buildProductionContextTool } from '../desktop/production-context'
import { buildSoftwareExecutionTools } from './execution-tools'
import { executeSoftwareCommand } from './command-runtime'
import { findProject } from '../project/project-service'
import type { createSoftwareCollaborationPolicy } from './collaboration-policy'
import { buildSoftwareImageTool } from './image-tool'
import { buildSoftwareInspectTool } from './inspect-tool'
import { prepareSoftwareRuntime, projectRuntimeRequest } from './runtime-manager'
import { runtimeBindingVersion } from './runtime-bindings'
import { inspectProjectDependencies } from './dependency-state'
import { buildRepositoryContextTool } from './repository-context'
import { buildSoftwareVerifyTool } from './verification-tool'
import { buildImprovementSuggestionTool } from './improvement-suggestions'
import { buildCapabilityTools } from './capability-tools'
import { isLongtermSoftware, recordLongtermDecision } from './longterm-state'

type Policy = ReturnType<typeof createSoftwareCollaborationPolicy>
const FILE_TOOLS = new Set(['read_file', 'list_files', 'find', 'grep', 'web_fetch', 'write_file', 'edit_file'])
export function buildSoftwareAgentTools(projectId: string, role: DelegationRunRole | 'parent', policy: Policy, previewChanged?: (url?: string) => void, suggestionsChanged?: () => void, longtermChanged?:()=>void): AgentLoopTool[] {
  const readonly = ['review', 'research', 'explore'].includes(role)
  const files = buildAgentTools({ projectId, role: readonly ? 'research' : 'implement', realFullstackVariant: true, software: true,
    assertFileWrite: policy.assertFileWrite }).filter(tool => FILE_TOOLS.has(tool.name))
  const tools = [...files, buildProductionContextTool(projectId), buildSoftwareImageTool(projectId), buildRepositoryContextTool(projectId),...buildCapabilityTools(projectId,policy,role==='parent')]
  if (role === 'parent') tools.push(...buildSoftwareExecutionTools(projectId, policy.assertCommand, previewChanged), environmentTool(projectId), prepareEnvironmentTool(projectId, policy), buildSoftwareInspectTool(projectId, policy, previewChanged), buildSoftwareVerifyTool(projectId, policy, previewChanged), buildImprovementSuggestionTool(projectId,suggestionsChanged,policy.assertCommand))
  let longterm=false
  try{longterm=isLongtermSoftware(projectId)}catch{/* isolated schema clients may build tools before storing a project */}
  if(role==='parent'&&longterm)tools.push({name:'record_longterm_decision',description:'保存当前长期里程碑的重要接口/数据格式/资源/迁移决定和理由，供下一轮恢复。不改范围、不验证、不暂停；不要保存密钥或把待办当成本轮授权。',
    input_schema:{type:'object',additionalProperties:false,required:['decision','reason'],properties:{decision:{type:'string',maxLength:1200},reason:{type:'string',maxLength:1600}}},execute:async(input,ctx)=>{
      try{policy.assertCommand(ctx);if(ctx.projectId!==projectId||typeof input.decision!=='string'||typeof input.reason!=='string')throw Error('LONGTERM_DECISION_INVALID')
        const state=recordLongtermDecision(projectId,ctx.sessionId,input.decision,input.reason);longtermChanged?.();return{output:JSON.stringify({saved:true,revision:state.revision,decision:state.decisions.at(-1)})}
      }catch(error){return{output:String(error),isError:true}}
    }})
  return tools
}

function prepareEnvironmentTool(projectId: string, policy: Policy): AgentLoopTool {
  return { name: 'prepare_software_environment', description: '在Bloma私有目录准备并校验真实Node或Python运行时，自动绑定本项目命令和npm子进程；复用相同版本。尊重engines/.python-version/requires-python，version可省略。首期Windows x64，不改系统PATH/注册表，不请求用户安装。下载失败保留可恢复状态；工程依赖仍用原包管理器/锁文件安装。',
    input_schema: { type: 'object', required: ['runtime'], additionalProperties: false, properties: { runtime: { type: 'string', enum: ['node', 'python'] }, version: { type: 'string', maxLength: 100 } } },
    execute: async (input, ctx) => {
      try {
        policy.assertCommand(ctx)
        if (ctx.projectId !== projectId || !['node', 'python'].includes(String(input.runtime)) || input.version !== undefined && (typeof input.version !== 'string' || input.version.length > 100)) throw Error('RUNTIME_INPUT_INVALID')
        const prepared = await prepareSoftwareRuntime(projectId, findProject(projectId).root_path, input.runtime as 'node' | 'python', input.version as string | undefined, ctx.signal)
        return { output: JSON.stringify({ ...prepared, verification: '运行时已实际执行探测；不等于软件完成或独立交付' }) }
      } catch (error) { return { isError: true, output: String(error) } }
    } }
}

function environmentTool(projectId: string): AgentLoopTool {
  let known: unknown
  let version: string | undefined
  return { name: 'inspect_software_environment', description: '实际检查Node/npm/Python版本及当前可用的交付观察器。默认复用本轮结果；refresh仅在工具环境改变后使用。npm CLI随Bloma提供；实际运行时缺失时如实返回，不让用户选择工程技术细节。',
    input_schema: { type: 'object', properties: { refresh: { type: 'boolean' } } }, execute: async (input, ctx) => {
      if (ctx.projectId !== projectId) return { output: 'ENVIRONMENT_PROJECT_MISMATCH', isError: true }
      const root = findProject(projectId).root_path, constraints = { node: projectRuntimeRequest(root, 'node'), python: projectRuntimeRequest(root, 'python') }
      const current = JSON.stringify([constraints, runtimeBindingVersion(projectId)])
      if (!known || input.refresh === true || version !== current) {
        const probes = await Promise.allSettled(['node', 'npm', 'python'].map(executable => executeSoftwareCommand({ root, projectId,
          command: [executable, '--version'], timeoutMs: 10000, signal: ctx.signal })))
        known = { project_constraints: constraints,
          preparation: '需要缺失/不同版本时使用prepare_software_environment；它准备本项目运行时，不改系统环境。已有版本可用时不必下载。', tools: Object.fromEntries(probes.map((result, i) => [['node', 'npm', 'python'][i], result.status === 'fulfilled'
          ? { available: result.value.code === 0, output: result.value.stdout.trim(), error: result.value.stderr.trim() }
          : { available: false, error: String(result.reason) }])),
          gui_observers: ['Electron正常入口+持续DOM操作+重开', '本机浏览器服务+持续DOM操作+重开', 'Python/pywebview仅正式register_gui_check/verify_app检查，inspect_app不支持'],
          development_state: 'inspect_app暂停后保留本任务开发数据和浏览器存储，下一次操作自动重开；正式验收另用全新隔离数据。',
          cli_observer: '正常入口的固定参数/实际stdout/退出码；Node/Python等不要求Python包装器',
          execution_boundary: '受管理的项目执行环境，不是OS沙箱；上游渠道密钥不传入命令环境' }
        version = current
      }
      // Dependency files change during implementation; do not cache their state
      // alongside the relatively stable runtime version probes.
      return { output: JSON.stringify({ ...known as object, dependencies: inspectProjectDependencies(root) }) }
    } }
}

export const SOFTWARE_ENGINEERING_INSTRUCTIONS = [
  '通用能力按需读取：read_production_context(capabilities)看目录，execution看异步命令，working-state看当前现场。安装/构建/测试可run_command(yield_ms:1000)保留同一进程，用read_process等待结果；不要因工具已返回就重复启动或宣称完成。已有说明和组件按需使用，不增加前置流程。',
  '长期型读取read_production_context(longterm)恢复当前里程碑、待办与决策。只实现当前已确认目标；待办不自动开工。能力/接口/数据结构有重要变化时用record_longterm_decision保存兼容、迁移或回滚决定及原因。宿主检查通过后保留当前版本，待用户核对里程碑；不要把本阶段通过说成整个长期产品已完成。',
  '语音识别等复杂能力先用inspect_software_capabilities检查现有组件、项目运行时和真实资源；speech用prepare_software_capability受控准备，不扫描宿主源码猜协议，不重复手写模型下载/录音内核。Python直接复用SpeechEngine，Node/Electron可用speech_bridge.cjs.transcribeWav处理APP_DATA_DIR内的PCM16 WAV；资源准备、固定音频与真实麦克风/GUI/独立交付分别验收。',
  '若宿主已启用第二模型验收设计，先用read_production_context(independent-design)读取冻结案例；实现这些已确认业务预期并在INDEPENDENT_ADAPTER.json只映射逻辑控件到静态CSS，不能改输入或断言。未启用时仍为单模型验收，不声称独立审阅。',
  '可用offer_suggestions留下制作中或交付后供参考的改进建议；它不改变范围、不暂停当前制作。未被用户明确选择并再次确认的建议，不能实现或列为验收义务；不要用propose_scope_change把自己的想法冒充用户新需求。',
  '你负责把已确认目标做成可用软件。自行选择成熟技术，优先沿用已有工程，先打通主路径再补齐承诺；不让零知识用户决定框架或安装开发环境。交付形态服从用户的桌面/浏览器/命令要求。',
  '用读写文件和run_command完成工程工作；长期进程用start_service，日志用read_process。复杂界面操作写项目内JS模块：export default async({page,context,expect,assert,dataDir})，调用inspect_app(script:"路径")运行标准Playwright；steps保留简短操作。不为工具局限改产品控件。会话和开发数据持续保留，源码变化自动重载。',
  '尽早实测主路径。界面验收可直接verify_app(script:"tests/acceptance.mjs")：模块导出async({test,page,expect,assert,dataDir,phase})，test使用node:test API，每个业务测试名含一个F编号；重开分支用phase==="reopened"。无需展开动作表，旧GUI/CLI登记仍兼容。按真实失败修复，定位可改但不能改输入、断言过关；通过后简短交接。协议细节按需read_production_context查询。',
  '一次只改相关部分，保留用户数据和已有行为。测试数据放APP_DATA_DIR，截图和报告放脚本上下文evidenceDir（工程外，开发与正式验收隔离）；相对截图路径自动落位，不能在成品中清理验收痕迹。数据格式变动要有迁移读回验证。inspect_app的源码检查点只是开发观察，可read比较差异，按明确文件选择restore；恢复也必须复验。',
  '默认一个负责人，独立且值得并行的工作才委派，写路径互不重叠，最终集成由你负责。普通依赖和构建自主完成；系统修改、外发发布、额外付费、破坏性真实数据操作需另有授权，不能绕过拒绝。',
  '项目根LAUNCH.json写schema_version:2，command为参数数组，ui为browser/electron/webview（非布尔值），按入口写url或mode；示例用read_production_context(launch)查询。使用正常入口验证，未打包不声称安装包。界面截图需实际查看；仅已知支持视觉的渠道附图，不另派付费视觉审查。成品API在设置页配置，不能借平台密钥或用mock冒充真实AI效果。',
].join('\n\n')
