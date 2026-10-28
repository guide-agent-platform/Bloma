import type { AgentLoopTool, ToolContext } from '../agent/loop/agent-loop'
import { findProject } from '../project/project-service'
import { executeSoftwareCommand, projectDirectory } from './command-runtime'
import { DriverExecutionError } from '../desktop/process-driver'
import { dependencyFailureCode, dependencyInputVersion, inspectProjectDependencies, isDependencySetup } from './dependency-state'
import { startSoftwareProcess, softwareProcess, readSoftwareProcess, writeSoftwareProcess, stopSoftwareProcess, redactSoftwareOutput, activeSoftwarePreview, type SoftwareProcessSnapshot } from './process-manager'

const commandSchema = { type: 'array', minItems: 1, maxItems: 128, items: { type: 'string' } }
function admission(projectId: string, ctx: ToolContext) {
  if (ctx.projectId !== projectId) throw new Error('COMMAND_PROJECT_MISMATCH')
  ctx.signal.throwIfAborted()
}
function commandView(snapshot: SoftwareProcessSnapshot & { next_seq?: number; output_truncated?: boolean }) {
  const pending = ['starting','running','stopping'].includes(snapshot.state)
  const execution = pending ? 'running' : snapshot.completion_reason === 'timeout' ? 'failed' : snapshot.completion_reason === 'cancelled' ? 'cancelled'
    : snapshot.state === 'exited' && snapshot.code === 0 ? 'completed' : 'failed'
  const setup = snapshot.dependency_setup
  return { process_id: snapshot.id, kind: 'command', state: snapshot.state, execution_status: execution, completion_reason: snapshot.completion_reason,
    exit_code: pending ? undefined : snapshot.code, next_seq: snapshot.next_seq ?? snapshot.output_seq ?? 0, output: snapshot.output ?? [], output_truncated: snapshot.output_truncated,
    ...(!pending ? { stdout: snapshot.stdout, stderr: snapshot.stderr } : {}),
    ...(setup ? { dependencies: inspectProjectDependencies(setup.root), input_version: setup.input_version } : {}),
    ...(execution === 'failed' ? { code: snapshot.state === 'interrupted' ? 'COMMAND_HOST_INTERRUPTED' : setup ? dependencyFailureCode(snapshot.completion_reason === 'timeout' ? 'timeout' : 'exit', snapshot.stderr)
      : snapshot.completion_reason === 'timeout' ? 'COMMAND_TIMEOUT' : 'COMMAND_EXIT_FAILED' } : {}),
    verification: 'not_applicable', task_completion: 'unverified',
    next: pending ? '命令仍在运行；用read_process(process_id,since_seq:next_seq,wait_ms:10000)读取后续结果，不要重复启动。'
      : '这是命令退出结果，产品是否可交付仍需实际验证。' }
}
/** Tool schemas describe arguments; stdout and exit code are execution facts,
 * never a product verification PASS. Standard engineering tools stay available. */
export function buildSoftwareExecutionTools(projectId: string, beforeExecute?: (ctx: ToolContext) => void, previewChanged?: (url?: string) => void): AgentLoopTool[] {
  const run: AgentLoopTool = { name: 'run_command', description: '执行项目工程命令，command为参数数组，不隐式启动shell。安装/构建/测试可加yield_ms:1000：等待至多该时间后返回process_id，命令继续执行，使用read_process增量读取/等待、write_process输入、stop_process停止，不要重复启动。省略yield_ms保留同步调用。单命令默认120秒、上限300秒；退出成功不等于产品通过。',
    input_schema: { type: 'object', required: ['command'], properties: { command: commandSchema, cwd: { type: 'string' }, timeout_ms: { type: 'integer', minimum: 100, maximum: 300000 }, yield_ms: { type: 'integer', minimum: 0, maximum: 30000 } } },
    execute: async (input, ctx) => {
      let setupRoot: string | undefined
      try {
        beforeExecute?.(ctx); admission(projectId, ctx)
        const root = findProject(projectId).root_path
        if (input.yield_ms !== undefined) {
          if (!Number.isSafeInteger(input.yield_ms) || Number(input.yield_ms) < 0 || Number(input.yield_ms) > 30000) throw Error('COMMAND_YIELD_INVALID')
          const started = await startSoftwareProcess({ projectId, sessionId: ctx.sessionId, root, command: input.command,
            cwd: input.cwd as string | undefined, signal: ctx.signal, kind: 'command', timeoutMs: input.timeout_ms as number | undefined ?? 120000 })
          const snapshot = await readSoftwareProcess(projectId, started.id, ctx.sessionId, 0, Number(input.yield_ms), ctx.signal), result = commandView(snapshot)
          return { output: JSON.stringify(result), isError: ['failed','cancelled'].includes(result.execution_status), detail: { process_id: started.id },
            feedback: { schema_version: 1, source: 'host', scope: 'command_execution', execution: result.execution_status as 'running'|'completed'|'failed'|'cancelled',
              verification: 'not_applicable', task_completion: 'unverified', recovery: result.execution_status === 'running' ? 'inspect' : 'none' } }
        }
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
  const read: AgentLoopTool = { name: 'read_process', parallelSafe: true, description: '读取本会话拥有的服务/命令；since_seq传上次next_seq，只返回新增日志，wait_ms可有界等待新输出/退出（上限30秒）。读不重启命令；宿主重启后标interrupted，不接管旧PID。命令退出结果不代表产品验收。',
    input_schema: { type: 'object', required: ['process_id'], properties: { process_id: { type: 'string' }, since_seq: { type: 'integer', minimum: 0 }, wait_ms: { type: 'integer', minimum: 0, maximum: 30000 } } }, execute: async (input, ctx) => {
      try {
        if (ctx.projectId !== projectId) throw new Error('PROCESS_PROJECT_MISMATCH')
        const result = await readSoftwareProcess(projectId, String(input.process_id), ctx.sessionId, Number(input.since_seq ?? 0), Number(input.wait_ms ?? 0), ctx.signal)
        const command = result.kind === 'command' ? commandView(result) : undefined
        return { output: JSON.stringify(command ?? result), isError: Boolean(command && ['failed','cancelled'].includes(command.execution_status)),
          ...(command ? { feedback: { schema_version: 1 as const, source: 'host' as const, scope: 'command_execution', execution: command.execution_status as 'running'|'completed'|'failed'|'cancelled', verification: 'not_applicable' as const, task_completion: 'unverified' as const } } : {}) }
      }
      catch (error) { return { output: String(error), isError: true } }
    } }
  const write: AgentLoopTool = { name: 'write_process', description: '向本会话实际启动的命令会话输入文本，可close_stdin发送EOF；不操作服务、用户进程或重启后旧PID。返回仅表示已排队，实际处理结果用read_process核对。',
    input_schema: { type: 'object', required: ['process_id'], properties: { process_id: { type: 'string' }, text: { type: 'string', maxLength: 65536 }, close_stdin: { type: 'boolean' } } }, execute: async (input, ctx) => {
      try { beforeExecute?.(ctx); admission(projectId, ctx); return { output: JSON.stringify(writeSoftwareProcess(projectId, String(input.process_id), ctx.sessionId, input.text as string ?? '', input.close_stdin as boolean ?? false)) } }
      catch (error) { return { output: String(error), isError: true } }
    } }
  const stop: AgentLoopTool = { name: 'stop_process', description: '仅停止本项目本会话实际创建的进程树，不使用用户提供的PID，不接管重启后未知的进程。',
    input_schema: { type:'object',required:['process_id'],properties:{process_id:{type:'string'}} }, execute: async (input, ctx) => {
      try { if (ctx.projectId !== projectId) throw new Error('PROCESS_PROJECT_MISMATCH'); const result = await stopSoftwareProcess(projectId, String(input.process_id), ctx.sessionId); previewChanged?.(activeSoftwarePreview(projectId)); return { output: JSON.stringify(result) } }
      catch (error) { return { output: String(error), isError: true } }
    } }
  return [run, start, read, write, stop]
}
