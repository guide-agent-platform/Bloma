import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMvpTask, runPostMvpTestingFlow, agentLoopEnabled } from '../../../main/programming-orchestrator'
import { createProject, findProject, recordSketchGenerated } from '../../../main/project-service'
import { createChannel } from '../../../main/channel-manager'
import { setSafeStorageAdapter } from '../../../main/safe-storage'
import { clearSandboxRuntimeForTests, setSandboxRuntimeForTests } from '../../../main/platform-services'
import { setBrowserGwtDisabledForTests } from '../../../main/gwt-runner'
import { getAnalyticsPath, getAgentSessionPath } from '../../../storage/config-paths'
import type { MessageContentBlock, SDKMessage } from '../../../shared/types'
import type { SDKQuery, SDKQueryOptions } from '../../../main/orchestrator'

/**
 * Agent Loop 全链验收（PR3，mock 渠道）：flag + 能力位 → loop 生成（write_file →
 * run_preview → run_gwt_tests 失败 → 自修 → 再测通过 → 安全扫描）→ 外部强制终验
 * （runPostMvpTestingFlow repair_internalized）→ judge → ready。
 * 沙箱用 setSandboxRuntimeForTests 注入（端口指向真实静态文件服务器，GWT 走静态兜底）。
 */

const INDEX_V1 = '<html><head><style>body{font-family:sans-serif}</style></head><body><p>记账</p></body></html>'
const INDEX_V2 = '<html><head><style>body{font-family:sans-serif}</style></head><body><h1>记账本</h1><button>记录收入与支出</button></body></html>'
const APP_JS = 'var state = { entries: [] };\ndocument.addEventListener("DOMContentLoaded", function () {});\n'

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  child.stdout = new EventEmitter() as never
  child.stderr = new EventEmitter() as never
  // kill 同步发 exit：terminateProcessTree 等 exit 事件，不发会每次等满 2s 兜底
  child.kill = () => {
    child.emit('exit', 0)
    return true
  }
  return child
}

function assistant(content: MessageContentBlock[]): SDKMessage {
  return { type: 'assistant', message: { role: 'assistant', content } }
}

function toolUse(id: string, name: string, input: Record<string, unknown>): MessageContentBlock {
  return { type: 'tool_use', id, name, input }
}

function text(text: string): MessageContentBlock {
  return { type: 'text', text }
}

/** loop 剧本：每轮模型响应的 content blocks（工具真实执行，产出真实回填）。 */
const LOOP_SCRIPT: MessageContentBlock[][] = [
  [text('我先把页面骨架写出来。'), toolUse('t1', 'write_file', { path: 'index.html', content: INDEX_V1 }), toolUse('t2', 'write_file', { path: 'src/app.js', content: APP_JS })],
  [toolUse('t3', 'run_preview', {})],
  [toolUse('t4', 'run_gwt_tests', {})], // → 失败（缺功能入口）→ self_repair attempt 1
  [text('测试没过，我补上功能入口。'), toolUse('t5', 'write_file', { path: 'index.html', content: INDEX_V2 })],
  [toolUse('t6', 'run_gwt_tests', {})], // → 通过
  [toolUse('t7', 'run_security_scan', {})], // → 通过
  [text('完成：记账 MVP 已就绪，全部断言通过。')],
]

/**
 * mock 渠道：带 tools 的调用按剧本走（探测调用单独识别），不带 tools 的调用
 * （PRD 提取/加厚/命名）返回非 JSON 文本 → 各自走确定性兜底，不干扰主线。
 */
function scriptedQuery(opts: { probeRespondsWithToolUse?: boolean } = {}): { query: SDKQuery; loopModelCalls: () => number } {
  let loopTurn = 0
  let modelCalls = 0
  const query: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions) {
    const tools = options.tools ?? []
    if (tools.some((tool) => tool.name === 'loop_support_probe')) {
      if (opts.probeRespondsWithToolUse) yield assistant([toolUse('probe-1', 'loop_support_probe', {})])
      else yield assistant([text('我不会调用工具')])
      yield { type: 'result', subtype: 'success', stop_reason: opts.probeRespondsWithToolUse ? 'tool_use' : 'end_turn' }
      return
    }
    if (tools.length > 0) {
      modelCalls += 1
      const script = LOOP_SCRIPT[Math.min(loopTurn, LOOP_SCRIPT.length - 1)]
      loopTurn += 1
      yield assistant(script)
      yield {
        type: 'result',
        subtype: 'success',
        stop_reason: script.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
        usage: { input_tokens: 100 + loopTurn, output_tokens: 50 },
      }
      return
    }
    yield assistant([text('这不是 JSON')])
    yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
  }
  return { query, loopModelCalls: () => modelCalls }
}

function readAnalyticsEventTypes(): string[] {
  try {
    return readFileSync(getAnalyticsPath('default-software-builder'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { event_type: string }).event_type)
  } catch {
    return []
  }
}

function readDecisionLines(sessionId: string): string[] {
  try {
    return readFileSync(getAgentSessionPath(sessionId), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { role: string; content: Array<{ type: string; text?: string }> })
      .filter((message) => message.role === 'system')
      .map((message) => message.content.find((block) => block.type === 'text')?.text ?? '')
      .filter((value) => value.startsWith('[decision]'))
  } catch {
    return []
  }
}

describe('Agent Loop 全链（PR3：生成 → 自测 → 自修 → 终验 → judge → ready）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const originalFlag = process.env.BLOMA_AGENT_LOOP

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-accept-loop-'))
    process.env.BLOMA_AGENT_LOOP = '1'
    setSafeStorageAdapter({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
      decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
    })
    setBrowserGwtDisabledForTests(true)
    setSandboxRuntimeForTests({
      processFactory: () => fakeChild(),
      portAllocator: async () => 0, // 由用例内覆盖（需要先起真实文件服务器拿端口）
      healthCheck: async () => true,
    })
  })
  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    if (originalFlag === undefined) delete process.env.BLOMA_AGENT_LOOP
    else process.env.BLOMA_AGENT_LOOP = originalFlag
    setBrowserGwtDisabledForTests(false)
    clearSandboxRuntimeForTests()
  })

  it('flag + supports_tools=true：loop 全链到 ready，埋点/决策/JSONL 全留痕', async () => {
    // 渠道：模型显式 supports_tools=true（免探测直通 loop）
    createChannel({
      name: 'loop-channel',
      provider_type: 'anthropic',
      base_url: 'https://loop.example',
      api_key: 'key-loop',
      models: [{ id: 'm1', name: 'loop-model', enabled: true, supports_tools: true }],
    })
    const project = createProject({ request_id: 'req-acc-1', mode: 'quick', initial_message: '帮我做一个记账应用' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出', priority: 'P0' }])

    // 真实静态文件服务器（动态读项目文件——模型 write_file/edit_file 后立即可见）
    const server = createServer((req, res) => {
      const root = findProject(project.project_id).root_path
      const path = req.url === '/' ? '/index.html' : (req.url ?? '/index.html')
      try {
        const content = readFileSync(join(root, path.replace(/^\//, '')), 'utf8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(content)
      } catch {
        res.writeHead(404)
        res.end('Not Found')
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    setSandboxRuntimeForTests({
      processFactory: () => fakeChild(),
      portAllocator: async () => port,
      healthCheck: async () => true,
    })

    try {
      const { query, loopModelCalls } = scriptedQuery()
      const mvp = await runMvpTask({
        request_id: 'req-acc-1',
        session_id: 'session-acc-1',
        project_id: project.project_id,
        mode: 'quick',
        query,
      })

      // loop 路径标记 + 沙箱/快照/阶段推进
      expect(mvp.via_agent_loop).toBe(true)
      expect(mvp.preview_url).toBe(`http://localhost:${port}`)
      expect(findProject(project.project_id).current_stage).toBe('testing')
      expect(loopModelCalls()).toBe(LOOP_SCRIPT.length)
      // 系统接管文件由平台补齐（loop 工具无权写）
      expect(() => readFileSync(join(findProject(project.project_id).root_path, 'package.json'), 'utf8')).not.toThrow()

      // 外部强制终验（repair_internalized）→ judge → ready
      const flow = await runPostMvpTestingFlow({
        request_id: 'req-acc-1',
        session_id: 'session-acc-1',
        project_id: project.project_id,
        mode: 'quick',
        preview_url: mvp.preview_url,
        query,
        repair_internalized: true,
      })
      expect(flow.verdict).toBe('ready')
      expect(findProject(project.project_id).current_stage).toBe('ready')

      // 埋点：逐轮 + 完成 + 修复映射 + mvp_delivered 口径锚点
      const events = readAnalyticsEventTypes()
      expect(events.filter((type) => type === 'agent_loop_turn').length).toBe(LOOP_SCRIPT.length)
      expect(events).toContain('agent_loop_completed')
      expect(events).toContain('self_repair_triggered')
      expect(events).toContain('mvp_delivered')
      const mvpDelivered = readFileSync(getAnalyticsPath('default-software-builder'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event_type: string; payload: Record<string, unknown> })
        .find((event) => event.event_type === 'mvp_delivered')
      expect(mvpDelivered?.payload.via_agent_loop).toBe(true)

      // 决策日志：启用/结束均留痕
      const decisions = readDecisionLines('session-acc-1').join('\n')
      expect(decisions).toContain('Agent Loop 生成启用')
      expect(decisions).toContain('Agent Loop 结束（completed）')

      // 会话 JSONL：loop 落盘的 tool_use / tool_result 轮次
      const sessionText = readFileSync(getAgentSessionPath('session-acc-1'), 'utf8')
      expect(sessionText).toContain('"type":"tool_use"')
      expect(sessionText).toContain('"type":"tool_result"')
    } finally {
      server.close()
    }
  }, 20000)

  it('能力位缺省 → 探测通过 → 走 loop；探测拒绝 → 回退管道并落决策', async () => {
    createChannel({
      name: 'probe-channel',
      provider_type: 'anthropic',
      base_url: 'https://probe.example',
      api_key: 'key-probe',
      models: [{ id: 'm1', name: 'probe-model', enabled: true }], // supports_tools 缺省 → 探测
    })
    const project = createProject({ request_id: 'req-acc-2', mode: 'quick', initial_message: '记账' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])

    const server = createServer((req, res) => {
      const root = findProject(project.project_id).root_path
      const path = req.url === '/' ? '/index.html' : (req.url ?? '/index.html')
      try {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(readFileSync(join(root, path.replace(/^\//, '')), 'utf8'))
      } catch {
        res.writeHead(404)
        res.end('Not Found')
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    setSandboxRuntimeForTests({
      processFactory: () => fakeChild(),
      portAllocator: async () => port,
      healthCheck: async () => true,
    })

    try {
      // 探测通过（模型发起 tool_use）→ loop 全链（复用同一剧本）
      const { query, loopModelCalls } = scriptedQuery({ probeRespondsWithToolUse: true })
      const mvp = await runMvpTask({
        request_id: 'req-acc-2',
        session_id: 'session-acc-2',
        project_id: project.project_id,
        mode: 'quick',
        query,
      })
      expect(mvp.via_agent_loop).toBe(true)
      expect(loopModelCalls()).toBeGreaterThan(0)
      expect(readDecisionLines('session-acc-2').join('\n')).toContain('tool use 探测通过')
    } finally {
      server.close()
    }

    // 探测拒绝（模型不调工具）→ 缓存「不支持」→ 回退管道（无 MVP JSON → 既有报错语义）
    // 用独立渠道（探测缓存按 channel+model 键控，不能复用上面已探测通过的同渠道）
    const rejectChannel = createChannel({
      name: 'probe-reject-channel',
      provider_type: 'anthropic',
      base_url: 'https://probe-reject.example',
      api_key: 'key-probe-reject',
      models: [{ id: 'm1', name: 'probe-reject-model', enabled: true }],
    })
    const project2 = createProject({ request_id: 'req-acc-3', mode: 'quick', initial_message: '记账' })
    recordSketchGenerated(project2.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    const { query: rejectQuery } = scriptedQuery({ probeRespondsWithToolUse: false })
    await expect(
      runMvpTask({
        request_id: 'req-acc-3',
        session_id: 'session-acc-3',
        project_id: project2.project_id,
        mode: 'quick',
        channel_id: rejectChannel.id,
        query: rejectQuery,
      }),
    ).rejects.toThrow('MVP_LLM_PARSE_FAILED')
    expect(readDecisionLines('session-acc-3').join('\n')).toContain('tool use 探测未通过')
  })

  it('flag 关（BLOMA_AGENT_LOOP 未设）→ 分流不生效，走既有管道', async () => {
    delete process.env.BLOMA_AGENT_LOOP
    expect(agentLoopEnabled()).toBe(false)
    createChannel({
      name: 'off-channel',
      provider_type: 'anthropic',
      base_url: 'https://off.example',
      api_key: 'key-off',
      models: [{ id: 'm1', name: 'off-model', enabled: true, supports_tools: true }],
    })
    const project = createProject({ request_id: 'req-acc-4', mode: 'quick', initial_message: '记账' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    const { query } = scriptedQuery()
    // 管道路径拿不到合法 MVP JSON → 既有报错（证明 loop 完全未参与）
    await expect(
      runMvpTask({
        request_id: 'req-acc-4',
        session_id: 'session-acc-4',
        project_id: project.project_id,
        mode: 'quick',
        query,
      }),
    ).rejects.toThrow('MVP_LLM_PARSE_FAILED')
    expect(readDecisionLines('session-acc-4').join('\n')).not.toContain('Agent Loop 生成启用')
  })
})
