import { restorePromaHome } from '../support/proma-home-guard'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { registerUxContract, type MvpTaskInput } from '../../main/coding/programming-orchestrator'
import { readPrdBackplane, readUxContractSketch, syncDocuments } from '../../main/document-engine'
import { createProject, findProject, updateProject } from '../../main/project-service'
import { getDocumentsDir } from '../../storage/config-paths'

/**
 * UX 契约质量门（§4.2 草图升格为 UX 契约，2026-08-17 设计 M2）：
 * - 登记条件 = 用户确认（sketch_confirmed 检查点本身）+ 非模板回退（project.sketch_source==='llm'）；
 * - 通过 → 草图（磁盘 index.html，此刻 MVP 尚未生成）复制进 documents 冻结为 sketch.html；
 * - 模板回退 → ux_contract 为空，MVP 退回 PRD-only；
 * - 迭代重跑（草图未再生成）→ 沿用既有契约（磁盘 index.html 已是 MVP，不能当草图）；
 * - 草图重生成后再次确认 → 契约刷新为新草图。
 */
describe('UX 契约登记（registerUxContract 质量门）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  function setup(sketchSource: 'llm' | 'template', sketchHtml: string): { project: ReturnType<typeof createProject>; input: MvpTaskInput } {
    const home = mkdtempSync(join(tmpdir(), 'proma-ux-contract-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    // 草图生成时刻的持久化（runSketchTask 落的 sketch_source/sketch_generated_at）
    updateProject(project.project_id, { sketch_source: sketchSource, sketch_generated_at: new Date().toISOString() })
    writeFileSync(join(project.root_path, 'index.html'), sketchHtml, 'utf8')
    const input: MvpTaskInput = {
      request_id: 'req-mvp',
      session_id: 'session-1',
      project_id: project.project_id,
      mode: 'quick',
    }
    return { project, input }
  }

  const SKETCH_V1 = '<!doctype html><html><head><style>.race-track{width:100%}</style></head><body><div class="race-track">V1</div></body></html>'
  const SKETCH_V2 = '<!doctype html><html><head><style>.race-track{width:100%}</style></head><body><div class="race-track">V2</div></body></html>'

  it('LLM 草图 + 用户确认 → 登记契约：草图复制进 documents，prd.json 带 ux_contract', () => {
    const { project, input } = setup('llm', SKETCH_V1)
    const backplane = registerUxContract(input, readPrdBackplane(project.project_id))
    // 再走真实写盘路径（syncPrdCheckpoints 同款调用），验证契约落进 prd.json
    syncDocuments({ request_id: 'req-mvp', session_id: 'session-1', project_id: project.project_id, checkpoint: 'sketch_confirmed' }, backplane)

    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    expect(existsSync(join(dir, 'sketch.html'))).toBe(true)
    const persisted = readPrdBackplane(project.project_id)
    expect(persisted.ux_contract?.sketch_rel_path).toBe('sketch.html')
    expect(persisted.ux_contract?.confirmed_at).toBeTruthy()
    // 草图全文可读（MVP 生成的双契约输入）
    expect(readUxContractSketch(project.project_id, persisted)).toBe(SKETCH_V1)
  })

  it('模板回退草图 → 质量门不通过：ux_contract 为空，MVP 退回 PRD-only', () => {
    const { project, input } = setup('template', SKETCH_V1)
    const backplane = registerUxContract(input, readPrdBackplane(project.project_id))
    expect(backplane.ux_contract).toBeUndefined()
    expect(readUxContractSketch(project.project_id, backplane)).toBeUndefined()
  })

  it('迭代重跑（草图未再生成）→ 沿用既有契约，不把磁盘上的 MVP 当草图复制', () => {
    const { project, input } = setup('llm', SKETCH_V1)
    const first = registerUxContract(input, readPrdBackplane(project.project_id))
    syncDocuments({ request_id: 'req-mvp', session_id: 'session-1', project_id: project.project_id, checkpoint: 'sketch_confirmed' }, first)

    // MVP 已生成覆盖磁盘 index.html（内容是 MVP 不是草图）
    writeFileSync(join(project.root_path, 'index.html'), '<!doctype html><html><body>MVP OUTPUT</body></html>', 'utf8')
    const second = registerUxContract(input, readPrdBackplane(project.project_id))
    expect(second.ux_contract?.confirmed_at).toBe(first.ux_contract?.confirmed_at)
    // 契约草图仍是 V1（未被 MVP 输出污染）
    expect(readUxContractSketch(project.project_id, second)).toBe(SKETCH_V1)
  })

  it('草图重生成后再次确认 → 契约刷新为新草图（覆盖旧契约文件）', () => {
    const { project, input } = setup('llm', SKETCH_V1)
    const first = registerUxContract(input, readPrdBackplane(project.project_id))
    syncDocuments({ request_id: 'req-mvp', session_id: 'session-1', project_id: project.project_id, checkpoint: 'sketch_confirmed' }, first)

    // 用户在 sketch_ready 提修改意见 → 草图重生成（runSketchTask 更新来源与时间戳；
    // +1s 保证严格晚于首次确认，规避同毫秒时间戳的边界歧义）
    writeFileSync(join(project.root_path, 'index.html'), SKETCH_V2, 'utf8')
    updateProject(project.project_id, { sketch_source: 'llm', sketch_generated_at: new Date(Date.now() + 1000).toISOString() })
    const second = registerUxContract(input, readPrdBackplane(project.project_id))
    expect(second.ux_contract).toBeDefined()
    expect(second.ux_contract?.confirmed_at).not.toBe(first.ux_contract?.confirmed_at)
    expect(readUxContractSketch(project.project_id, second)).toBe(SKETCH_V2)
  })

  it('草图重生成但落了模板回退 → 既有契约作废（质量门对新一轮确认重新判定）', () => {
    const { project, input } = setup('llm', SKETCH_V1)
    const first = registerUxContract(input, readPrdBackplane(project.project_id))
    syncDocuments({ request_id: 'req-mvp', session_id: 'session-1', project_id: project.project_id, checkpoint: 'sketch_confirmed' }, first)

    writeFileSync(join(project.root_path, 'index.html'), SKETCH_V2, 'utf8')
    updateProject(project.project_id, { sketch_source: 'template', sketch_generated_at: new Date(Date.now() + 1000).toISOString() })
    const second = registerUxContract(input, readPrdBackplane(project.project_id))
    expect(second.ux_contract).toBeUndefined()
  })

  it('readUxContractSketch 路径安全：契约路径越出 documents 目录时拒绝（不越权读任意文件）', () => {
    const { project } = setup('llm', SKETCH_V1)
    const dir = getDocumentsDir(project.workspace_slug, project.project_id)
    syncDocuments(
      { request_id: 'req-mvp', session_id: 'session-1', project_id: project.project_id, checkpoint: 'sketch_confirmed' },
      {
        ...readPrdBackplane(project.project_id),
        ux_contract: { sketch_rel_path: '../../projects.json', confirmed_at: new Date().toISOString() },
      },
    )
    expect(() => readUxContractSketch(project.project_id)).toThrow('DOCUMENT_PATH_SAFETY')
    // findProject 仍可读（项目索引未被破坏），仅契约读取被拒
    expect(findProject(project.project_id).project_id).toBe(project.project_id)
  })
})
