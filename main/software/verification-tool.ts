import { existsSync, readFileSync } from 'node:fs'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import { guiSuitePath, parseGuiSuite } from '../desktop/gui-acceptance'
import type { createSoftwareCollaborationPolicy } from './collaboration-policy'
import { closeDebugSessions } from './debug-sessions'
import { stopSoftwareSession, redactSoftwareOutput } from './process-manager'
import { verifySoftwareCandidate } from './verification'

export function buildSoftwareVerifyTool(projectId: string, policy: ReturnType<typeof createSoftwareCollaborationPolicy>, previewChanged?: (url?: string) => void): AgentLoopTool {
  return { name: 'verify_app', description: '直接验收当前软件：停止本会话调试服务，冻结候选，用已登记GUI/CLI规则实际检查行为、安全静态问题和正常启动。返回具体失败步骤/期望/实际；修复后再调用。相同执行、源码/依赖/规则/环境均未变时复用5分钟内完整通过结果，结束制作无需重复自测。它不自行改用户目标或把项目标记交付。',
    input_schema: { type: 'object', additionalProperties: false, properties: { force: { type: 'boolean', description: '只在确需强制重新实测时为true。' } } },
    execute: async (input, ctx) => {
      try {
        policy.assertCommand(ctx)
        if (ctx.projectId !== projectId || input.force !== undefined && typeof input.force !== 'boolean') throw Error('SOFTWARE_VERIFY_INPUT_INVALID')
        await closeDebugSessions(projectId, ctx.sessionId); await stopSoftwareSession(projectId, ctx.sessionId); previewChanged?.()
        const result = await verifySoftwareCandidate(projectId, ctx.requestId, ctx.signal, input.force === true)
        const failed = result.core?.host_gui?.steps.find(step => !step.passed)
        const suite = existsSync(guiSuitePath(projectId)) ? parseGuiSuite(JSON.parse(readFileSync(guiSuitePath(projectId), 'utf8'))) : undefined
        const step = suite?.steps.find(step => step.id === failed?.id)
        const expected = step?.kind === 'expect' || step?.kind === 'expect_file' ? { equals: step.equals, contains: step.contains, nonempty: step.nonempty } : undefined
        return { output: redactSoftwareOutput(JSON.stringify({ status: result.status, summary: result.summary, reused: Boolean(result.reused),
          failed_step: failed ? { id: failed.id, selector: step && 'selector' in step ? step.selector : undefined, has_text: step?.has_text, expected, actual: typeof failed.actual === 'string' ? failed.actual.slice(0, 1600) : failed.actual } : undefined,
          cli: result.core?.host_cli ? { status: result.core.host_cli.status, error: result.core.host_cli.error,
            cases: result.core.host_cli.cases.slice(0, 6).map(item => ({ ...item, actual: item.actual.slice(0, 500), stderr: item.stderr?.slice(-1200) })) } : undefined,
          issues: result.security?.issues.slice(0, 8), candidate_id: result.candidate?.id, report: result.report_path,
          next: result.status === 'passed' ? '当前版本通过，可以结束制作；宿主会核对版本后交付。' : '按实际失败修复，再verify_app；不要降低已确认预期。' })),
          isError: result.status !== 'passed', feedback: { schema_version: 1, execution: 'completed', source: 'host', scope: 'software_candidate',
            verification: result.status === 'passed' ? 'passed' : result.status === 'failed' ? 'failed' : 'unverified',
            category: result.status === 'environment_blocked' ? 'environment' : result.status === 'failed' ? 'product_assertion' : 'verification_harness',
            recovery: result.status === 'passed' ? 'none' : result.status === 'environment_blocked' ? 'prepare_environment' : 'inspect' } }
      } catch (error) { return { output: String(error), isError: true } }
    } }
}
