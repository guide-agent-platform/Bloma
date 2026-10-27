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
import { buildRepositoryContextTool } from './repository-context'
import { buildSoftwareVerifyTool } from './verification-tool'

type Policy = ReturnType<typeof createSoftwareCollaborationPolicy>
const FILE_TOOLS = new Set(['read_file', 'list_files', 'find', 'grep', 'web_fetch', 'write_file', 'edit_file'])
export function buildSoftwareAgentTools(projectId: string, role: DelegationRunRole | 'parent', policy: Policy, previewChanged?: (url?: string) => void): AgentLoopTool[] {
  const readonly = ['review', 'research', 'explore'].includes(role)
  const files = buildAgentTools({ projectId, role: readonly ? 'research' : 'implement', realFullstackVariant: true, software: true,
    assertFileWrite: policy.assertFileWrite }).filter(tool => FILE_TOOLS.has(tool.name))
  const tools = [...files, buildProductionContextTool(projectId), buildSoftwareImageTool(projectId), buildRepositoryContextTool(projectId)]
  if (role === 'parent') tools.push(...buildSoftwareExecutionTools(projectId, policy.assertCommand, previewChanged), environmentTool(projectId), prepareEnvironmentTool(projectId, policy), buildSoftwareInspectTool(projectId, policy, previewChanged), buildSoftwareVerifyTool(projectId, policy, previewChanged))
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
      return { output: JSON.stringify(known) }
    } }
}

export const SOFTWARE_ENGINEERING_INSTRUCTIONS = [
  '你负责把已确认目标做成可用软件。自行选择成熟技术，优先沿用已有工程，先打通主路径再补齐承诺；不让零知识用户决定框架或安装开发环境。交付形态服从用户的桌面/浏览器/命令要求。',
  '用读写文件和run_command完成工程工作；长期进程用start_service，日志用read_process。复杂界面操作写项目内JS模块：export default async({page,context,expect,assert,dataDir})，调用inspect_app(script:"路径")运行标准Playwright；steps保留简短操作。不为工具局限改产品控件。会话和开发数据持续保留，源码变化自动重载。',
  '尽早实测主路径。界面验收可直接verify_app(script:"tests/acceptance.mjs")：模块导出async({test,page,expect,assert,dataDir,phase})，test使用node:test API，每个业务测试名含一个F编号；重开分支用phase==="reopened"。无需展开动作表，旧GUI/CLI登记仍兼容。按真实失败修复，定位可改但不能改输入、断言过关；通过后简短交接。协议细节按需read_production_context查询。',
  '一次只改相关部分，保留用户数据和已有行为。测试数据放APP_DATA_DIR，截图和报告放脚本上下文evidenceDir（工程外，开发与正式验收隔离）；相对截图路径自动落位，不能在成品中清理验收痕迹。数据格式变动要有迁移读回验证。inspect_app的源码检查点只是开发观察，可read比较差异，按明确文件选择restore；恢复也必须复验。',
  '默认一个负责人，独立且值得并行的工作才委派，写路径互不重叠，最终集成由你负责。普通依赖和构建自主完成；系统修改、外发发布、额外付费、破坏性真实数据操作需另有授权，不能绕过拒绝。',
  '项目根LAUNCH.json写schema_version:2，command为参数数组，ui为browser/electron/webview（非布尔值），按入口写url或mode；示例用read_production_context(launch)查询。使用正常入口验证，未打包不声称安装包。界面截图需实际查看；仅已知支持视觉的渠道附图，不另派付费视觉审查。成品API在设置页配置，不能借平台密钥或用mock冒充真实AI效果。',
].join('\n\n')
