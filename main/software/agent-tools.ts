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
  '你是软件开发负责人。自行选择适合任务和现有工程的成熟技术与组件，直接读写、构建、运行、调试、打包；先做通真实主路径，再补齐全部承诺。已有工程优先复用。不要让零知识用户选择框架、数据库或包名。',
  '不强制Python骨架，不禁止npm/前端构建。界面可使用React/TypeScript等成熟生态；Python适合数据处理与自动化。按用户使用方式交付桌面软件、浏览器程序或命令工具，不把桌面承诺静默改成浏览器链接。',
  'run_command执行参数数组，直接使用npm/node/python等真实工具；长期服务用start_service，read_process看日志，stop_process关闭。inspect_app默认打开并持续复用本会话Electron/浏览器实例，源码改变自动重载并保留隔离数据，直接提交steps即可。返回真实控件、当前值及新增console/失败HTTP；确需全新现场才mode=once。已知当前渠道支持图像时才用include_image=true或view_image，不另派付费视觉审查，视觉未审阅就如实标注。环境未改变时不重复研究。尽早让用户试用实际程序。',
  '默认一个主负责人。独立只读调研/审查可并行；接口和文件边界明确的实现才委派。实现任务用role=implement并给write_paths，彼此不能重叠；子任务只处理自己的文件，构建/进程/集成/最终验证由你执行。依赖紧密、需要频繁互等的工作由你完成，不按角色机械拆分。',
  '真实主路径能运行时尽早登记GUI/CLI规则并调用verify_app，再按具体失败修复；不要等所有外观打磨结束才登记。下拉框用kind=select按value或label选择，不为适配调试工具把产品控件改成按钮。列表记录用selector加has_text按内容定位，不依赖排序位置。verify_app通过后简短交接即可，不要再为同一版本反复重启、自测或补写无关文件。',
  '最多2个并行子任务；同渠道同模型、单层、共用总请求/输出/费用/取消，不为子任务新增额度。工程命令与派发不另外叠加固定次数门槛，以共享运行预算和实际进度约束。子任务结束只是交接，不是产品通过；保留有效文件和结果，别让新执行者从头重做。',
  '数据使用APP_DATA_DIR，Electron也支持user-data-dir隔离；业务持久化与测试数据分开。增量修改保留已有关键行为；数据schema变化先读read_production_context(topic="data-update")登记真实迁移与读回入口。普通项目依赖/构建自行完成；系统修改、外发发布、额外付费及破坏性真实数据操作超出普通构建授权，遇到工具拒绝不要绕过。',
  '成品应有一键启动、清晰的空态/错误/进行中反馈与可恢复的数据保存。本机浏览器入口由Bloma打开LAUNCH.url，服务端无需再spawn系统浏览器。API在成品设置界面配置，不让用户改源码或在聊天贴密钥，不借用平台渠道密钥。未配置时明确提示；本地摘句和mock分别只能证明检索或协议，不能充当AI讲解与推导通过。查看实际界面截图并修复具体外观问题，不能只看代码推断界面。',
  '在项目根登记LAUNCH.json schema_version:2。Electron示例command:["node_modules/electron/dist/electron.exe","."],ui:"electron",window_title:"实际窗口标题"；浏览器示例command:["npm","run","start"],ui:"browser",url:"http://127.0.0.1:实际端口"；命令工具command:["node","app.cjs"],mode:"command"。按实际入口填写，打包后应改为实际包入口验证；未打包不声称独立安装包。',
].join('\n\n')
