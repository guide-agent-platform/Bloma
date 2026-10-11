import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { restorePromaHome } from '../support/proma-home-guard'
import { loadPromptOverride, describePromptSource } from '../../main/agent/prompting/prompt-config'
import { listPromptSlots, readPromptSlot, resetPromptSlot, savePromptSlot } from '../../main/agent/prompting/prompt-service'
import { generateUxSketch } from '../../main/guide/ux-sketch'
import { callLlmForJson } from '../../main/kernel/llm-call'
import { runAgentLoop, type AgentLoopInput, type AgentLoopTool } from '../../main/agent/loop/agent-loop'
import type { SDKMessage } from '../../shared/types'
import type { SDKQuery, SDKQueryOptions } from '../../main/orchestration/orchestrator'

vi.mock('../../main/delivery/preview-scheme', () => ({ mintProjectPreviewUrl: vi.fn() }))
vi.mock('../../main/kernel/llm-call', () => ({ callLlmForJson: vi.fn() }))

describe('提示词设置到真实模型装配边界', () => {
  it('reports the runtime source without copying local prompt content', () => {
    expect(describePromptSource('sketch-system').source).toBe('builtin_default')
    savePromptSlot('sketch-system', '本地测试偏好')
    const source = describePromptSource('sketch-system')
    expect(source.source).toBe('local_override')
    expect(source.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(source)).not.toContain('本地测试偏好')
    resetPromptSlot('sketch-system')
    expect(describePromptSource('sketch-system').source).toBe('builtin_default')
  })
  const originalHome = process.env.PROMA_HOME
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'bloma-prompt-runtime-'))
    process.env.PROMA_HOME = home
    vi.clearAllMocks()
  })
  afterEach(() => {
    restorePromaHome(originalHome)
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  function writeOverride(name: string, content: string): void {
    mkdirSync(join(home, 'prompts'), { recursive: true })
    writeFileSync(join(home, 'prompts', `${name}.md`), content, 'utf8')
  }

  it('设置页可编辑 UX 草图，保存内容确实送到草图模型调用', async () => {
    expect(listPromptSlots().map((slot) => slot.id)).toContain('sketch-system')
    expect(readPromptSlot('sketch-system').content).toContain('外观草图')
    savePromptSlot('sketch-system', '草图覆盖标记：保持用户确认的布局')
    vi.mocked(callLlmForJson).mockResolvedValue({ html: '<!DOCTYPE html><html></html>', source: 'llm' } as never)
    await generateUxSketch({
      project_id: 'p1', session_id: 's1', positioning: '计算器',
      requirements: [{ id: 'F-001', description: '计算结果' }],
      query: async function* () {}, env: {}, maxTokens: 1000,
    })
    const call = vi.mocked(callLlmForJson).mock.calls[0]![0]
    expect(call.systemPrompt).toContain('草图覆盖标记')
    expect(call.systemPrompt).toContain('示例数据必须自洽')
    expect(readPromptSlot('sketch-system')).toMatchObject({ has_override: true, content: '草图覆盖标记：保持用户确认的布局' })
  })

  it('旧 UX 文件名按优先级兼容；重置清除兼容文件，避免设置页假称恢复默认', () => {
    writeOverride('ux-sketch.md', '旧双后缀')
    expect(loadPromptOverride('sketch-system')).toBe('旧双后缀')
    writeOverride('ux-sketch', '旧正常后缀')
    expect(readPromptSlot('sketch-system').content).toBe('旧正常后缀')
    savePromptSlot('sketch-system', '设置页版本')
    expect(loadPromptOverride('sketch-system')).toBe('设置页版本')
    resetPromptSlot('sketch-system')
    expect(readPromptSlot('sketch-system').has_override).toBe(false)
    expect(readPromptSlot('sketch-system').content).toContain('外观草图')
    for (const name of ['sketch-system', 'ux-sketch', 'ux-sketch.md']) {
      expect(existsSync(join(home, 'prompts', `${name}.md`))).toBe(false)
    }
  })

  it('空白覆盖按实际生效内容显示未覆盖，BOM 不污染提示词', () => {
    writeOverride('guide-system', '  \n')
    expect(readPromptSlot('guide-system').has_override).toBe(false)
    writeOverride('guide-system', '\uFEFF新版向导规则')
    expect(readPromptSlot('guide-system').content).toBe('新版向导规则')
  })

  async function run(responses: SDKMessage[][], tools: AgentLoopTool[], overrides: Partial<AgentLoopInput> = {}) {
    const calls: SDKQueryOptions[] = []
    let index = 0
    const query: SDKQuery = async function* (_prompt, options) {
      calls.push(options)
      const messages = responses[Math.min(index++, responses.length - 1)] ?? []
      for (const message of messages) yield message
      yield { type: 'result', subtype: 'success', stop_reason: messages.some((m) => m.message?.content.some((b) => b.type === 'tool_use')) ? 'tool_use' : 'end_turn' }
    }
    const result = await runAgentLoop({
      system: '项目锚：必须保留全部已确认需求', task: '完成任务', tools, query,
      env: {}, sessionId: `prompt-runtime-${overrides.delegationDepth ?? 0}`, projectId: 'missing',
      requestId: 'prompt-runtime', maxTokens: 256, maxTurns: 4, permissionMode: 'allow-all',
      signal: new AbortController().signal, publish: () => undefined, ...overrides,
    })
    return { calls, result }
  }

  const text = (value: string): SDKMessage => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: value }] } })
  const use = (id: string, name: string): SDKMessage => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] } })
  const echo: AgentLoopTool = { name: 'read_file', description: '读取', input_schema: {}, execute: async () => ({ output: 'ok' }) }

  it.each([0, 1])('loop 追加规则进入 depth=%s 的每轮模型请求，且保留原项目锚', async (depth) => {
    savePromptSlot('loop-system', '自定义规则：先报告验证范围')
    const { calls } = await run([[use('read', 'read_file')], [text('已完成')]], [echo], { delegationDepth: depth })
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      const system = String(call.messages?.[0]?.content)
      expect(system).toContain('项目锚：必须保留全部已确认需求')
      expect(system.match(/自定义规则：先报告验证范围/g)).toHaveLength(1)
    }
    savePromptSlot('loop-system', '自定义规则：下次运行的新偏好')
    const next = await run([[text('完成')]], [], { delegationDepth: depth })
    expect(String(next.calls[0]!.messages?.[0]?.content)).toContain('下次运行的新偏好')
  })

  it('桌面会话只通过安全扫描仍保留工具，下一轮可以执行功能自测', async () => {
    const scan: AgentLoopTool = {
      name: 'run_security_scan', description: '扫描', input_schema: {},
      execute: async (_input, ctx) => { ctx.state.security_all_passed = true; return { output: '扫描通过' } },
    }
    const execute = vi.fn(async () => ({ output: '自测通过' }))
    const script: AgentLoopTool = { name: 'run_project_script', description: '自测', input_schema: {}, execute }
    const { calls, result } = await run([[use('scan', scan.name)], [use('test', script.name)], [text('仅逻辑自测通过，界面交互未验')]], [scan, script])
    expect(calls[1]!.tools?.map((tool) => tool.name)).toContain('run_project_script')
    expect(String(calls[1]!.messages?.[0]?.content)).not.toContain('【收口】')
    expect(execute).toHaveBeenCalledOnce()
    expect(result.status).toBe('completed')
    expect(result.finalText).toContain('界面交互未验')
  })
})
