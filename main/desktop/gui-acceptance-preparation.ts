import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { callLlmForJson } from '../kernel/llm-call'
import { createRequestBudget } from '../platform/llm/request-budget'
import { consumeProjectAttempt } from '../platform/execution/project-attempts'
import { findProject, updateProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { uxDesignFingerprint, type UxDesign } from '../model/ux-design'
import { guiSuitePath, installGuiAcceptanceSuite, parseGuiSuite, type GuiAcceptanceSuite } from './gui-acceptance'
import type { SDKQuery } from '../orchestration/stages/orchestration-contracts'

/** Expectations are prepared from confirmed intent before implementation exists.
 * No source/file tools are available to this independent, bounded role. */
export async function prepareGuiAcceptance(input: { projectId: string; sessionId: string; query: SDKQuery; env: Record<string, string>; signal?: AbortSignal }): Promise<boolean> {
  const project = findProject(input.projectId)
  if (!project.gui_acceptance) return true // legacy projects keep their recorded protocol
  const backplane = readPrdBackplane(input.projectId), scope = prdScopeFingerprint(backplane)
  const path = guiSuitePath(input.projectId)
  const block = (reason: string) => {
    updateProject(input.projectId, { gui_acceptance: { status: 'unverified', scope_hash: scope, reason } })
    return false
  }
  try {
    input.signal?.throwIfAborted()
    if (!backplane.user_confirmed_at || project.ux_confirmation?.prd_fingerprint !== scope) return block('GUI_CONFIRMED_INTENT_MISSING')
    if (existsSync(path)) {
      const saved = parseGuiSuite(JSON.parse(readFileSync(path, 'utf8')))
      if (saved.scope_hash === scope) {
        updateProject(input.projectId, { gui_acceptance: { status: 'sealed', scope_hash: scope } }); return true
      }
    }
    const confirmed = JSON.parse(readFileSync(join(project.root_path, '00_UX/confirmed.json'), 'utf8')) as { design: UxDesign }
    const design = confirmed.design
    if (design.prd_fingerprint !== scope || uxDesignFingerprint(design) !== project.ux_confirmation.design_hash) return block('GUI_DESIGN_VERSION_CHANGED')
    const uiFeatures = [...new Set(design.interactions.map(item => item.feature_id))]
    if (!uiFeatures.length) return block('GUI_INTERACTIVE_SCOPE_MISSING')
    const allowance = consumeProjectAttempt(input.projectId, `gui-plan:${scope}`, 2)
    if (!allowance.allowed) return block('GUI_PREPARATION_ATTEMPTS_EXHAUSTED')
    const budget = createRequestBudget(input.env, { requests: 3, outputTokens: 8192, rmb: 1 })
    const query: SDKQuery = async function* (prompt, options) {
      yield* budget.wrap(input.query)(prompt, { ...options, accounting: { projectId: input.projectId, role: 'gui_acceptance_planner', scope: 'confirmed_intent_preparation' } })
    }
    const htmlPath = join(project.root_path, '00_UX/confirmed.html')
    const suite = await callLlmForJson({ query, env: input.env, sessionId: input.sessionId, maxTokens: 8192, temperature: 0,
      attempts: 2, timeoutMs: 120000, signal: input.signal,
      systemPrompt: '你是独立GUI验收规划者，只能依据已确认需求和UX制定固定业务预期，不读取实现源码，不运行或修改产品。输出JSON，包含covers、control_bindings:[{selector,description}]、acceptance_refs:{expect步骤id:[AC编号]}和steps。steps只允许fill(selector,value)、click(selector)、expect(selector,property为text/value/count，equals或contains字符串或nonempty:true三选一)、restart；每步唯一id。用真实业务输入和固定输出验证正常、边界、异常，必须覆盖给出的所有UI功能及其UX关联AC；至少一条正常业务链。可在restart后核对相同数据留存，但只有需求要求持久化才强加重启。选择器优先复用确认HTML；缺少稳定控件id时在control_bindings给出实现应遵守的明确控件身份。每个非restart步骤都必须有binding。文件业务可添加fixtures:[{path:"input/a.txt",text:"内容"}]作为独立测试输入（最多16个UTF-8小文件，只允许input/相对路径），fill/value和期望中的{{DATA_DIR}}由宿主替换为隔离目录，禁止引用用户真实目录。每个AC单独对应一个expect；每段至少一个expect，最多60步、4段。需求没有指定提示文案时用nonempty检查错误出现，不强加你编造的提示原文；明确的计算结果和持久化数据才使用equals。不得用测试自报PASS、页面存在或动态读取实际值作为预期；不得降低或扩展需求。示例步骤：{"id":"fill-name","kind":"fill","selector":"#name","value":"测试记录"}。',
      prompt: JSON.stringify({ requirements: backplane, design, confirmed_html: existsSync(htmlPath) ? readFileSync(htmlPath, 'utf8') : null, required_ui_features: uiFeatures }),
      parse: text => {
        const raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''))
        const value = parseGuiSuite({ ...raw, version: 1, scope_hash: scope })
        const known = new Set(backplane.requirements.map(item => item.id))
        if (uiFeatures.some(id => !value.covers.includes(id)) || value.covers.some(id => !known.has(id)) || !value.control_bindings?.length) return
        if (!value.steps.some(step => step.kind === 'fill' || step.kind === 'click')) return
        if (value.steps.some(step => step.kind !== 'restart' && !value.control_bindings!.some(binding => binding.selector === step.selector))) return
        const refs = value.acceptance_refs
        const required = design.interactions.flatMap(item => item.states.flatMap(state => state.scenario_ids))
        if (!refs || typeof refs !== 'object' || Array.isArray(refs) || Object.entries(refs).some(([id, ac]) => !value.steps.some(step => step.id === id && step.kind === 'expect')
          || !Array.isArray(ac) || ac.length !== 1 || ac.some(ref => !required.includes(ref))) || required.some(ref => !Object.values(refs).some(ids => ids.includes(ref)))) return
        return value
      } })
    input.signal?.throwIfAborted()
    if (!suite) return block('GUI_PREPARATION_INCOMPLETE')
    if (prdScopeFingerprint(readPrdBackplane(input.projectId)) !== scope || JSON.stringify(findProject(input.projectId).ux_confirmation) !== JSON.stringify(project.ux_confirmation)) return block('GUI_INTENT_CHANGED_DURING_PREPARATION')
    installGuiAcceptanceSuite(input.projectId, suite)
    updateProject(input.projectId, { gui_acceptance: { status: 'sealed', scope_hash: scope } })
    return true
  } catch (error) {
    if (input.signal?.aborted) throw error
    return block(error instanceof Error ? error.message.slice(0, 200) : 'GUI_PREPARATION_UNAVAILABLE')
  }
}
/** Only control identities are handed to the implementer; expected values stay
 * frozen in the host suite and cannot be rewritten through project tools. */
export function guiControlBindings(projectId: string): GuiAcceptanceSuite['control_bindings'] {
  const path = guiSuitePath(projectId)
  if (!existsSync(path)) return
  const suite = parseGuiSuite(JSON.parse(readFileSync(path, 'utf8')))
  if (suite.scope_hash !== prdScopeFingerprint(readPrdBackplane(projectId))) throw new Error('GUI_BINDINGS_SCOPE_STALE')
  return suite.control_bindings
}
