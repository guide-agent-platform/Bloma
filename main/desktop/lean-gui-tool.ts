import { existsSync, readFileSync } from 'node:fs'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import { readPrdBackplane } from '../project/prd-store'
import { findProject, updateProject } from '../project/project-service'
import { prdScopeFingerprint, trustedAcceptance } from '../project/requirement-contract'
import { guiSuitePath, installGuiAcceptanceSuite, parseGuiSuite } from './gui-acceptance'
import { guiStepsSchema, GUI_CHECK_EXAMPLE, guiInputFailure, SOFTWARE_GUI_ACTION_KINDS, LEGACY_GUI_ACTION_KINDS } from './gui-tool-contract'
import { isSoftwareProject } from './workflow-policy'
import { sealGuiFixtures, GUI_FIXTURE_SCHEMA } from './gui-fixtures'
import { assertRetainedSoftwareBehavior } from '../software/regression-baseline'

/** Bind user intent to a host-executed GUI suite. Registration is never PASS. */
export function buildLeanGuiTool(projectId: string): AgentLoopTool {
  const software = isSoftwareProject(projectId)
  return { name: 'register_gui_check', description: `登记宿主真实GUI检查。steps需唯一id和kind，expect精确预期用equals；acceptance_refs为expect步骤id→F编号数组。${software ? '宿主自动绑定已确认任务单，无需复制expectations。' : 'expectations逐项复制任务单expected。'}示例：${JSON.stringify(GUI_CHECK_EXAMPLE)}。只登记不等于通过；同目标修复不能降低固定输入或预期。`,
    input_schema: { type: 'object', required: software ? ['steps', 'acceptance_refs'] : ['steps', 'expectations', 'acceptance_refs'], properties: {
      steps: guiStepsSchema(96, software ? SOFTWARE_GUI_ACTION_KINDS : LEGACY_GUI_ACTION_KINDS),
      expectations: { type: 'object', additionalProperties: { type: 'string' }, description: software ? '可省略；如提供必须与宿主预期完全一致，不能改写用户意图。' : 'F编号→任务单expected原文，必须覆盖全部功能。' },
      acceptance_refs: { type: 'object', additionalProperties: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^F-\\d+$' } }, description: '例如 {"answer":["F-001"]}；键必须是expect步骤id，全部功能都要被实际断言覆盖。' },
      fixtures: GUI_FIXTURE_SCHEMA,
    } }, execute: async (input, ctx) => {
      try {
        ctx.signal.throwIfAborted()
        if (ctx.projectId !== projectId) throw new Error('GUI_PROJECT_MISMATCH')
        const brief = readPrdBackplane(projectId), project = findProject(projectId), scope = prdScopeFingerprint(brief)
        if (!brief.user_confirmed_at || !brief.lean_brief || project.ux_confirmation?.prd_fingerprint !== scope) throw new Error('GUI_CONFIRMED_SCOPE_REQUIRED')
        const authoritative = Object.fromEntries(brief.requirements.map(row => [row.id, trustedAcceptance(brief, row)]))
        const expected = input.expectations as Record<string, unknown> | undefined
        if ((!software || expected !== undefined) && (!expected || Array.isArray(expected) || typeof expected !== 'object'
          || brief.requirements.some(row => expected[row.id] !== authoritative[row.id]) || Object.keys(expected).some(id => !Object.hasOwn(authoritative, id)))) {
          return guiInputFailure(new Error('GUI_EXPECTATION_SCOPE_MISMATCH: expectations应为全部F编号→已确认expected原文；此处拒绝后steps尚未校验'), { authoritative_expectations: authoritative, expectations_optional: software })
        }
        const suite = sealGuiFixtures(projectId, project.root_path, parseGuiSuite({ ...input, expectations: authoritative, version: 1, scope_hash: scope, design_hash: project.ux_confirmation.design_hash,
          covers: brief.requirements.map(row => row.id) }))
        const refs = suite.acceptance_refs
        if (!suite.steps.some(step => ['fill', 'click', 'upload', 'native_upload', 'download', 'press', 'drag'].includes(step.kind)) || !refs || Object.entries(refs).some(([id, features]) =>
          !suite.steps.some(step => step.id === id && ['expect', 'expect_file'].includes(step.kind)) || !Array.isArray(features) || !features.length
          || features.some(fid => !suite.covers.includes(fid))) || suite.covers.some(fid => !Object.values(refs).some(ids => ids.includes(fid)))) throw new Error(`GUI_EXPECT_OBSERVATIONS_REQUIRED: acceptance_refs必须为expect步骤id→F编号数组，需覆盖${suite.covers.join(',')}，并至少实际fill或click一次`)
        const previous = existsSync(guiSuitePath(projectId)) ? parseGuiSuite(JSON.parse(readFileSync(guiSuitePath(projectId), 'utf8'))) : undefined
        const contract = (value: typeof suite) => JSON.stringify({ refs: value.acceptance_refs, fixtures: value.fixtures, steps: value.steps.map(step => {
          const { selector: _selector, has_text: _text, ...meaning } = step as typeof step & { selector?: string }
          return meaning
        }) })
        if (previous?.scope_hash === scope && contract(previous) !== contract(suite)) throw new Error('GUI_EXISTING_EXPECTATIONS_CHANGED: 同目标只允许修正控件定位，不能改输入或预期过关')
        if (software) assertRetainedSoftwareBehavior(projectId, 'gui', suite)
        installGuiAcceptanceSuite(projectId, suite)
        updateProject(projectId, { gui_acceptance: { status: 'sealed', scope_hash: scope } })
        return { output: `已登记当前目标的GUI操作与固定预期，尚未执行或判定通过。${software ? '程序就绪后调用verify_app，宿主会实际检查；通过后可结束，不必重复启动自测。' : ''}`, feedback: { schema_version: 1, execution: 'completed', verification: 'not_applicable', source: 'host', scope: 'gui_registration' } }
      } catch (error) { return guiInputFailure(error) }
    } }
}
