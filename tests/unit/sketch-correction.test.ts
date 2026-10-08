/**
 * 草图点选纠错（批11 ①，2026-10-08）测试：
 * - 注入器：body 前插入/无 body 容错/幂等防重复；
 * - 一步消化：UX 挂起态（未点卡）与等反馈态（已点卡）均消费 source=sketch_correction；
 *   非标记消息不拦；双态注册表正确清理。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../main/project/project-service', () => ({ findProject: vi.fn(), updateProject: vi.fn() }))
vi.mock('../../main/project/decision-log', () => ({ recordDecision: vi.fn() }))
vi.mock('../../main/delivery/preview-scheme', () => ({ mintProjectPreviewUrl: vi.fn(() => 'bloma-file://p1/00_UX/ux-sketch.html') }))
vi.mock('../../main/platform/llm/category-routing', () => ({
  resolveCategoryEnv: vi.fn(() => ({ env: {}, channel: { id: 'c1', name: 'x' } })),
}))

import { findProject } from '../../main/project/project-service'
import { injectSketchCorrector } from '../../main/guide/sketch-corrector'
import {
  resetUxConfirmForTests,
  seedUxConfirmForTests,
  seedUxAdjustWaitForTests,
  takeUxSketchCorrection,
} from '../../main/guide/ux-confirm'
import { stageUxSketch } from '../../main/guide/ux-sketch'
import type { AgentSendMessageInput } from '../../shared/types'

const mockedFindProject = vi.mocked(findProject)

let projectRoot: string

beforeEach(() => {
  vi.clearAllMocks()
  resetUxConfirmForTests()
  projectRoot = mkdtempSync(join(tmpdir(), 'bloma-sketch-corr-'))
  mockedFindProject.mockReturnValue({ project_id: 'p1', root_path: projectRoot } as never)
})

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true })
})

describe('injectSketchCorrector（草图点选层注入器）', () => {
  it('完整文档：注入 </body> 前，含标记条/面板/脚本', () => {
    const html = '<!DOCTYPE html><html><head><style>a{}</style></head><body><button>go</button></body></html>'
    const out = injectSketchCorrector(html)
    expect(out).toContain('bloma-sketch-corrector')
    expect(out).toContain('bloma-sk-bar')
    expect(out.indexOf('bloma-sketch-corrector')).toBeLessThan(out.lastIndexOf('</body>'))
  })

  it('幂等：已注入不重复；无 </body> 追加文档尾', () => {
    const once = injectSketchCorrector('<html><body>x</body></html>')
    expect(injectSketchCorrector(once)).toBe(once)
    const noBody = injectSketchCorrector('<html><div>x</div></html>')
    expect(noBody).toContain('bloma-sketch-corrector')
  })

  it('stageUxSketch 落盘含点选层（平台注入，非 LLM 产出）', async () => {
    const result = await stageUxSketch({ project_id: 'p1', html: '<!DOCTYPE html><html><body>草图</body></html>' })
    expect(result.preview_url).toContain('ux-sketch.html')
    const { readFileSync } = await import('node:fs')
    const saved = readFileSync(join(projectRoot, '00_UX', 'ux-sketch.html'), 'utf8')
    expect(saved).toContain('bloma-sketch-corrector')
  })
})

describe('takeUxSketchCorrection（一步消化：点选标记=有要调整的+意见）', () => {
  const makeInput = (source?: string): AgentSendMessageInput =>
    ({ request_id: 'r', session_id: 's', project_id: 'p1', content: '我在草图上标记了 2 处不满意的地方：…', mode: 'quick', current_stage: 'sketch_ready', ...(source ? { metadata: { source: source as 'sketch_correction' } } : {}) }) as never

  it('UX 挂起态（未点卡）：source=sketch_correction 消费并清理注册表', () => {
    seedUxConfirmForTests({ project_id: 'p1', session_id: 's', round: 1 })
    const taken = takeUxSketchCorrection(makeInput('sketch_correction'))
    expect(taken).toBeDefined()
    expect(taken!.feedback).toContain('标记了 2 处')
    expect(taken!.pending.round).toBe(1)
    // 消费后同消息不再命中
    expect(takeUxSketchCorrection(makeInput('sketch_correction'))).toBeUndefined()
  })

  it('等反馈态（已点有要调整的）：标记优先消费', () => {
    seedUxAdjustWaitForTests({ project_id: 'p1', session_id: 's', round: 2 })
    const taken = takeUxSketchCorrection(makeInput('sketch_correction'))
    expect(taken).toBeDefined()
    expect(taken!.pending.round).toBe(2)
  })

  it('非标记来源不拦（普通消息/卡选项照常走各自路径）', () => {
    seedUxConfirmForTests({ project_id: 'p1', session_id: 's', round: 1 })
    expect(takeUxSketchCorrection(makeInput('chat'))).toBeUndefined()
    expect(takeUxSketchCorrection(makeInput('card_option'))).toBeUndefined()
    expect(takeUxSketchCorrection(makeInput())).toBeUndefined()
  })

  it('无挂起会话：不消费（消息落普通对话流）', () => {
    expect(takeUxSketchCorrection(makeInput('sketch_correction'))).toBeUndefined()
  })
})
