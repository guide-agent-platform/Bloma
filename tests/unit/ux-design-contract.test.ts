import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { organizedPrd } from '../support/organized-prd'
import { restorePromaHome } from '../support/proma-home-guard'
import { createProject } from '../../main/project/project-service'
import { syncDocuments, markPrdUserConfirmed, readPrdBackplane } from '../../main/project/document-engine'
import { bindAcceptance, prdScopeFingerprint } from '../../main/project/requirement-contract'
import { projectRequirementsModel } from '../../main/model/requirements-model'
import { uxDesignIssues, parseUxDesign, type UxDesign } from '../../main/model/ux-design'
import { generateUxSketch } from '../../main/guide/ux-sketch'
import { readConfirmedUxBinding } from '../../main/project/ux-binding'
import { runUxConfirmGate, startUxAdjustAwait, takeUxAdjustFeedback, runUxAdjustRound, resumeUxConfirmConfirmed, tryResumeUxAdjustAsConfirm, isUxResumeIntent, consumeUxPauseIntent, resetUxConfirmForTests, UX_SKETCH_ADJUST_LIMIT, retryUxSketch, clearUxConfirmationMemoryForTests, restoreUxConfirmation } from '../../main/guide/ux-confirm'
import type { SDKQuery } from '../../main/orchestration/orchestrator'

vi.mock('../../main/desktop/desktop-route', () => ({ enterDesktopLine: vi.fn(async () => true), DESKTOP_LINE_TEMPLATE_TYPES: new Set(['desktop_tool', 'game']) }))
// Isolate reusable full-schema UX validation/storage from workflow admission.
// Real retirement policy is exercised without this mock in workflow-retirement.test.ts.
vi.mock('../../main/desktop/workflow-retirement',()=>({workflowRetirementReason:()=>undefined}))
vi.mock('../../main/delivery/preview-scheme', () => ({ mintProjectPreviewUrl: vi.fn((id, path) => `bloma-file://${id}/${path}`) }))

import { enterDesktopLine } from '../../main/desktop/desktop-route'

import { mintProjectPreviewUrl } from '../../main/delivery/preview-scheme'
import { createHash } from 'node:crypto'
import * as routing from '../../main/platform/llm/runtime-fallback'

describe('UX 设计、确认与真实存储边界', () => {
  const originalHome = process.env.PROMA_HOME
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bloma-ux-contract-')); process.env.PROMA_HOME = home; vi.clearAllMocks(); resetUxConfirmForTests() })
  afterEach(() => { resetUxConfirmForTests(); restorePromaHome(originalHome); rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) })
  function setup(signal?: AbortSignal) {
    const project = createProject({ request_id: 'r', mode: 'longterm' })
    const organized = organizedPrd([{ id: 'F-001', description: '计算材料用量' }], '用量总和等于批次总量')
    const prd = projectRequirementsModel(bindAcceptance({ project_id: project.project_id, name: '配方', positioning: '工艺配方计算', requirements: organized.requirements,
      requirements_model: organized.requirements_model, acceptance: {}, assumptions: [], out_of_scope: [] }))
    syncDocuments({ request_id: 'r', project_id: project.project_id, session_id: 's', checkpoint: 'requirement_confirmed' }, prd)
    expect(markPrdUserConfirmed(project.project_id)).toBeTruthy()
    const design: UxDesign = { version: 1, prd_fingerprint: prdScopeFingerprint(prd), summary: '左侧输入参数，右侧显示用量；失败提示原因并保留输入。',
      pages: [{ id: 'P-001', name: '配方计算', purpose: '输入与查看材料用量', feature_ids: ['F-001'] }],
      flows: [{ workflow_id: 'W-001', page_ids: ['P-001'] }], interactions: [{ id: 'UI-001', feature_id: 'F-001', page_id: 'P-001', action: '输入配方并点击计算', states: [
        { kind: 'normal', observable: '显示各材料用量与合计', scenario_ids: ['AC-001'] }, { kind: 'boundary', observable: '空输入提示内容且不提交', scenario_ids: ['AC-002'] },
        { kind: 'exception', observable: '失败显示原因，保留输入', scenario_ids: ['AC-003'] },
      ] }], non_ui_features: [] }
    const html = '<!DOCTYPE html><html><body><section data-page-id="P-001"><button data-interaction-id="UI-001">计算</button><p>显示用量</p></section></body></html>'
    const calls: string[] = []
    const query: SDKQuery = async function* (prompt) { calls.push(prompt); yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ action: 'design', design, html }) }] } } }
    const events: any[] = []
    const pending = { project_id: project.project_id, session_id: 's', request_id: 'r', mode: 'longterm' as const, query, env: {}, signal, publish: (event: any) => events.push(event), round: 1, positioning: prd.positioning, requirements: prd.requirements }
    return { project, prd, design, html, calls, query, events, pending }
  }
  it('gives the authoritative feature and kind when a model misbinds a scenario', () => {
    const { prd, design } = setup()
    design.interactions[0].states[0].scenario_ids = ['AC-002']
    const issues = uxDesignIssues(design, prd)
    expect(issues).toContain('场景 AC-002 与功能/状态类型不一致')
    expect(issues.join('\n')).toContain('AC-002 的PRD绑定为 feature_id=F-001, kind=boundary')
    expect(issues.join('\n')).toContain('补齐 AC-001 的 feature_id=F-001, kind=normal')
  })
  it('requires full HTML after a metadata repair adds a missing interaction marker', async () => {
    const { pending, prd, design, html } = setup()
    const expanded = structuredClone(design)
    expanded.interactions.push({ ...structuredClone(expanded.interactions[0]), id: 'UI-002' })
    expanded.interactions.push({ ...structuredClone(expanded.interactions[0]), id: 'UI-003' })
    const bad = structuredClone(design)
    bad.interactions[0].states[0].scenario_ids = ['AC-002']
    let calls = 0
    const query: SDKQuery = async function* (prompt) {
      calls++
      if (calls === 3) {
        expect(prompt).toContain('本次必须同时输出完整html')
        expect(prompt).toContain('HTML 未呈现交互 UI-002')
        expect(prompt).toContain('HTML 未呈现交互 UI-003')
      }
      const value = calls === 1 ? { action: 'design', html, design: bad }
        : calls === 2 ? { action: 'design', design: expanded }
        : { action: 'design', design: expanded, html: html.replace('</section>', '<button data-interaction-id="UI-002">查看结果</button><button data-interaction-id="UI-003">再次查看</button></section>') }
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(value) }] } }
    }
    const result = await generateUxSketch({ ...pending, backplane: prd, query, attempts: 3, maxTokens: 2000 })
    expect(calls).toBe(3)
    expect(result.source).toBe('llm')
    expect(result.html).toContain('data-interaction-id="UI-002"')
  })

  it('完整PRD进入模型；没有摘要也传反馈，有底稿时传上一版HTML与设计', async () => {
    const { pending, calls } = setup()
    await runUxConfirmGate(pending)
    startUxAdjustAwait({ project_id: pending.project_id } as never)
    const feedback = '按钮太挤，请把结果区放在右侧'
    const taken = takeUxAdjustFeedback({ project_id: pending.project_id, content: feedback } as never)!
    await runUxAdjustRound({ project_id: pending.project_id } as never, taken)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('requirements_model')
    expect(calls[0]).toContain('AC-003')
    expect(calls[1]).toContain(feedback)
    expect(calls[1]).toContain('data-interaction-id')
    expect(calls[1]).toContain('上一版设计记录')
  })

  it('关联修订复用安全候选，不丢视觉稿；通过前不写确认文件', async () => {
    const { pending, prd, design, html, project } = setup()
    const broken = structuredClone(design)
    broken.interactions[0]!.states.pop()
    const prompts: string[] = []
    let attempt = 0
    const query: SDKQuery = async function* (prompt) {
      prompts.push(prompt)
      expect(existsSync(join(project.root_path!, '00_UX/confirmed.html'))).toBe(false)
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(attempt++
        ? { action: 'design', design } : { action: 'design', design: broken, html }) }] } }
    }
    const result = await generateUxSketch({ ...pending, backplane: prd, query, maxTokens: 2000 })
    expect(result.source).toBe('llm')
    expect(result.html).toBe(html)
    expect(result.design).toEqual(design)
    expect(prompts[1]).toContain('本次只输出action与design，不要重发html')
    const dir = join(home, 'agent-workspaces', project.workspace_slug, 'documents', project.project_id, 'diagnostics')
    const rows = readFileSync(join(dir, 'ux-design-attempts.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rows.filter(row => row.event === 'output_checked').map(row => row.accepted_for_preview)).toEqual([false, true])
    expect(rows.find(row => row.reused_candidate)?.accepted_for_preview).toBe(true)
    const files = readdirSync(dir).filter(name => name.startsWith('ux-candidate-'))
    expect(files).toHaveLength(1)
    expect(readFileSync(join(dir, files[0]!), 'utf8')).toBe(html)
    expect(existsSync(join(project.root_path!, '00_UX/confirmed.html'))).toBe(false)
  })

  it.each(['unsafe', 'still-invalid'])('候选复用不能绕过脚本或需求覆盖校验：%s', async mode => {
    const { pending, prd, design, html } = setup()
    const broken = structuredClone(design)
    broken.interactions[0]!.states.pop()
    let attempt = 0
    const query: SDKQuery = async function* () {
      const text = attempt++ ? { action: 'design', design: mode === 'unsafe' ? design : broken }
        : { action: 'design', design: broken, html: mode === 'unsafe' ? html.replace('</body>', '<script>bad()</script></body>') : html }
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(text) }] } }
    }
    await expect(generateUxSketch({ ...pending, backplane: prd, query, maxTokens: 2000 })).rejects.toThrow('UX_DESIGN_FAILED')
  })

  it('结构化调用只有JSON协议，记录同一次读取的覆盖哈希和白名单运行元数据', async () => {
    const { pending, prd, design, html, project } = setup()
    mkdirSync(join(home, 'prompts'), { recursive: true })
    const override = '使用独立杂志的排版风格'
    writeFileSync(join(home, 'prompts/sketch-system.md'), override)
    let system = '', user = ''
    const query: SDKQuery = async function* (prompt, options) {
      user = prompt
      system = String(options.history?.[0]?.content)
      // A settings edit during generation must not change the recorded request source.
      writeFileSync(join(home, 'prompts/sketch-system.md'), '下次请求的偏好')
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ action: 'design', design, html }) }] } }
    }
    await generateUxSketch({ ...pending, backplane: prd, query, maxTokens: 2000,
      env: { ANTHROPIC_MODEL: 'local-test', ANTHROPIC_API_KEY: 'secret-never-export', EXTRA_SECRET: 'private-value' } })
    expect(system).toContain('只输出JSON')
    expect(system + user).not.toContain('只输出 HTML 本身')
    expect(user).toContain('验收关联索引')
    const log = readFileSync(join(home, 'agent-workspaces', project.workspace_slug, 'documents', project.project_id, 'diagnostics/ux-design-attempts.jsonl'), 'utf8')
    expect(log).not.toContain('secret-never-export')
    expect(log).not.toContain('private-value')
    const row = JSON.parse(log.split('\n')[0]!)
    expect(row.prompt_source).toMatchObject({ source: 'local_override', sha256: createHash('sha256').update(override).digest('hex') })
    expect(row.system_prompt_sha256).toBe(createHash('sha256').update(system).digest('hex'))
    expect(row.requested_model).toBe('local-test')
  })

  it('UX门解析sketch路由并把对应环境送入请求', async () => {
    const { pending } = setup()
    const spy = vi.spyOn(routing, 'resolveChannelEnv').mockReturnValue({ env: { ANTHROPIC_MODEL: 'design-model' } })
    let model: string | undefined
    const query: SDKQuery = async function* (prompt, options) {
      model = options.env.ANTHROPIC_MODEL
      yield* pending.query(prompt, options)
    }
    try {
      await runUxConfirmGate({ ...pending, query })
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ category: 'sketch', projectId: pending.project_id }))
      expect(model).toBe('design-model')
    } finally { spy.mockRestore() }
  })

  it('错误编号、遗漏场景和空设计不能作为完整设计', () => {
    const { prd, design } = setup()
    design.interactions[0]!.states.pop()
    expect(uxDesignIssues(design, prd)).toContain('验收场景未说明对应的界面状态或非界面职责：AC-003')
    design.pages[0]!.feature_ids.push('F-999')
    expect(parseUxDesign(design, prd)).toBeUndefined()
  })

  it('PRD明确豁免的场景不要求虚构UI；恢复为适用场景后仍检查遗漏', () => {
    const { prd, design } = setup()
    const scenario = prd.requirements_model!.scenarios.find(row => row.id === 'AC-003')!
    scenario.not_applicable = '本地内存计算不访问网络、文件或外部设备，没有需要本产品展示的外部依赖失败流程。'
    delete scenario.given; delete scenario.when; delete scenario.then
    design.prd_fingerprint = prdScopeFingerprint(prd)
    design.interactions[0]!.states = design.interactions[0]!.states.filter(row => row.kind !== 'exception')
    expect(uxDesignIssues(design, prd)).toEqual([])
    delete scenario.not_applicable
    Object.assign(scenario, { given: '计算失败', when: '执行计算', then: '展示失败原因' })
    design.prd_fingerprint = prdScopeFingerprint(prd)
    expect(uxDesignIssues(design, prd)).toContain('验收场景未说明对应的界面状态或非界面职责：AC-003')
    design.interactions[0]!.states = []
    expect(uxDesignIssues(design, prd)).not.toEqual([])
  })

  it('仅在注释中声称页面/交互存在不能通过视图关联检查', async () => {
    const { pending, prd, design } = setup()
    const query: SDKQuery = async function* () { yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ action: 'design', design,
      html: '<!DOCTYPE html><html><body>没有实际对应区域<!-- data-page-id="P-001" data-interaction-id="UI-001" --></body></html>' }) }] } } }
    await expect(generateUxSketch({ ...pending, backplane: prd, query, maxTokens: 1000 })).rejects.toThrow('UX_DESIGN_FAILED')
  })

  it.each(['不要开工', '取消开工', '继续改，不要开始', '不确认，先调整', '不要按草图'])('否定确认“%s”不进入桌面流程', async text => {
    const { pending } = setup()
    await runUxConfirmGate(pending); startUxAdjustAwait({ project_id: pending.project_id } as never)
    expect(isUxResumeIntent(text)).toBe(false)
    expect(await tryResumeUxAdjustAsConfirm({ project_id: pending.project_id, content: text } as never, true)).toBe(false)
    expect(enterDesktopLine).not.toHaveBeenCalled()
  })
  it.each(['按草图开工', '不需要调整，可以开工', '不用再改，按草图开工'])('明确认可“%s”不被否定词子串误伤', text => {
    expect(isUxResumeIntent(text)).toBe(true)
  })

  it('明确暂停保留当前设计；上限到达不发开工授权', async () => {
    const { pending, events } = setup()
    await runUxConfirmGate(pending)
    expect(consumeUxPauseIntent({ project_id: pending.project_id, content: '不要开工' } as never)).toBe(true)
    startUxAdjustAwait({ project_id: pending.project_id } as never)
    const taken = takeUxAdjustFeedback({ project_id: pending.project_id, content: '按钮太挤' } as never)!
    await runUxAdjustRound({ project_id: pending.project_id } as never, { ...taken, pending: { ...taken.pending, round: UX_SKETCH_ADJUST_LIMIT } })
    expect(enterDesktopLine).not.toHaveBeenCalled()
    expect(events.some(event => String(event.payload.text).includes('本次没有开工'))).toBe(true)
  })

  it('停止后不生成/落盘/出卡，确认后的交接保留同一取消信号', async () => {
    const controller = new AbortController(), { pending, project, events } = setup(controller.signal)
    controller.abort()
    await runUxConfirmGate(pending)
    expect(events).toHaveLength(0)
    expect(existsSync(join(project.root_path, '00_UX/ux-sketch.html'))).toBe(false)
    const active = setup(new AbortController().signal)
    await runUxConfirmGate(active.pending)
    await resumeUxConfirmConfirmed({ project_id: active.pending.project_id, content: '确认草图' } as never)
    expect(vi.mocked(enterDesktopLine).mock.calls[0]![0].signal).toBe(active.pending.signal)
  })

  it('需求修订后旧确认被拒绝；篡改草图和生成目录中的凭据也不能获得新确认', async () => {
    const data = setup()
    await runUxConfirmGate(data.pending)
    await resumeUxConfirmConfirmed({ project_id: data.pending.project_id, content: '确认' } as never)
    expect(readConfirmedUxBinding(data.project.project_id, readPrdBackplane(data.project.project_id))?.design_path).toBe('00_UX/confirmed.json')
    const metaPath = join(data.project.root_path, '00_UX/confirmed.json'), metadata = JSON.parse(readFileSync(metaPath, 'utf8'))
    metadata.mode = 'text'; writeFileSync(metaPath, JSON.stringify(metadata))
    expect(() => readConfirmedUxBinding(data.project.project_id, readPrdBackplane(data.project.project_id))).toThrow('文字版本不能保留HTML')
    delete metadata.mode
    metadata.design.summary = '不同的设计'; writeFileSync(metaPath, JSON.stringify(metadata))
    expect(() => readConfirmedUxBinding(data.project.project_id, readPrdBackplane(data.project.project_id))).toThrow('确认凭据不匹配')
    const next = setup(); await runUxConfirmGate(next.pending)
    next.prd.requirements_model!.goal += '（已改范围）'
    syncDocuments({ request_id: 'changed', project_id: next.project.project_id, session_id: 's', checkpoint: 'requirement_confirmed' }, next.prd)
    vi.mocked(enterDesktopLine).mockClear()
    await resumeUxConfirmConfirmed({ project_id: next.pending.project_id, content: '确认' } as never)
    expect(enterDesktopLine).not.toHaveBeenCalled()
  })

  it('预览失败不产生文字确认；恢复后重试复用已生成设计，不再花模型调用', async () => {
    const { pending, project, events, calls, query } = setup()
    vi.mocked(mintProjectPreviewUrl).mockImplementationOnce(() => { throw new Error('preview unavailable') })
    await runUxConfirmGate(pending)
    expect(events.some(event => event.type === 'ux_sketch_ready')).toBe(false)
    expect(events.some(event => event.type === 'message_delta' && String(event.payload.text).includes('失败'))).toBe(true)
    await resumeUxConfirmConfirmed({ project_id: pending.project_id, content: '确认' } as never)
    expect(enterDesktopLine).not.toHaveBeenCalled()
    expect(() => readConfirmedUxBinding(project.project_id, readPrdBackplane(project.project_id))).toThrow('UX_CONFIRMATION_MISSING')
    expect(calls).toHaveLength(1)
    clearUxConfirmationMemoryForTests()
    expect(restoreUxConfirmation({ project_id: pending.project_id, session_id: 's' } as never, pending.publish,
      { query, env: {} })).toBe(true)
    await retryUxSketch({ project_id: pending.project_id, request_id: 'retry' } as never)
    expect(calls).toHaveLength(1)
    expect(events.some(event => event.type === 'ux_sketch_ready')).toBe(true)
    expect(events.filter(event => event.type === 'user_decision_required').at(-1)?.payload.title).toBe('请确认界面草图')
  })

  it('HTML完整而设计JSON被截断时保留视图，下一轮只补记录且仍要求完整覆盖', async () => {
    const { pending, prd, html, design, project } = setup()
    const prompts: string[] = []
    const query: SDKQuery = async function* (prompt) {
      prompts.push(prompt)
      const raw = prompts.length === 1 ? `{"action":"design","html":${JSON.stringify(html)},"design":{"interactions":[{"id":"UI-001"`
        : JSON.stringify({ action: 'design', design })
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: raw }] } }
      yield { type: 'result', stop_reason: prompts.length === 1 ? 'max_tokens' : 'end_turn' }
    }
    const result = await generateUxSketch({ ...pending, backplane: prd, query, maxTokens: 2000 })
    expect(result.html).toBe(html)
    expect(uxDesignIssues(result.design!, prd)).toEqual([])
    expect(prompts[1]).toContain('本次只输出action与design，不要重发html')
    expect(existsSync(join(project.root_path!, '00_UX/confirmed.html'))).toBe(false)
  })

  it('预览失败后提出新意见，必须重新生成处理意见，不能仅重发旧预览', async () => {
    const { pending, calls } = setup()
    vi.mocked(mintProjectPreviewUrl).mockImplementationOnce(() => { throw new Error('preview unavailable') })
    await runUxConfirmGate(pending)
    startUxAdjustAwait({ project_id: pending.project_id } as never)
    const input = { project_id: pending.project_id, content: '把结果区移动到左侧' } as never
    const feedback = takeUxAdjustFeedback(input)!
    await runUxAdjustRound(input, feedback)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('把结果区移动到左侧')
  })

  it('HTML字符串本身截断时不能把残片当作可复用视图', async () => {
    const { pending, prd, html, design } = setup()
    let calls = 0
    const query: SDKQuery = async function* (prompt) {
      calls++
      if (calls === 2) expect(prompt).toContain('没有可复用的安全HTML')
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: calls === 1
        ? `{"action":"design","html":${JSON.stringify(html).slice(0, -12)}` : JSON.stringify({ action: 'design', design }) }] } }
    }
    await expect(generateUxSketch({ ...pending, backplane: prd, query, maxTokens: 2000 })).rejects.toThrow('UX_DESIGN_FAILED')
  })


  it('失败的调整意见在重试时仍传入，不能被“重试”两个字替换', async () => {
    const { pending, calls } = setup()
    await runUxConfirmGate(pending)
    startUxAdjustAwait({ project_id: pending.project_id } as never)
    const feedback = '把结果区放到右侧，输入区放到左侧'
    const taken = takeUxAdjustFeedback({ project_id: pending.project_id, content: feedback } as never)!
    const failed: SDKQuery = async function* () { throw new Error('offline model failure') }
    await runUxAdjustRound({ project_id: pending.project_id } as never, { ...taken, pending: { ...taken.pending, query: failed } })
    startUxAdjustAwait({ project_id: pending.project_id } as never)
    const retry = takeUxAdjustFeedback({ project_id: pending.project_id, content: '重试' } as never)!
    await runUxAdjustRound({ project_id: pending.project_id } as never, { ...retry, pending: { ...retry.pending, query: pending.query, adjustmentLimit: 4 } })
    expect(calls.at(-1)).toContain(feedback)
    expect(enterDesktopLine).not.toHaveBeenCalled()
  })
})
