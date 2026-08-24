import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateMvpLlm, type GenerateMvpLlmInput } from '../../main/mvp-engine-llm'
import type { SDKQuery, SDKQueryOptions } from '../../main/orchestrator'
import { createProject, findProject } from '../../main/project-service'
import type { SDKMessage } from '../../shared/types'

/**
 * A2-14b — LLM 生成型 MVP 模块级单测。
 *
 * 覆盖：成功落盘 / 解析失败 / 空输出 / 空 files / 抛错传播 / 超时抛错 / 外部取消 /
 * 路径穿越整批拒绝 / 绝对路径整批拒绝 / package.json 强制重写 / static-server.js 系统接管 /
 * 文件数超上限。所有失败均抛错向上传播，无模板兜底。
 */

const CALCULATOR_JSON = JSON.stringify({
  files: [
    { path: 'index.html', content: '<!doctype html><html><body><button>+</button><button>−</button><button>×</button><button>÷</button><script src="/src/app.js"></script></body></html>' },
    { path: 'src/app.js', content: 'function calculate(a, op, b) { return op === "+" ? a + b : a; }' },
    { path: 'src/styles.css', content: 'body { margin: 0; }' },
  ],
  run_command: 'npm run custom',
  assumptions: ['纯前端计算器'],
  risks: ['无后端'],
})

function queryReturning(text: string): SDKQuery {
  return async function* (): AsyncGenerator<SDKMessage> {
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
    yield { type: 'result', subtype: 'success' }
  }
}

/** 按调用次序依次返回不同文本（超出后复用最后一个），用于模拟「首试失败、重试成功」。 */
function querySequence(...texts: string[]): SDKQuery {
  let call = 0
  return async function* (): AsyncGenerator<SDKMessage> {
    const text = texts[Math.min(call, texts.length - 1)] ?? ''
    call += 1
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
    yield { type: 'result', subtype: 'success' }
  }
}

const zeroTokenQuery: SDKQuery = async function* (): AsyncGenerator<SDKMessage> {
  // 流无任何消息（零 token）
}

const throwingQuery: SDKQuery = async function* (): AsyncGenerator<SDKMessage> {
  throw new Error('model network error')
}

/** 阻塞直到 signal 中止（模拟真实 SSE reader.read() 挂起），用于超时用例。 */
const hangingQuery: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions): AsyncGenerator<SDKMessage> {
  await new Promise<void>((resolve) => {
    if (options.signal.aborted) return resolve()
    options.signal.addEventListener('abort', () => resolve(), { once: true })
  })
  yield { type: 'result', subtype: 'success' }
}

/** 在 signal 中止时抛错（模拟外部取消时 reader.read() 抛 AbortError）。 */
const cancelQuery: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions): AsyncGenerator<SDKMessage> {
  await new Promise<never>((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
  })
}

describe('MvpEngineLlm generation (A2-14b)', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  function makeInput(overrides: Partial<GenerateMvpLlmInput> = {}): GenerateMvpLlmInput {
    const home = mkdtempSync(join(tmpdir(), 'proma-mvp-llm-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick', initial_message: '基础四则运算计算器' })
    return {
      project_id: project.project_id,
      backplane: {
        project_id: project.project_id,
        name: '基础四则运算计算器',
        positioning: '基础四则运算计算器',
        requirements: [{ id: 'F-001', description: '基础四则运算计算器' }],
        acceptance: { 'F-001': '基础四则运算计算器：核心路径可交互，边界与异常输入不崩溃。' },
        out_of_scope: [],
        assumptions: [],
      },
      query: queryReturning(CALCULATOR_JSON),
      env: { PATH: 'x', ANTHROPIC_AUTH_TOKEN: 'test-key' },
      sessionId: 'session-1',
      ...overrides,
    }
  }

  it('LLM 返回合法 JSON（计算器）→ 文件落盘、run_command 为模型原样值', async () => {
    const input = makeInput()
    const result = await generateMvpLlm(input)

    // run_command 为模型返回的原样值（强制覆盖在 runMvpTask，模块层不负责）
    expect(result.run_command).toBe('npm run custom')
    expect(result.files.map((f) => f.path)).toEqual([
      'package.json',
      'static-server.js',
      'index.html',
      'src/app.js',
      'src/styles.css',
    ])

    const indexHtml = readFileSync(join(findRoot(input), 'index.html'), 'utf8')
    expect(indexHtml).toContain('+')
    expect(indexHtml).toContain('−')
    expect(indexHtml).toContain('×')
    expect(indexHtml).toContain('÷')
    const appJs = readFileSync(join(findRoot(input), 'src', 'app.js'), 'utf8')
    expect(appJs).toContain('calculate')
  })

  it('buildPrompt 注入密背板（故事 + 行为断言 + 优先级 + 范围外 + 护栏），主题锚点不丢失', async () => {
    let capturedPrompt = ''
    const captureQuery: SDKQuery = async function* (prompt: string) {
      capturedPrompt = prompt
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: CALCULATOR_JSON }] } }
      yield { type: 'result', subtype: 'success' }
    }
    const input = makeInput({
      query: captureQuery,
      backplane: {
        project_id: 'p',
        name: '音乐合成器',
        positioning: '音乐合成器',
        requirements: [
          {
            id: 'F-001',
            description: '音乐合成器',
            story: '作为音乐爱好者，我想在网页上弹奏合成器，以便随时创作旋律',
            behavior_assertions: ['点击琴键→播放对应音调'],
            priority: 'P0',
          },
          { id: 'F-002', description: '网页端' },
        ],
        acceptance: {
          'F-001': '音乐合成器：核心路径可交互',
          'F-002': '网页端：核心路径可交互',
        },
        out_of_scope: ['不做移动端 App'],
        assumptions: [],
        generation_guardrails: {
          must_do: ['琴键支持鼠标与键盘两种触发'],
          must_not_do: ['不引入 Web Audio 之外的音频库'],
        },
      },
    })

    await generateMvpLlm(input)

    expect(capturedPrompt).toContain('产品定位：音乐合成器')
    // 密背板格式层：故事 + 行为断言 + 优先级（F-002 薄项经 helper 回退默认）
    expect(capturedPrompt).toContain('F-001（P0）：作为音乐爱好者，我想在网页上弹奏合成器，以便随时创作旋律')
    expect(capturedPrompt).toContain('行为断言：点击琴键→播放对应音调')
    expect(capturedPrompt).toContain('F-002（P2）：网页端')
    expect(capturedPrompt).toContain('行为断言：该功能项在产物中可见且可交互')
    expect(capturedPrompt).toContain('范围外（不要实现）')
    expect(capturedPrompt).toContain('不做移动端 App')
    expect(capturedPrompt).toContain('MUST DO：')
    expect(capturedPrompt).toContain('琴键支持鼠标与键盘两种触发')
    // 无草图契约（PRD-only）：不注入 UX 契约段与仲裁规则
    expect(capturedPrompt).not.toContain('UX 契约草图')
    expect(capturedPrompt).not.toContain('仲裁规则')
  })

  it('buildPrompt 注入双契约：草图全文（不降采样）+ 仲裁规则（§4.2/§7.1）', async () => {
    let capturedPrompt = ''
    let capturedHistory: { role: string; content: string | import('../../shared/types').MessageContentBlock[] }[] = []
    const captureQuery: SDKQuery = async function* (prompt: string, options: SDKQueryOptions) {
      capturedPrompt = prompt
      capturedHistory = options.history ?? []
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: CALCULATOR_JSON }] } }
      yield { type: 'result', subtype: 'success' }
    }
    const sketchHtml = '<!doctype html><html><head><style>.race-track{width:100%}</style></head><body><div class="race-track"><div class="car">🏎️</div></div></body></html>'
    const input = makeInput({ query: captureQuery, sketchHtml })

    await generateMvpLlm(input)

    // 草图全文注入（不降采样、不截断）
    expect(capturedPrompt).toContain('UX 契约草图（用户已确认，HTML 全文）')
    expect(capturedPrompt).toContain(sketchHtml)
    // 仲裁规则写死：行为优先、草图为准、范围互斥
    expect(capturedPrompt).toContain('行为断言与草图冲突 → 行为优先，但保持草图审美')
    expect(capturedPrompt).toContain('布局/结构/样式 → 以草图为准，不得低于草图精致度')
    // 系统提示词：6 段式结构 + 共享硬约束/反模式骨架
    const system = capturedHistory.find((turn) => turn.role === 'system')?.content ?? ''
    expect(system).toContain('=== 1. TASK ===')
    expect(system).toContain('=== 4. MUST DO ===')
    expect(system).toContain('禁止「整页粘贴草图 + 塞一段 script」')
    expect(system).toContain('HARD BLOCKS')
    expect(system).toContain('ANTI-PATTERNS')
  })

  it('LLM 返回非 JSON → 抛 MVP_LLM_PARSE_FAILED（无模板兜底）', async () => {
    const input = makeInput({ query: queryReturning('这不是 JSON，只是人话') })
    await expect(generateMvpLlm(input)).rejects.toThrow('MVP_LLM_PARSE_FAILED')
  })

  it('截断输出 → 加大 maxTokens 重试一次并成功（不做内容级修补）', async () => {
    const truncated = '{"files":[{"path":"index.html","content":"<button>'
    const input = makeInput({ query: querySequence(truncated, CALCULATOR_JSON) })
    const result = await generateMvpLlm(input)
    expect(result.files.map((f) => f.path)).toEqual([
      'package.json',
      'static-server.js',
      'index.html',
      'src/app.js',
      'src/styles.css',
    ])
  })

  it('截断输出重试后仍截断 → 抛 MVP_LLM_TRUNCATED', async () => {
    const truncated = '{"files":[{"path":"index.html","content":"<button>'
    const input = makeInput({ query: querySequence(truncated, truncated) })
    await expect(generateMvpLlm(input)).rejects.toThrow('MVP_LLM_TRUNCATED')
  })

  it('截断重试时 maxTokens 升级到 2 倍（默认 16384 → 32768，2026-08-16 三文件 JSON 8192 溢出实锤后上调）', async () => {
    const truncated = '{"files":[{"path":"index.html","content":"<button>'
    const maxTokensSeen: number[] = []
    const query: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions) {
      maxTokensSeen.push(options.maxTokens ?? -1)
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: truncated }] } }
      yield { type: 'result', subtype: 'success' }
    }
    const input = makeInput({ query })
    await expect(generateMvpLlm(input)).rejects.toThrow('MVP_LLM_TRUNCATED')
    expect(maxTokensSeen).toEqual([16384, 32768])
  })

  it('非截断格式错误 → 带反馈重试（坏输出作为 assistant 回灌 + 反馈提示）', async () => {
    const calls: { prompt: string; history: { role: string; content: string | import('../../shared/types').MessageContentBlock[] }[] }[] = []
    const query: SDKQuery = async function* (prompt: string, options: SDKQueryOptions) {
      calls.push({ prompt, history: options.history ?? [] })
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '这不是 JSON' }] } }
      yield { type: 'result', subtype: 'success' }
    }
    const input = makeInput({ query })
    await expect(generateMvpLlm(input)).rejects.toThrow('MVP_LLM_PARSE_FAILED')
    expect(calls).toHaveLength(2)
    expect(calls[1].prompt).toContain('无法被解析为有效 JSON')
    expect(calls[1].history.some((t) => t.role === 'assistant' && t.content === '这不是 JSON')).toBe(true)
  })

  it('LLM 返回空 files（合法 JSON 但 files:[]）→ 抛 MVP_LLM_INVALID_OUTPUT', async () => {
    const input = makeInput({ query: queryReturning(JSON.stringify({ files: [], run_command: 'npm start' })) })
    await expect(generateMvpLlm(input)).rejects.toThrow('MVP_LLM_INVALID_OUTPUT')
  })

  it('LLM 返回空输出（零 token，流无任何消息）→ 抛 MVP_LLM_PARSE_FAILED', async () => {
    const input = makeInput({ query: zeroTokenQuery })
    await expect(generateMvpLlm(input)).rejects.toThrow('MVP_LLM_PARSE_FAILED')
  })

  it('LLM 抛错 → 错误向上传播（由 runMvpTask 向上报错，不降级）', async () => {
    const input = makeInput({ query: throwingQuery })
    await expect(generateMvpLlm(input)).rejects.toThrow('model network error')
  })

  it('LLM 超时（注入短 timeoutMs）→ 抛 MVP_LLM_TIMEOUT（无模板兜底）', async () => {
    const input = makeInput({ query: hangingQuery, timeoutMs: 50 })
    await expect(generateMvpLlm(input)).rejects.toThrow('MVP_LLM_TIMEOUT')
  })

  it('LLM 外部取消（先于 timeoutMs 触发外部 signal）→ 抛错向上传播', async () => {
    const externalController = new AbortController()
    const input = makeInput({ query: cancelQuery, signal: externalController.signal, timeoutMs: 5_000 })
    const pending = generateMvpLlm(input)
    externalController.abort()
    await expect(pending).rejects.toThrow('cancelled')
  })

  it('path 路径穿越（../evil.js）→ 整批拒绝抛 MVP_LLM_PATH_REJECTED', async () => {
    const json = JSON.stringify({ files: [{ path: '../evil.js', content: 'x' }, { path: 'index.html', content: 'ok' }], run_command: 'npm start' })
    const input = makeInput({ query: queryReturning(json) })
    await expect(generateMvpLlm(input)).rejects.toThrow('MVP_LLM_PATH_REJECTED')
  })

  it('path 绝对路径（/abs/path.js）→ 整批拒绝抛 MVP_LLM_PATH_REJECTED', async () => {
    const json = JSON.stringify({ files: [{ path: '/abs/path.js', content: 'x' }], run_command: 'npm start' })
    const input = makeInput({ query: queryReturning(json) })
    await expect(generateMvpLlm(input)).rejects.toThrow('MVP_LLM_PATH_REJECTED')
  })

  it('模型返回 package.json content → 被忽略，系统重写为固定 start 脚本', async () => {
    const json = JSON.stringify({
      files: [
        { path: 'package.json', content: '{"scripts":{"start":"evil"}}' },
        { path: 'index.html', content: '<button>+</button><button>−</button><button>×</button><button>÷</button>' },
      ],
      run_command: 'npm start',
    })
    const input = makeInput({ query: queryReturning(json) })
    const result = await generateMvpLlm(input)
    const packageJson = readFileSync(join(findRoot(input), 'package.json'), 'utf8')
    expect(packageJson).toContain('"start": "node static-server"')
    expect(packageJson).not.toContain('evil')
  })

  it('模型返回 static-server.js content → 被忽略，落盘为系统固定版本', async () => {
    const json = JSON.stringify({
      files: [
        { path: 'static-server.js', content: '// evil node code' },
        { path: 'index.html', content: '<button>+</button><button>−</button><button>×</button><button>÷</button>' },
      ],
      run_command: 'npm start',
    })
    const input = makeInput({ query: queryReturning(json) })
    const result = await generateMvpLlm(input)
    const staticServer = readFileSync(join(findRoot(input), 'static-server.js'), 'utf8')
    expect(staticServer).toContain('process.env.PORT')
    expect(staticServer).toContain("connect-src 'none'")
    expect(staticServer).not.toContain('evil node code')
  })

  it('files 数量超上限（>10）→ 抛 MVP_LLM_INVALID_OUTPUT', async () => {
    const files = Array.from({ length: 11 }, (_, i) => ({ path: `src/f${i}.js`, content: 'x' }))
    const input = makeInput({ query: queryReturning(JSON.stringify({ files, run_command: 'npm start' })) })
    await expect(generateMvpLlm(input)).rejects.toThrow('MVP_LLM_INVALID_OUTPUT')
  })

  it('模型在 index.html 写内联 meta CSP → 被剥离，避免与平台 CSP 冲突导致 eval/内联脚本被拦', async () => {
    const htmlWithMetaCsp = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src 'self'"></head><body><button>+</button><button>−</button><button>×</button><button>÷</button><script src="/src/app.js"></script></body></html>`
    const json = JSON.stringify({
      files: [
        { path: 'index.html', content: htmlWithMetaCsp },
        { path: 'src/app.js', content: 'function calculate(a, op, b) { return a + b; }' },
        { path: 'src/styles.css', content: 'body { margin: 0; }' },
      ],
      run_command: 'npm start',
    })
    const input = makeInput({ query: queryReturning(json) })
    const result = await generateMvpLlm(input)

    const indexHtml = readFileSync(join(findRoot(input), 'index.html'), 'utf8')
    expect(indexHtml).not.toMatch(/http-equiv\s*=\s*["']?content-security-policy/i)
    expect(indexHtml).toContain('+')
    expect(indexHtml).toContain('÷')
  })
})

function findRoot(input: GenerateMvpLlmInput): string {
  return findProject(input.project_id).root_path
}
