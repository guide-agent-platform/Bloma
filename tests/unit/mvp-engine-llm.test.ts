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
 * 覆盖：成功落盘 / 解析失败 / 空输出 / 空 files / 抛错传播 / 超时兜底 / 外部取消 /
 * 路径穿越整批拒绝 / 绝对路径整批拒绝 / package.json 强制重写 / static-server.js 系统接管 /
 * 文件数超上限。
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
      requirements: [{ id: 'F-001', description: '基础四则运算计算器' }],
      query: queryReturning(CALCULATOR_JSON),
      env: { PATH: 'x', ANTHROPIC_AUTH_TOKEN: 'test-key' },
      sessionId: 'session-1',
      ...overrides,
    }
  }

  it('LLM 返回合法 JSON（计算器）→ 文件落盘、generated_by=llm、run_command 为模型原样值', async () => {
    const input = makeInput()
    const result = await generateMvpLlm(input)

    expect(result.generated_by).toBe('llm')
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

  it('LLM 返回非 JSON → 返回 template 兜底且 files 为空数组', async () => {
    const input = makeInput({ query: queryReturning('这不是 JSON，只是人话') })
    const result = await generateMvpLlm(input)
    expect(result.generated_by).toBe('template')
    expect(result.files).toEqual([])
  })

  it('LLM 返回空 files（合法 JSON 但 files:[]）→ 返回 template 兜底', async () => {
    const input = makeInput({ query: queryReturning(JSON.stringify({ files: [], run_command: 'npm start' })) })
    const result = await generateMvpLlm(input)
    expect(result.generated_by).toBe('template')
    expect(result.files).toEqual([])
  })

  it('LLM 返回空输出（零 token，流无任何消息）→ 返回 template 兜底', async () => {
    const input = makeInput({ query: zeroTokenQuery })
    const result = await generateMvpLlm(input)
    expect(result.generated_by).toBe('template')
    expect(result.files).toEqual([])
  })

  it('LLM 抛错 → 错误向上传播（由 runMvpTask 捕获走兜底）', async () => {
    const input = makeInput({ query: throwingQuery })
    await expect(generateMvpLlm(input)).rejects.toThrow('model network error')
  })

  it('LLM 超时（注入短 timeoutMs）→ 返回 template 兜底，不抛错', async () => {
    const input = makeInput({ query: hangingQuery, timeoutMs: 50 })
    const result = await generateMvpLlm(input)
    expect(result.generated_by).toBe('template')
    expect(result.files).toEqual([])
  })

  it('LLM 外部取消（先于 timeoutMs 触发外部 signal）→ 抛错向上传播', async () => {
    const externalController = new AbortController()
    const input = makeInput({ query: cancelQuery, signal: externalController.signal, timeoutMs: 5_000 })
    const pending = generateMvpLlm(input)
    externalController.abort()
    await expect(pending).rejects.toThrow('cancelled')
  })

  it('path 路径穿越（../evil.js）→ 整批拒绝走 template 兜底', async () => {
    const json = JSON.stringify({ files: [{ path: '../evil.js', content: 'x' }, { path: 'index.html', content: 'ok' }], run_command: 'npm start' })
    const input = makeInput({ query: queryReturning(json) })
    const result = await generateMvpLlm(input)
    expect(result.generated_by).toBe('template')
    expect(result.files).toEqual([])
  })

  it('path 绝对路径（/abs/path.js）→ 整批拒绝走 template 兜底', async () => {
    const json = JSON.stringify({ files: [{ path: '/abs/path.js', content: 'x' }], run_command: 'npm start' })
    const input = makeInput({ query: queryReturning(json) })
    const result = await generateMvpLlm(input)
    expect(result.generated_by).toBe('template')
    expect(result.files).toEqual([])
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
    expect(result.generated_by).toBe('llm')
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
    expect(result.generated_by).toBe('llm')
    const staticServer = readFileSync(join(findRoot(input), 'static-server.js'), 'utf8')
    expect(staticServer).toContain('process.env.PORT')
    expect(staticServer).toContain("connect-src 'none'")
    expect(staticServer).not.toContain('evil node code')
  })

  it('files 数量超上限（>10）→ 返回 template 兜底', async () => {
    const files = Array.from({ length: 11 }, (_, i) => ({ path: `src/f${i}.js`, content: 'x' }))
    const input = makeInput({ query: queryReturning(JSON.stringify({ files, run_command: 'npm start' })) })
    const result = await generateMvpLlm(input)
    expect(result.generated_by).toBe('template')
    expect(result.files).toEqual([])
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

    expect(result.generated_by).toBe('llm')
    const indexHtml = readFileSync(join(findRoot(input), 'index.html'), 'utf8')
    expect(indexHtml).not.toMatch(/http-equiv\s*=\s*["']?content-security-policy/i)
    expect(indexHtml).toContain('+')
    expect(indexHtml).toContain('÷')
  })
})

function findRoot(input: GenerateMvpLlmInput): string {
  return findProject(input.project_id).root_path
}
