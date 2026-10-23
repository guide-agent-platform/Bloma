import { existsSync, readFileSync } from 'node:fs'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import { readPrdBackplane } from '../project/prd-store'
import { findProject, updateProject } from '../project/project-service'
import { prdScopeFingerprint, trustedAcceptance } from '../project/requirement-contract'
import { guiSuitePath, installGuiAcceptanceSuite, parseGuiSuite } from './gui-acceptance'

/** Bind user intent to a host-executed GUI suite. Registration is never PASS. */
export function buildLeanGuiTool(projectId: string): AgentLoopTool {
  return { name: 'register_gui_check', description: '登记宿主真实GUI检查。steps用fill/click/expect/restart；expectations逐项复制任务单expected；acceptance_refs把expect步骤id关联F编号。只登记，宿主随后执行；同目标修复不得降低既有输入与预期。',
    input_schema: { type: 'object', required: ['steps', 'expectations', 'acceptance_refs'], properties: {
      steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
      expectations: { type: 'object', additionalProperties: { type: 'string' } },
      acceptance_refs: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
      fixtures: { type: 'array', items: { type: 'object', additionalProperties: true } },
    } }, execute: async (input, ctx) => {
      try {
        if (ctx.projectId !== projectId) throw new Error('GUI_PROJECT_MISMATCH')
        const brief = readPrdBackplane(projectId), project = findProject(projectId), scope = prdScopeFingerprint(brief)
        if (!brief.user_confirmed_at || !brief.lean_brief || project.ux_confirmation?.prd_fingerprint !== scope) throw new Error('GUI_CONFIRMED_SCOPE_REQUIRED')
        const expected = input.expectations as Record<string, unknown>
        if (!expected || brief.requirements.some(row => expected[row.id] !== trustedAcceptance(brief, row)) || Object.keys(expected).some(id => !brief.requirements.some(row => row.id === id))) throw new Error('GUI_EXPECTATION_SCOPE_MISMATCH')
        const suite = parseGuiSuite({ ...input, version: 1, scope_hash: scope, design_hash: project.ux_confirmation.design_hash,
          covers: brief.requirements.map(row => row.id) })
        const refs = suite.acceptance_refs
        if (!suite.steps.some(step => step.kind === 'fill' || step.kind === 'click') || !refs || Object.entries(refs).some(([id, features]) =>
          !suite.steps.some(step => step.id === id && step.kind === 'expect') || !Array.isArray(features) || !features.length
          || features.some(fid => !suite.covers.includes(fid))) || suite.covers.some(fid => !Object.values(refs).some(ids => ids.includes(fid)))) throw new Error('GUI_EXPECT_OBSERVATIONS_REQUIRED')
        const previous = existsSync(guiSuitePath(projectId)) ? parseGuiSuite(JSON.parse(readFileSync(guiSuitePath(projectId), 'utf8'))) : undefined
        const contract = (value: typeof suite) => JSON.stringify({ refs: value.acceptance_refs, fixtures: value.fixtures, steps: value.steps.map(step => {
          const { selector: _selector, ...meaning } = step as typeof step & { selector?: string }
          return meaning
        }) })
        if (previous?.scope_hash === scope && contract(previous) !== contract(suite)) throw new Error('GUI_EXISTING_EXPECTATIONS_CHANGED: 同目标只允许修正控件定位，不能改输入或预期过关')
        installGuiAcceptanceSuite(projectId, suite)
        updateProject(projectId, { gui_acceptance: { status: 'sealed', scope_hash: scope } })
        return { output: '已登记当前目标的GUI操作与固定预期，尚未执行或判定通过。' }
      } catch (error) { return { output: error instanceof Error ? error.message : String(error), isError: true } }
    } }
}
