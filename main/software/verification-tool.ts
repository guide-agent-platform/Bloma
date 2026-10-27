import { existsSync, readFileSync } from 'node:fs'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import { guiSuitePath, parseGuiSuite } from '../desktop/gui-acceptance'
import type { createSoftwareCollaborationPolicy } from './collaboration-policy'
import { closeDebugSessions } from './debug-sessions'
import { stopSoftwareSession, redactSoftwareOutput } from './process-manager'
import { verifySoftwareCandidate } from './verification'
import { registerNativeGuiTests } from './native-gui-registration'
import { findProject } from '../project/project-service'
import { requireLaunchDeclaration } from '../desktop/launch-smoke'
import { verificationFailure } from './verification-diagnostics'

export function buildSoftwareVerifyTool(projectId: string, policy: ReturnType<typeof createSoftwareCollaborationPolicy>, previewChanged?: (url?: string) => void): AgentLoopTool {
  return { name: 'verify_app', description: '直接验收当前软件：script为项目内原生测试，导出async({test,page,expect,assert,dataDir,evidenceDir,phase})；截图/报告写工程外evidenceDir，相对截图路径自动重定向。test为node:test API，业务测试名标注单个F编号；宿主冻结业务输入/预期并独立执行。只允许静态定位、有界等待与导航等待选项适配，修改后重新verify_app(script)记录版本，不能改业务输入/断言或用选择器夹带代码。reopened分支实际关闭重开。兼容旧GUI/CLI规则；相同版本/环境通过结果5分钟复用。它不改目标、不自行交付。',
    input_schema: { type: 'object', additionalProperties: false, properties: { force: { type: 'boolean', description: '只在确需强制重新实测时为true。' },
      script:{type:'string',description:'项目内应用测试，自动冻结并实际验收，无需动作表。使用参数提供的test(node:test API)、expect/assert和page；业务测试名包含单个需求F编号。'},restart:{type:'boolean',description:'按initial/reopened两次执行，实际关闭并重开应用；reopened分支也会自动识别。'} } },
    execute: async (input, ctx) => {
      try {
        policy.assertCommand(ctx)
        if (ctx.projectId !== projectId || input.force !== undefined && typeof input.force !== 'boolean') throw Error('SOFTWARE_VERIFY_INPUT_INVALID')
        if(input.script===undefined&&input.restart!==undefined)throw Error('SOFTWARE_VERIFY_INPUT_INVALID: restart与script一起提供')
        if(input.script!==undefined){if(typeof input.script!=='string'||input.restart!==undefined&&typeof input.restart!=='boolean')throw Error('GUI_NATIVE_INPUT_INVALID');requireLaunchDeclaration(findProject(projectId).root_path,'SOFTWARE_VERIFY_CONFIRMED_ENTRY_REQUIRED');registerNativeGuiTests(projectId,input.script,input.restart===true)}
        await closeDebugSessions(projectId, ctx.sessionId); await stopSoftwareSession(projectId, ctx.sessionId); previewChanged?.()
        const result = await verifySoftwareCandidate(projectId, ctx.requestId, ctx.signal, input.force === true)
        const failed = result.core?.host_gui?.steps.find(step => !step.passed)
        const suite = existsSync(guiSuitePath(projectId)) ? parseGuiSuite(JSON.parse(readFileSync(guiSuitePath(projectId), 'utf8'))) : undefined
        const step = suite?.steps.find(step => step.id === failed?.id)
        const expected = step?.kind === 'expect' || step?.kind === 'expect_file' ? { equals: step.equals, contains: step.contains, nonempty: step.nonempty } : undefined
        return { output: redactSoftwareOutput(JSON.stringify({ status: result.status, summary: result.summary, failure: result.failure, reused: Boolean(result.reused),
          failed_step: failed ? { id: failed.id, selector: step && 'selector' in step ? step.selector : undefined, has_text: step?.has_text, expected, actual: typeof failed.actual === 'string' ? failed.actual.slice(0, 1600) : failed.actual } : undefined,
          cli: result.core?.host_cli ? { status: result.core.host_cli.status, error: result.core.host_cli.error,
            cases: result.core.host_cli.cases.slice(0, 6).map(item => ({ ...item, actual: item.actual.slice(0, 500), stderr: item.stderr?.slice(-1200) })) } : undefined,
          issues: result.security?.issues.slice(0, 8), candidate_id: result.candidate?.id, report: result.report_path, evidence_dir: result.core?.host_gui?.evidence_dir,
          next: result.status === 'passed' ? '当前版本通过，可以结束制作；宿主会核对版本后交付。' : '按实际失败修复，再verify_app；不要降低已确认预期。' })),
          isError: result.status !== 'passed', feedback: { schema_version: 1, execution: 'completed', source: 'host', scope: 'software_candidate',
            verification: result.status === 'passed' ? 'passed' : result.status === 'failed' ? 'failed' : 'unverified',
            category: result.failure?.category === 'test_adapter' ? 'verification_harness' : result.status === 'environment_blocked' ? 'environment' : result.status === 'failed' ? 'product_assertion' : 'verification_harness',
            recovery: result.status === 'passed' ? 'none' : result.status === 'environment_blocked' ? 'prepare_environment' : 'inspect' } }
      } catch (error) { const summary = String(error); return { output: JSON.stringify({ summary, failure: verificationFailure({ status: 'unverified', summary }, error) }), isError: true } }
    } }
}
