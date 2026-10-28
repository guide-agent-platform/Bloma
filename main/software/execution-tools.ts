import type { AgentLoopTool, ToolContext } from '../agent/loop/agent-loop'
import { findProject } from '../project/project-service'
import { executeSoftwareCommand, projectDirectory } from './command-runtime'
import { DriverExecutionError } from '../desktop/process-driver'
import { dependencyFailureCode, dependencyInputVersion, inspectProjectDependencies, isDependencySetup } from './dependency-state'
import { startSoftwareProcess, softwareProcess, stopSoftwareProcess, redactSoftwareOutput, activeSoftwarePreview } from './process-manager'

const commandSchema = { type: 'array', minItems: 1, maxItems: 128, items: { type: 'string' } }
function admission(projectId: string, ctx: ToolContext) {
  if (ctx.projectId !== projectId) throw new Error('COMMAND_PROJECT_MISMATCH')
  ctx.signal.throwIfAborted()
}
/** Tool schemas describe arguments; stdout and exit code are execution facts,
 * never a product verification PASS. Standard engineering tools stay available. */
export function buildSoftwareExecutionTools(projectId: string, beforeExecute?: (ctx: ToolContext) => void, previewChanged?: (url?: string) => void): AgentLoopTool[] {
  const run: AgentLoopTool = { name: 'run_command', description: '在项目内执行真实工程命令，command为参数数组，例如["npm","install"]、["npm","run","build"]、["node","--test"]、["python","app.py"]。无需写Python包装器；不隐式启动shell。默认120秒，上限300秒。进程退出不等于产品通过；返回实际退出码与日志。',
    input_schema: { type: 'object', required: ['command'], properties: { command: commandSchema, cwd: { type: 'string' }, timeout_ms: { type: 'integer', minimum: 100, maximum: 300000 } } },
    execute: async (input, ctx) => {
      let setupRoot: string | undefined
      try {
        beforeExecute?.(ctx); admission(projectId, ctx)
        const root = findProject(projectId).root_path
        if (isDependencySetup(input.command)) setupRoot = projectDirectory(root, input.cwd as string | undefined)
        const result = await executeSoftwareCommand({ projectId, root: findProject(projectId).root_path, command: input.command,
          cwd: input.cwd as string | undefined, timeoutMs: input.timeout_ms as number | undefined, signal: ctx.signal })
        return { output: JSON.stringify({ exit_code: result.code, stdout: redactSoftwareOutput(result.stdout).slice(-24000), stderr: redactSoftwareOutput(result.stderr).slice(-12000),
          ...(setupRoot ? { dependencies: inspectProjectDependencies(setupRoot), ...(result.code !== 0 ? {
            code: dependencyFailureCode('exit', result.stderr), input_version: dependencyInputVersion(setupRoot, input.command),
            next: '按安装日志与缺失项恢复；同一失败未解除前，不原样重试完整安装。' } : {}) } : {}) }), isError: result.code !== 0 }
      } catch (error) {
        const message = redactSoftwareOutput(error instanceof Error ? error.message : String(error))
        if (error instanceof DriverExecutionError) return { output: JSON.stringify({ code: setupRoot ? dependencyFailureCode(error.kind, error.stderr) : `COMMAND_${error.kind.toUpperCase().replaceAll('-', '_')}`,
          message, stdout: redactSoftwareOutput(error.stdout), stderr: redactSoftwareOutput(error.stderr),
          ...(setupRoot ? { dependencies: inspectProjectDependencies(setupRoot), input_version: dependencyInputVersion(setupRoot, input.command),
            next: '保留已有安装和缓存，按具体日志排查下载或安装脚本；不要将超时当作全部依赖缺失而反复整包安装。' } : {}) }), isError: true }
        return { output: message, isError: true }
      }
    } }
  const start: AgentLoopTool = { name: 'start_service', description: '启动项目内受管理的开发服务器/后台进程，立即保留身份与日志。APP_DATA_DIR由宿主提供在工程外，不要自行覆盖为项目内的临时目录，否则保存数据会改变源码版本。url填写实际HTTP回环地址时等待就绪；相同已拥有服务自动复用，后续用read_process/stop_process。不要用run_command挂住长期服务。',
    input_schema: { type: 'object', required: ['command'], properties: { command: commandSchema, cwd: { type: 'string' }, url: { type: 'string' } } },
    execute: async (input, ctx) => {
      try {
        beforeExecute?.(ctx); admission(projectId, ctx)
        const result = await startSoftwareProcess({ projectId, sessionId: ctx.sessionId, root: findProject(projectId).root_path,
          command: input.command, cwd: input.cwd as string | undefined, url: input.url as string | undefined, signal: ctx.signal })
        if (result.ready && result.url) { ctx.state.preview_url = result.url; previewChanged?.(result.url) }
        return { output: JSON.stringify(result), isError: result.state !== 'running', detail: { process_id: result.id, ...(result.ready ? { preview_url: result.url } : {}) } }
      } catch (error) { return { output: error instanceof Error ? error.message : String(error), isError: true } }
    } }
  const read: AgentLoopTool = { name: 'read_process', parallelSafe: true, description: '读取本项目本会话受管理进程的状态、就绪地址、stdout/stderr；重启后的未知PID标为interrupted，不当作仍在运行。',
    input_schema: { type: 'object', required: ['process_id'], properties: { process_id: { type: 'string' } } }, execute: async (input, ctx) => {
      try { if (ctx.projectId !== projectId) throw new Error('PROCESS_PROJECT_MISMATCH'); return { output: JSON.stringify(softwareProcess(projectId, String(input.process_id), ctx.sessionId)) } }
      catch (error) { return { output: String(error), isError: true } }
    } }
  const stop: AgentLoopTool = { name: 'stop_process', description: '仅停止本项目本会话实际创建的进程树，不使用用户提供的PID，不接管重启后未知的进程。',
    input_schema: read.input_schema, execute: async (input, ctx) => {
      try { if (ctx.projectId !== projectId) throw new Error('PROCESS_PROJECT_MISMATCH'); const result = await stopSoftwareProcess(projectId, String(input.process_id), ctx.sessionId); previewChanged?.(activeSoftwarePreview(projectId)); return { output: JSON.stringify(result) } }
      catch (error) { return { output: String(error), isError: true } }
    } }
  return [run, start, read, stop]
}
