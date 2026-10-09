/**
 * UX 外观草图生成测试（2026-10-04 确认门新规）。
 *
 * mock 面：kernel/llm-call（可控输出/失败）；delivery/sandbox（runSandbox 桩）；
 * project-service（模板兜底与落盘路径）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../main/kernel/llm-call', () => ({
  callLlmForJson: vi.fn(),
}))

vi.mock('../../../main/delivery/preview-scheme', () => ({
  mintProjectPreviewUrl: vi.fn(),
}))

vi.mock('../../../main/project/project-service', () => ({
  findProject: vi.fn(),
}))

import { callLlmForJson } from '../../../main/kernel/llm-call'
import { mintProjectPreviewUrl } from '../../../main/delivery/preview-scheme'
import { findProject } from '../../../main/project/project-service'
import { freezeConfirmedUxSketch, generateUxSketch, parseSketchHtml, stageUxSketch } from '../../../main/guide/ux-sketch'

const mockCall = vi.mocked(callLlmForJson)
const mockMint = vi.mocked(mintProjectPreviewUrl)
const mockFindProject = vi.mocked(findProject)

let sandboxRoot: string

beforeEach(() => {
  vi.clearAllMocks()
  sandboxRoot = mkdtempSync(join(tmpdir(), 'bloma-ux-sketch-'))
  mockFindProject.mockImplementation(() => ({ name: '计算器', root_path: sandboxRoot }) as never)
})

afterEach(() => {
  rmSync(sandboxRoot, { recursive: true, force: true })
})

const baseInput = {
  project_id: 'p1',
  session_id: 's1',
  query: (async function* () {
    yield { type: 'result', subtype: 'success' }
  })() as never,
  env: {},
  maxTokens: 1000,
  positioning: '科学计算器',
  requirements: [
    { id: 'F-001', description: '做一个计算器' },
    { id: 'F-002', description: '科学函数按钮面板', behavior_assertions: ['点 sin 后表达式区出现 sin('] },
  ],
}

describe('parseSketchHtml（解析契约）', () => {
  it('剥 ```html 围栏', () => {
    const parsed = parseSketchHtml('```html\n<!DOCTYPE html><html><body>x</body></html>\n```')
    expect(parsed?.html).toBe('<!DOCTYPE html><html><body>x</body></html>')
    expect(parsed?.source).toBe('llm')
  })
  it('非 HTML（解释文字）拒绝→带反馈重试路径', () => {
    expect(parseSketchHtml('这是一个计算器草图，界面分为……')).toBeUndefined()
    expect(parseSketchHtml('<div>没有闭合文档</div>')).toBeUndefined()
  })
})

describe('generateUxSketch', () => {
  it('LLM 正常输出：剥代码围栏，source=llm', async () => {
    mockCall.mockResolvedValue({ html: '<!DOCTYPE html><html><body>草图</body></html>', source: 'llm' } as never)
    const result = await generateUxSketch(baseInput)
    expect(result.source).toBe('llm')
    // prompt 含需求与定位
    const arg = mockCall.mock.calls[0]?.[0] as { prompt: string; timeoutMs?: number }
    expect(arg.prompt).toContain('F-001')
    expect(arg.prompt).toContain('科学计算器')
    // 草图调用有超时兜底（门不挂死）
    expect(arg.timeoutMs ?? 0).toBeGreaterThan(0)
  })

  it('LLM 失败：确定性模板兜底（含页脚声明与需求块），source=template', async () => {
    mockCall.mockResolvedValue(null as never)
    mockMint.mockImplementation(() => 'bloma-file://p1/00_UX/ux-sketch.html')
    const result = await generateUxSketch(baseInput)
    expect(result.source).toBe('template')
    expect(result.html).toContain('外观草图 · 仅供确认方向')
    expect(result.html).toContain('F-002')
    expect(result.html).toContain('点 sin 后表达式区出现 sin(')
  })

  it('调整模式：prompt 带上一版要点与用户反馈', async () => {
    mockCall.mockResolvedValue({ html: '<!DOCTYPE html><html></html>', source: 'llm' } as never)
    await generateUxSketch({ ...baseInput, previousSummary: '上一版：三列按钮', feedback: '按钮太挤' })
    const arg = mockCall.mock.calls[0]?.[0] as { prompt?: string }
    expect(arg.prompt).toContain('按钮太挤')
    expect(arg.prompt).toContain('上一版：三列按钮')
  })
})

describe('stageUxSketch（方案 A：bloma-file 直读，无沙箱）', () => {
  it('archives a pre-upgrade draft before the first overwrite', async () => {
    mkdirSync(join(sandboxRoot, '00_UX'))
    writeFileSync(join(sandboxRoot, '00_UX/ux-sketch.html'), 'legacy version')
    await stageUxSketch({ project_id: 'p1', html: '<!DOCTYPE html><html>new version</html>' })
    expect(readFileSync(join(sandboxRoot, '00_UX/history/version-0001.html'), 'utf8')).toBe('legacy version')
    expect(readFileSync(join(sandboxRoot, '00_UX/history/version-0002.html'), 'utf8')).toContain('new version')
  })
  it('keeps both versions and preserves the confirmed layout when a new draft is staged', async () => {
    await stageUxSketch({ project_id: 'p1', html: '<!DOCTYPE html><html><body>first</body></html>' })
    freezeConfirmedUxSketch('p1')
    await stageUxSketch({ project_id: 'p1', html: '<!DOCTYPE html><html><body>second</body></html>' })
    expect(readFileSync(join(sandboxRoot, '00_UX/history/version-0001.html'), 'utf8')).toContain('first')
    expect(readFileSync(join(sandboxRoot, '00_UX/history/version-0002.html'), 'utf8')).toContain('second')
    expect(readFileSync(join(sandboxRoot, '00_UX/confirmed.html'), 'utf8')).toContain('first')
    expect(readFileSync(join(sandboxRoot, '00_UX/ux-sketch.html'), 'utf8')).toContain('second')
  })
  it('落盘 00_UX/ux-sketch.html 并返回 bloma-file:// 预览 URL', async () => {
    const staged = await stageUxSketch({ project_id: 'p1', html: '<!DOCTYPE html><html></html>' })
    expect(staged.preview_url).toBe('bloma-file://p1/00_UX/ux-sketch.html')
    expect(mockMint).toHaveBeenCalledWith('p1', '00_UX/ux-sketch.html')
    const written = readFileSync(join(sandboxRoot, '00_UX', 'ux-sketch.html'), 'utf8')
    expect(written).toContain('<html>')
  })

  it('URL 铸造失败：抛错（调用方降级文字版卡，门不挂死）', async () => {
    mockMint.mockImplementation(() => { throw new Error('PREVIEW_NOT_HTML') })
    await expect(stageUxSketch({ project_id: 'p1', html: '<!DOCTYPE html><html></html>' })).rejects.toThrow('PREVIEW_NOT_HTML')
  })
})
