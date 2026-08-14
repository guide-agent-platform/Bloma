import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateSketchLlm, type GenerateSketchLlmInput } from '../../main/sketch-engine-llm'
import type { SDKQuery, SDKQueryOptions } from '../../main/orchestrator'
import { createProject, findProject } from '../../main/project-service'
import type { SDKMessage } from '../../shared/types'

/**
 * SketchEngineLlm — 草图走 LLM 生成「无交互纯外观」HTML 的模块级单测。
 *
 * 覆盖：成功落盘 / 剥离残留 <script> 与内联事件 / 非 HTML 抛错 / 超时抛错 / 失败向上传播。
 */

const SKETCH_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><style>body{font-family:sans-serif}.form{display:grid;gap:12px}</style></head>
<body>
  <header class="topbar"><span>记账本</span></header>
  <main>
    <h1>记账本</h1>
    <section class="form">
      <label>金额</label><input type="text" placeholder="请输入金额" />
      <button>保存</button>
    </section>
  </main>
</body>
</html>`

function queryReturning(text: string): SDKQuery {
  return async function* (): AsyncGenerator<SDKMessage> {
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
    yield { type: 'result', subtype: 'success' }
  }
}

const throwingQuery: SDKQuery = async function* (): AsyncGenerator<SDKMessage> {
  throw new Error('model network error')
}

const hangingQuery: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions): AsyncGenerator<SDKMessage> {
  await new Promise<void>((resolve) => {
    if (options.signal.aborted) return resolve()
    options.signal.addEventListener('abort', () => resolve(), { once: true })
  })
  yield { type: 'result', subtype: 'success' }
}

describe('SketchEngineLlm generation (草图走 LLM)', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  function makeInput(overrides: Partial<GenerateSketchLlmInput> = {}): GenerateSketchLlmInput {
    const home = mkdtempSync(join(tmpdir(), 'proma-sketch-llm-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick', initial_message: '记账本' })
    return {
      project_id: project.project_id,
      requirements: [{ id: 'F-001', description: '记录收入和支出' }],
      query: queryReturning(SKETCH_HTML),
      env: { PATH: 'x', ANTHROPIC_AUTH_TOKEN: 'test-key' },
      sessionId: 'session-1',
      ...overrides,
    }
  }

  it('LLM 返回合法 HTML → 落盘 index.html，含功能项语义区块', async () => {
    const input = makeInput()
    const result = await generateSketchLlm(input)

    expect(result.files.map((f) => f.path)).toEqual(['index.html'])
    expect(result.run_command).toBe('node static-server')
    expect(result.summary).toContain('外观草图')

    const html = readFileSync(join(findProject(input.project_id).root_path, 'index.html'), 'utf8')
    expect(html).toContain('记账本')
    expect(html).toContain('<style>')
    expect(html).toContain('<input')
  })

  it('剥离模型残留的 <script> 块与内联 on* 事件，保证无交互', async () => {
    const htmlWithScript = `<!doctype html><html><head><style>body{}</style></head><body>
      <button onclick="alert(1)">点我</button>
      <script>document.body.addEventListener('click', function(){})</script>
      <p>内容</p>
    </body></html>`
    const input = makeInput({ query: queryReturning(htmlWithScript) })
    await generateSketchLlm(input)

    const html = readFileSync(join(findProject(input.project_id).root_path, 'index.html'), 'utf8')
    expect(html).not.toMatch(/<script>/i)
    expect(html).not.toMatch(/onclick=/i)
    expect(html).not.toMatch(/addEventListener/)
    expect(html).toContain('内容')
  })

  it('模型输出非 HTML（纯文本）→ 抛 SKETCH_LLM_PARSE_FAILED', async () => {
    const input = makeInput({ query: queryReturning('这不是 HTML，只是人话') })
    await expect(generateSketchLlm(input)).rejects.toThrow('SKETCH_LLM_PARSE_FAILED')
  })

  it('模型输出缺失 <style>（不是完整外观草图）→ 抛 SKETCH_LLM_PARSE_FAILED', async () => {
    const input = makeInput({ query: queryReturning('<html><body><p>没有样式</p></body></html>') })
    await expect(generateSketchLlm(input)).rejects.toThrow('SKETCH_LLM_PARSE_FAILED')
  })

  it('LLM 超时（注入短 timeoutMs）→ 抛 SKETCH_LLM_TIMEOUT', async () => {
    const input = makeInput({ query: hangingQuery, timeoutMs: 50 })
    await expect(generateSketchLlm(input)).rejects.toThrow('SKETCH_LLM_TIMEOUT')
  })

  it('LLM 抛错 → 错误向上传播（由 resolveSketch 回退模板）', async () => {
    const input = makeInput({ query: throwingQuery })
    await expect(generateSketchLlm(input)).rejects.toThrow('model network error')
  })
})
