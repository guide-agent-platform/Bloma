import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject } from '../../main/project/project-service'
import { generateUxVisualDesign } from '../../main/guide/ux-visual-pipeline'
import { generateUxSketch, type UxSketchOptions } from '../../main/guide/ux-sketch'
import { buildFallbackUxDesign, uxDesignIssues } from '../../main/model/ux-design'
import { organizedPrd } from '../support/organized-prd'
import { bindAcceptance } from '../../main/project/requirement-contract'
import { projectRequirementsModel } from '../../main/model/requirements-model'
import { restorePromaHome } from '../support/proma-home-guard'
import type { SDKQuery, SDKQueryOptions } from '../../main/orchestration/stages/orchestration-contracts'
import { renderUxStateReview } from '../../main/guide/ux-state-review'

describe('production UX visual pipeline', () => {
  const original = process.env.PROMA_HOME
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bloma-ux-visual-unit-')); process.env.PROMA_HOME = home })
  afterEach(() => { restorePromaHome(original); rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) })
  function setup(compare = true) {
    const project = createProject({ request_id: 'visual-test', mode: 'quick' })
    const organized = organizedPrd([{ id: 'F-001', description: '加一、减一、清零' }], '做计数器')
    const prd = projectRequirementsModel(bindAcceptance({ project_id: project.project_id, name: '计数器', positioning: '计数', ...organized, acceptance: {}, assumptions: [], out_of_scope: [] }))
    const calls: SDKQueryOptions[] = [], prompts: string[] = []
    const query: SDKQuery = async function* (prompt, options) {
      calls.push(options)
      prompts.push(prompt)
      let value: unknown
      if (prompt.includes('输出 {"directions"')) value = { directions: ['A', 'B'].map(id => ({ id, concept: id, composition: id + '构图', visual_language: '自主视觉' })) }
      else if (options.images) {
        if (prompt.startsWith('两图')) {
          const run = readdirSync(join(project.root_path!, '00_UX/exploration'))[0]!
          const rows = JSON.parse(readFileSync(join(project.root_path!, '00_UX/exploration', run, 'comparison-input.json'), 'utf8')).images
          value = compare ? { preferred: rows.find((row: any) => row.candidate === 'refined').label, observations: [{ region: '按钮', observation: '更清晰' }] } : 'not-json'
        } else value = { preferred: options.images.length > 1 ? 'Y' : 'X', observations: [{ region: '主界面', observation: '数字清晰' }], improvements: ['增加可选的长按连续计数，保留全部原始操作'] }
      } else {
        const id = prompt.includes('截图评审建议') ? 'refined' : prompt.includes('"id":"B"') ? 'B' : 'A'
        const design = buildFallbackUxDesign(prd); design.summary = id
        if (id === 'refined') design.enhancements = [{ id: 'E-001', name: '连续计数', description: '长按连续加减', benefit: '快速累计' }]
        value = { action: 'design', html: `<!DOCTYPE html><html><body><main data-page-id="P-001"><button data-interaction-id="UI-001">${id}</button></main></body></html>`, design }
      }
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: value === 'not-json' ? value : JSON.stringify(value) }] } }
      yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } }
    }
    const input: UxSketchOptions = { project_id: project.project_id, session_id: 'visual-test', query, env: {}, maxTokens: 640000, positioning: prd.positioning, requirements: prd.requirements, backplane: prd }
    const capture = vi.fn(async () => [1100, 820].map(width => ({ png: Buffer.from('isolated-test-png'), width, height: 800, contentWidth: width, contentHeight: 800 })))
    return { input, capture, calls, prompts, project, prd }
  }
  it('two real parser-validated drafts, image requests, one refinement; extras survive and summary identifies adopted version', async () => {
    const { input, capture, calls, project, prd } = setup()
    const result = await generateUxVisualDesign(input, { available: () => true, capture })
    expect(result.visual?.selected).toBe('refined')
    expect(result.visual?.budget?.max_requests).toBe(8)
    expect(uxDesignIssues(result.design!, prd)).toEqual([])
    expect(result.design?.enhancements?.[0]?.name).toBe('连续计数')
    expect(calls).toHaveLength(6)
    expect(calls.filter(call => call.images).map(call => call.images!.length)).toEqual([2, 2])
    expect(capture).toHaveBeenCalledTimes(3)
    expect(calls.every(call => (call.maxTokens ?? 0) <= 16384)).toBe(true)
    const summary = JSON.parse(readFileSync(join(project.root_path!, '00_UX/exploration', result.visual!.run_id, 'summary.json'), 'utf8'))
    expect(summary.selected).toBe('refined')
    expect(readdirSync(join(home, 'pasted-images'))).toEqual([])
  })
  it('experiment preparation can finish schema and HTML repairs within an explicit shared operation budget', async () => {
    vi.stubEnv('BLOMA_DISPATCH_EXPERIMENT', '1')
    vi.stubEnv('BLOMA_EXPERIMENT_MAX_OUTPUT_TOKENS', '640000')
    const { input, capture } = setup()
    const attempts: Array<number | undefined> = []
    try {
      const result = await generateUxVisualDesign(input, { available: () => true, capture,
        generate: async options => { attempts.push(options.attempts); return generateUxSketch(options) } })
      expect(attempts).toEqual([4, 4, 1])
      expect(result.visual?.budget?.max_requests).toBe(12)
      expect(result.visual?.budget?.max_output_tokens).toBe(640000)
    } finally { vi.unstubAllEnvs() }
  })
  it('unparseable comparison keeps selected original, never adopts an unreviewed revision', async () => {
    const { input, capture } = setup(false)
    const result = await generateUxVisualDesign(input, { available: () => true, capture })
    expect(result.design?.summary).toBe('B')
    expect(result.visual?.reasons).toContain('refinement_not_adopted_original_retained')
  })
  it('targeted user feedback remains explicit during visual refinement and does not re-plan two directions', async () => {
    const { input, capture, prompts } = setup()
    await generateUxVisualDesign({ ...input, feedback: '必须保留蓝色，并把按钮移到右边' }, { available: () => true, capture })
    expect(prompts.some(text => text.includes('输出 {"directions"'))).toBe(false)
    const refinement = prompts.find(text => text.includes('截图评审建议'))!
    expect(refinement).toContain('必须保留蓝色，并把按钮移到右边')
  })
  it('capture failure keeps validated draft and sends no pretend visual review', async () => {
    const { input, calls } = setup()
    const result = await generateUxVisualDesign(input, { available: () => true, capture: async () => { throw new Error('capture unavailable') } })
    expect(result.source).toBe('llm')
    expect(result.visual?.status).toBe('single')
    expect(calls.filter(call => call.images)).toHaveLength(0)
  })
  it('empty screenshots are not treated as rendered candidates', async () => {
    const { input, calls } = setup()
    const result = await generateUxVisualDesign(input, { available: () => true, capture: async () => [1100, 820].map(width => ({ png: Buffer.alloc(0), width, height: 800, contentWidth: width, contentHeight: 800 })) })
    expect(result.source).toBe('llm')
    expect(calls.filter(call => call.images)).toHaveLength(0)
  })
  it('an unavailable vision channel retains a valid design without inventing critique or a revision', async () => {
    const { input, capture } = setup(), originalQuery = input.query
    const imageCalls = vi.fn()
    input.query = async function* (prompt, options) {
      if (options.images) { imageCalls(); throw new Error('current channel does not support images') }
      yield* originalQuery(prompt, options)
    }
    const result = await generateUxVisualDesign(input, { available: () => true, capture })
    expect(result.visual?.selected).toBe('A')
    expect(result.visual?.reasons).toContain('visual_review_unavailable')
    expect(capture).toHaveBeenCalledTimes(2)
    expect(imageCalls).toHaveBeenCalledTimes(1)
  })
  it('user cancellation during capture propagates and cannot become a ready design', async () => {
    const { input } = setup(), abort = new AbortController()
    await expect(generateUxVisualDesign({ ...input, signal: abort.signal }, { available: () => true, capture: async () => { abort.abort(); throw new Error('stopped') } })).rejects.toThrow()
  })
  it('without renderer retains the single-generation compatibility path', async () => {
    const { input, calls } = setup()
    const result = await generateUxVisualDesign(input, { available: () => false })
    expect(result.visual).toBeUndefined()
    expect(calls).toHaveLength(1)
  })
  it('missing original scenarios still reject a design despite valuable enhancements; review HTML escapes model text', () => {
    const { prd } = setup(), design = buildFallbackUxDesign(prd)
    design.enhancements = [{ id: 'E-001', name: '<script>extra</script>', description: '<img onerror=x>', benefit: 'useful' }]
    design.interactions[0]!.states.pop()
    expect(uxDesignIssues(design, prd)).toContain('验收场景未说明对应的界面状态或非界面职责：AC-003')
    const review = renderUxStateReview(design)
    expect(review).toContain('&lt;script&gt;extra&lt;/script&gt;')
    expect(review).not.toContain('<script>')
  })
})
