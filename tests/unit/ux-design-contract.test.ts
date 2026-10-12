import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
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
import { runUxConfirmGate, startUxAdjustAwait, takeUxAdjustFeedback, runUxAdjustRound, resumeUxConfirmConfirmed, tryResumeUxAdjustAsConfirm, isUxResumeIntent, consumeUxPauseIntent, resetUxConfirmForTests, UX_SKETCH_ADJUST_LIMIT } from '../../main/guide/ux-confirm'
import type { SDKQuery } from '../../main/orchestration/orchestrator'

vi.mock('../../main/desktop/desktop-route', () => ({ enterDesktopLine: vi.fn(async () => true), DESKTOP_LINE_TEMPLATE_TYPES: new Set(['desktop_tool', 'game']) }))
vi.mock('../../main/delivery/preview-scheme', () => ({ mintProjectPreviewUrl: vi.fn((id, path) => `bloma-file://${id}/${path}`) }))
vi.mock('../../main/guide/stages/prd-pipeline', () => ({ runPrdPipeline: vi.fn(async () => ({ started: true, prd_written: true })) }))
import { enterDesktopLine } from '../../main/desktop/desktop-route'
import { runPrdPipeline } from '../../main/guide/stages/prd-pipeline'
import { mintProjectPreviewUrl } from '../../main/delivery/preview-scheme'

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

  it('错误编号、遗漏场景和空设计不能作为完整设计', () => {
    const { prd, design } = setup()
    design.interactions[0]!.states.pop()
    expect(uxDesignIssues(design, prd)).toContain('验收场景未说明对应的界面状态或非界面职责：AC-003')
    design.pages[0]!.feature_ids.push('F-999')
    expect(parseUxDesign(design, prd)).toBeUndefined()
  })

  it('仅在注释中声称页面/交互存在不能通过视图关联检查', async () => {
    const { pending, prd, design } = setup()
    const query: SDKQuery = async function* () { yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ action: 'design', design,
      html: '<!DOCTYPE html><html><body>没有实际对应区域<!-- data-page-id="P-001" data-interaction-id="UI-001" --></body></html>' }) }] } } }
    const result = await generateUxSketch({ ...pending, backplane: prd, query, maxTokens: 1000 })
    expect(result.source).toBe('template')
    expect(result.html).toContain('<section class="req" data-interaction-id="UI-001"')
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

  it('预览失效显示真实文字方案并绑定文字版本，不沿用旧HTML', async () => {
    const { pending, project, events } = setup()
    vi.mocked(mintProjectPreviewUrl).mockImplementationOnce(() => { throw new Error('preview unavailable') })
    await runUxConfirmGate(pending)
    expect(events.some(event => String(event.payload.text).includes('左侧输入参数'))).toBe(true)
    await resumeUxConfirmConfirmed({ project_id: pending.project_id, content: '确认' } as never)
    expect(readConfirmedUxBinding(project.project_id, readPrdBackplane(project.project_id))?.html_path).toBeUndefined()
  })

  it('业务范围反馈回PRD，不把新功能藏进草图', async () => {
    const { pending } = setup()
    await runUxConfirmGate(pending)
    startUxAdjustAwait({ project_id: pending.project_id } as never)
    const feedback = '加一个导出Excel的功能', taken = takeUxAdjustFeedback({ project_id: pending.project_id, content: feedback } as never)!
    const query: SDKQuery = async function* () { yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '{"action":"revise_requirements","reason":"新增导出能力"}' }] } } }
    await runUxAdjustRound({ project_id: pending.project_id } as never, { ...taken, pending: { ...taken.pending, query } })
    expect(runPrdPipeline).toHaveBeenCalledTimes(1)
    expect(enterDesktopLine).not.toHaveBeenCalled()
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
