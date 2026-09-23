import { restorePromaHome } from '../../support/proma-home-guard'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAgentLoopPostTesting, runIterationTask, runMvpTask, agentLoopEnabled, setProgrammingEventPublisher } from '../../../main/coding/programming-orchestrator'
import { createProject, findProject, recordSketchGenerated } from '../../../main/project-service'
import { syncDocuments } from '../../../main/document-engine'
import { createChannel } from '../../../main/channel-manager'
import { setSafeStorageAdapter } from '../../../main/safe-storage'
import { clearSandboxRuntimeForTests, setSandboxRuntimeForTests } from '../../../main/platform-services'
import { setBrowserGwtDisabledForTests } from '../../../main/gwt-runner'
import { getAnalyticsPath, getAgentSessionPath, getDocumentsDir } from '../../../storage/config-paths'
import { listDelegations } from '../../../main/coding/agent-collaboration'
import type { MessageContentBlock, SDKMessage } from '../../../shared/types'
import type { SDKQuery, SDKQueryOptions } from '../../../main/orchestrator'

/**
 * Agent Loop 全链验收（PR3，mock 渠道）：flag + 能力位 → loop 生成（write_file →
 * run_preview → run_gwt_tests 失败 → 自修 → 再测通过 → 安全扫描）→ 独立门禁终验
 * （M4-A runAgentLoopPostTesting，只终验不重修）→ judge → ready。
 * M4-C 委派协作全链：父 loop delegate_agent → 子会话收敛 → delegation 生命周期事件。
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

/**
 * 假沙箱的 app-server 语义（完整程序阶段 2.5）：产线沙箱服务器已具备 /api/* 路由
 * 挂载能力，本文件的静态文件替身按此应答 200——本文件锁定的是流水线机制；契约
 * 强制力（探测分类/可达性跳过）由 tests/unit/coding/api-contract.test.ts 锁定。
 */
function fakeAppApiBranch(req: { url?: string }, res: { writeHead: (code: number, headers?: Record<string, string>) => void; end: (body?: string) => void }): boolean {
  if ((req.url ?? '').startsWith('/api/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ records: [] }))
    return true
  }
  return false
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
function scriptedQuery(opts: { probeRespondsWithToolUse?: boolean } = {}): { query: SDKQuery; loopModelCalls: () => number; providerTypes: Array<{ providerType: string | undefined; toolCount: number }> } {
  let loopTurn = 0
  let modelCalls = 0
  const providerTypes: Array<{ providerType: string | undefined; toolCount: number }> = []
  const query: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions) {
    const tools = options.tools ?? []
    providerTypes.push({ providerType: options.providerType, toolCount: tools.length })
    if (tools.some((tool) => tool.name === 'loop_support_probe')) {
      if (opts.probeRespondsWithToolUse) yield assistant([toolUse('probe-1', 'loop_support_probe', {})])
      else yield assistant([text('我不会调用工具')])
      yield { type: 'result', subtype: 'success', stop_reason: opts.probeRespondsWithToolUse ? 'tool_use' : 'end_turn' }
      return
    }
    // 收口/宽限轮（2026-08-29）：tools 已停用但 system 带收口/收尾指令 → 仍按剧本交卷并计数
    if (tools.length === 0 && /【收口】|【收尾】/.test(String(options.messages?.[0]?.content ?? ''))) {
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
  return { query, loopModelCalls: () => modelCalls, providerTypes }
}

/** M4-C 委派全链剧本：父 loop 写文件 → run_preview → delegate_agent + wait_for_delegations → 收尾。 */
const DELEGATION_SCRIPT: MessageContentBlock[][] = [
  [text('我先把页面写出来。'), toolUse('t1', 'write_file', { path: 'index.html', content: INDEX_V2 }), toolUse('t2', 'write_file', { path: 'src/app.js', content: APP_JS })],
  [toolUse('t3', 'run_preview', {})],
  [toolUse('t4', 'delegate_agent', { task: '检查 index.html 是否包含收入支出入口', role: 'explore' }), toolUse('t5', 'wait_for_delegations', { strategy: 'all', timeout_ms: 10000 })],
  [text('完成：记账 MVP 已就绪，委派子会话已收敛。')],
]

/**
 * 委派感知的 mock 渠道：按工具集区分父/子 loop（父含 delegate_agent；子 explore 只读工具集
 * 不含委派工具 → 一轮文本收尾）。父子共享同一 query 闭包，但计数独立。
 */
function delegationScriptedQuery(): { query: SDKQuery; parentModelCalls: () => number } {
  let parentTurn = 0
  let parentCalls = 0
  const query: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions) {
    const tools = options.tools ?? []
    if (tools.some((tool) => tool.name === 'loop_support_probe')) {
      yield assistant([toolUse('probe-1', 'loop_support_probe', {})])
      yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' }
      return
    }
    if (tools.length === 0) {
      yield assistant([text('这不是 JSON')])
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
      return
    }
    // 父 loop：含 delegate_agent → 走父剧本
    if (tools.some((tool) => tool.name === 'delegate_agent')) {
      parentCalls += 1
      const script = DELEGATION_SCRIPT[Math.min(parentTurn, DELEGATION_SCRIPT.length - 1)]
      parentTurn += 1
      yield assistant(script)
      yield {
        type: 'result',
        subtype: 'success',
        stop_reason: script.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
        usage: { input_tokens: 100 + parentTurn, output_tokens: 50 },
      }
      return
    }
    // 子 loop（explore 只读工具集）：一轮文本收尾
    yield assistant([text('子任务完成：index.html 已包含收入支出入口，检查通过。')])
    yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
  }
  return { query, parentModelCalls: () => parentCalls }
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
  const originalVision = process.env.BLOMA_VISION_AUDIT

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-accept-loop-'))
    process.env.BLOMA_AGENT_LOOP = '1'
    process.env.BLOMA_VISION_AUDIT = '0' // 验收不真打双视觉 LLM（临时 PROMA_HOME 本就无渠道，此为双保险）
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
    restorePromaHome(originalPromaHome)
    if (originalFlag === undefined) delete process.env.BLOMA_AGENT_LOOP
    else process.env.BLOMA_AGENT_LOOP = originalFlag
    if (originalVision === undefined) delete process.env.BLOMA_VISION_AUDIT
    else process.env.BLOMA_VISION_AUDIT = originalVision
    setBrowserGwtDisabledForTests(false)
    clearSandboxRuntimeForTests()
    setProgrammingEventPublisher(() => undefined)
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
      if (fakeAppApiBranch(req, res)) return
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

      // M4-A 独立门禁终验（loop 结果透传 judge，只终验不重修）→ judge → ready
      const flow = await runAgentLoopPostTesting({
        request_id: 'req-acc-1',
        session_id: 'session-acc-1',
        project_id: project.project_id,
        mode: 'quick',
        preview_url: mvp.preview_url,
        loop: mvp.loop_result!,
      })
      expect(flow.verdict).toBe('ready')
      expect(findProject(project.project_id).current_stage).toBe('ready')

      // 埋点：逐轮 + 完成 + 修复映射 + 裁判判定 + mvp_delivered 口径锚点
      const events = readAnalyticsEventTypes()
      expect(events.filter((type) => type === 'agent_loop_turn').length).toBe(LOOP_SCRIPT.length)
      expect(events).toContain('agent_loop_completed')
      expect(events).toContain('self_repair_triggered')
      expect(events).toContain('judge_verdict')
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

  // omit 渠道全链测试暂移除：依赖 agent-loop providerType 透传消费（agent-loop 半合并保留本地版，下轮 compacting-window 整合时从队友分支取回恢复）

  it('omit 渠道（zhipu-coding）全链：每次模型调用都携带渠道 providerType（编排队→agent-loop→query 透传锁定，omit 待办②）', async () => {
    createChannel({
      name: 'omit-channel',
      provider_type: 'zhipu-coding',
      base_url: 'https://omit.example',
      api_key: 'key-omit',
      models: [{ id: 'm1', name: 'omit-model', enabled: true, supports_tools: true }],
    })
    const project = createProject({ request_id: 'req-acc-omit', mode: 'quick', initial_message: '帮我做一个记账应用' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出', priority: 'P0' }])

    const server = createServer((req, res) => {
      if (fakeAppApiBranch(req, res)) return
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
      const { query, providerTypes } = scriptedQuery()
      const mvp = await runMvpTask({
        request_id: 'req-acc-omit',
        session_id: 'session-acc-omit',
        project_id: project.project_id,
        mode: 'quick',
        query,
      })

      // 透传锁定：每次带 tools 的模型调用（探测/loop 轮）的 options.providerType 都等于渠道 provider_type。
      // 若编排队构造丢字段，omit 渠道在真实 anthropicMessagesQuery 下会发 thinking:disabled → 400。
      // 无工具附属调用（autoName 命名等）不计入——不透传只是多一次 400 兼容重试（omit 待办③已裁定优雅降级）。
      expect(mvp.via_agent_loop).toBe(true)
      const withTools = providerTypes.filter((call) => call.toolCount > 0)
      // 本地收口机制（wrapUp）会让末轮在无工具收口轮交卷（toolCount=0 不计入）：
      // 数量断言放宽为 >0，核心意图保留——所有带工具调用都带渠道 providerType
      expect(withTools.length).toBeGreaterThan(0)
      expect(withTools.every((call) => call.providerType === 'zhipu-coding')).toBe(true)
      expect(findProject(project.project_id).current_stage).toBe('testing')
    } finally {
      server.close()
    }
  }, 20000)

  it('M4-C 委派全链：父 loop delegate_agent → 子会话收敛 → 生命周期事件发布 → 终验 ready', async () => {
    createChannel({
      name: 'delegation-channel',
      provider_type: 'anthropic',
      base_url: 'https://delegation.example',
      api_key: 'key-del',
      models: [{ id: 'm1', name: 'delegation-model', enabled: true, supports_tools: true }],
    })
    const project = createProject({ request_id: 'req-acc-del', mode: 'quick', initial_message: '帮我做一个记账应用' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出', priority: 'P0' }])

    // 真实静态文件服务器（delegate 子会话 read_file 也读项目文件，必须真实落盘）
    const server = createServer((req, res) => {
      if (fakeAppApiBranch(req, res)) return
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

    // 捕获发布事件（delegation 生命周期经编程事件通道发到父 loop session）
    const events: Array<{ type: string; session_id: string; payload: Record<string, unknown> }> = []
    setProgrammingEventPublisher((event) =>
      events.push({ type: event.type, session_id: event.session_id, payload: event.payload as Record<string, unknown> }),
    )

    try {
      const { query, parentModelCalls } = delegationScriptedQuery()
      const mvp = await runMvpTask({
        request_id: 'req-acc-del',
        session_id: 'session-del',
        project_id: project.project_id,
        mode: 'quick',
        query,
      })
      expect(mvp.via_agent_loop).toBe(true)
      expect(parentModelCalls()).toBe(DELEGATION_SCRIPT.length)

      // 委派生命周期事件发布到父 loop session（渲染端据此派生协作视图）
      const started = events.filter((event) => event.type === 'delegation_started')
      expect(started).toHaveLength(1)
      expect(started[0].session_id).toBe('session-del')
      expect(started[0].payload).toMatchObject({ role: 'explore', status: 'running' })
      expect(started[0].payload.delegation_id).toBeTruthy()
      expect(started[0].payload.child_session_id).toBeTruthy()

      const completed = events.filter((event) => event.type === 'delegation_completed')
      expect(completed).toHaveLength(1)
      expect(completed[0].session_id).toBe('session-del')
      expect(completed[0].payload.delegation_id).toBe(started[0].payload.delegation_id)
      expect(completed[0].payload.status).toBe('completed')

      // 独立门禁终验（loop 结果透传 judge）→ ready
      const flow = await runAgentLoopPostTesting({
        request_id: 'req-acc-del',
        session_id: 'session-del',
        project_id: project.project_id,
        mode: 'quick',
        preview_url: mvp.preview_url,
        loop: mvp.loop_result!,
      })
      expect(flow.verdict).toBe('ready')
      expect(findProject(project.project_id).current_stage).toBe('ready')
    } finally {
      server.close()
    }
  }, 20000)

  it('M4-A iterating 走 loop 锁定：迭代终验失败只让渡不重修（无 repairing，loop 门禁生效）', async () => {
    createChannel({
      name: 'iter-loop-channel',
      provider_type: 'anthropic',
      base_url: 'https://iter-loop.example',
      api_key: 'key-iter-loop',
      models: [{ id: 'm1', name: 'iter-loop-model', enabled: true, supports_tools: true }],
    })
    const project = createProject({ request_id: 'req-acc-iter', mode: 'quick', initial_message: '帮我做一个记账应用' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出', priority: 'P0' }])

    // 可切换的失败开关：初始生成走通过内容；迭代阶段走持续失败（逼出终验失败路径）
    let shouldFail = false
    const server = createServer((req, res) => {
      if (fakeAppApiBranch(req, res)) return
      const root = findProject(project.project_id).root_path
      const path = req.url === '/' ? '/index.html' : (req.url ?? '/index.html')
      try {
        if (!shouldFail) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(readFileSync(join(root, path.replace(/^\//, '')), 'utf8'))
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end('<html><h1>持续失败</h1></html>')
        }
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

    const events: string[] = []
    setProgrammingEventPublisher((event) => events.push(event.type))

    try {
      // 初始生成：loop 全链 → ready（loop 路径标记持久化）
      const firstQuery = scriptedQuery()
      const mvp = await runMvpTask({
        request_id: 'req-acc-iter',
        session_id: 'session-iter',
        project_id: project.project_id,
        mode: 'quick',
        query: firstQuery.query,
      })
      expect(mvp.via_agent_loop).toBe(true)
      const firstGate = await runAgentLoopPostTesting({
        request_id: 'req-acc-iter',
        session_id: 'session-iter',
        project_id: project.project_id,
        mode: 'quick',
        preview_url: mvp.preview_url,
        loop: mvp.loop_result!,
      })
      expect(firstGate.verdict).toBe('ready')
      expect(findProject(project.project_id).current_stage).toBe('ready')

      // 迭代：切换到失败内容 → loop 重新生成 → 门禁终验首败即熔断回滚（loop 内修复预算已用尽）
      shouldFail = true
      events.length = 0
      const iterQuery = scriptedQuery()
      // 存在健康快照（初始 ready 快照）→ 首败熔断回滚并抛 CircuitBreakSettledError，runIterationTask 如实上抛
      await expect(
        runIterationTask({
          request_id: 'req-acc-iter',
          session_id: 'session-iter',
          project_id: project.project_id,
          mode: 'quick',
          prompt: '把按钮改成蓝色',
          query: iterQuery.query,
        }),
      ).rejects.toThrow('REPAIR_CIRCUIT_SETTLED')
      // 只终验不重修：迭代终验失败零 repairing、零修复计数（旧管道会 repairing ×3 后让渡）
      expect(events.filter((type) => type === 'repairing')).toHaveLength(0)
      expect(findProject(project.project_id).test_repair_count ?? 0).toBe(0)
      // 回滚收尾：回到健康版本（ready），内容未丢失
      expect(findProject(project.project_id).current_stage).toBe('ready')
      // 熔断路径不触发 changelog（GA-03：iteration_completed 仅在成功收尾触发）
      expect(
        existsSync(join(getDocumentsDir(project.workspace_slug, project.project_id), 'iteration_completed.md')),
      ).toBe(false)
    } finally {
      server.close()
    }
    // M4-A 全链用例为真实 sandbox + 子进程模拟的重负载：隔离实测约 17s，20s 余量不足，
    // 全量并行（多 worker CPU/IO 争抢）下多次超时 → 放宽到 60s（2026-09-08 负载校准）
  }, 60000)

  it('迭代成功收尾 → iteration_completed changelog 落盘（GA-03，PRD §7.1 每轮迭代后追加）', async () => {
    createChannel({
      name: 'iter-changelog-channel',
      provider_type: 'anthropic',
      base_url: 'https://iter-changelog.example',
      api_key: 'key-iter-changelog',
      models: [{ id: 'm1', name: 'iter-changelog-model', enabled: true, supports_tools: true }],
    })
    const project = createProject({ request_id: 'req-acc-iter-ok', mode: 'quick', initial_message: '帮我做一个记账应用' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出', priority: 'P0' }])

    const server = createServer((req, res) => {
      if (fakeAppApiBranch(req, res)) return
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
      // 初始生成 → ready（loop 全链）
      const firstQuery = scriptedQuery()
      const mvp = await runMvpTask({
        request_id: 'req-acc-iter-ok',
        session_id: 'session-iter-ok',
        project_id: project.project_id,
        mode: 'quick',
        query: firstQuery.query,
      })
      const firstGate = await runAgentLoopPostTesting({
        request_id: 'req-acc-iter-ok',
        session_id: 'session-iter-ok',
        project_id: project.project_id,
        mode: 'quick',
        preview_url: mvp.preview_url,
        loop: mvp.loop_result!,
      })
      expect(firstGate.verdict).toBe('ready')
      expect(findProject(project.project_id).current_stage).toBe('ready')

      // 迭代：重新生成一版 → 终验 → ready，收尾追加 changelog
      const iterQuery = scriptedQuery()
      await runIterationTask({
        request_id: 'req-acc-iter-ok',
        session_id: 'session-iter-ok',
        project_id: project.project_id,
        mode: 'quick',
        prompt: '把导出报表改成按年汇总',
        query: iterQuery.query,
      })

      const dir = getDocumentsDir(project.workspace_slug, project.project_id)
      const changelog = readFileSync(join(dir, 'iteration_completed.md'), 'utf8')
      expect(changelog).toContain('变更记录')
      expect(changelog).toContain('F-001')
      expect(changelog).toContain('记录收入与支出')
      // 本轮修改诉求并入功能项后也进入 changelog（合并本轮反馈）：锁定新增项 id F-002
      expect(changelog).toContain('F-002')
      expect(changelog).toContain('按年汇总')
      // 时间戳：迭代完成时刻
      expect(changelog).toMatch(/\d{4}-\d{2}-\d{2}/)
      // 阶段如实收尾 ready
      expect(findProject(project.project_id).current_stage).toBe('ready')
    } finally {
      server.close()
    }
  }, 25000)

  it('迭代中用户停止 → loop cancelled 即中止：不交付、不终验、不熔断、阶段回 ready（U5，2026-08-25 线上案例）', async () => {
    createChannel({
      name: 'cancel-loop-channel',
      provider_type: 'anthropic',
      base_url: 'https://cancel-loop.example',
      api_key: 'key-cancel-loop',
      models: [{ id: 'm1', name: 'cancel-loop-model', enabled: true, supports_tools: true }],
    })
    const project = createProject({ request_id: 'req-acc-cancel', mode: 'quick', initial_message: '帮我做一个记账应用' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出', priority: 'P0' }])

    const events: string[] = []
    setProgrammingEventPublisher((event) => events.push(event.type))

    // 用户在再生成启动前已点「停止」：signal 已 abort → loop 首轮检查即 cancelled（0 轮）
    const controller = new AbortController()
    controller.abort(new Error('AGENT_CANCELLED: user_cancelled'))
    await expect(
      runIterationTask({
        request_id: 'req-acc-cancel',
        session_id: 'session-cancel',
        project_id: project.project_id,
        mode: 'quick',
        prompt: '把按钮改成蓝色',
        query: scriptedQuery().query,
        signal: controller.signal,
      }),
    ).rejects.toThrow('AGENT_CANCELLED')

    // cancelled 不再走「补脚手架→交付→终验→熔断」：无交付终态、无回滚
    expect(events).not.toContain('mvp_ready')
    expect(events).not.toContain('rollback_done')
    // U5：用户主动停止不补失败话术/重试卡片/错误事件（渲染端已落「已停止生成」）
    expect(events).not.toContain('user_decision_required')
    expect(events).not.toContain('error')
    // 迭代取消如实回 ready，阶段不滞留 iterating
    expect(findProject(project.project_id).current_stage).toBe('ready')
    // 取消路径不触发 changelog（GA-03：iteration_completed 仅在成功收尾触发）
    expect(
      existsSync(join(getDocumentsDir(project.workspace_slug, project.project_id), 'iteration_completed.md')),
    ).toBe(false)
  })

  it('能力位缺省 → 探测通过 → 走 loop；探测拒绝 → 如实抛错并落决策', async () => {
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
      if (fakeAppApiBranch(req, res)) return
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

    // 探测拒绝（模型不调工具）→ 缓存「不支持」→ 如实抛错（唯一运行时，无管道可回退）
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
    ).rejects.toThrow('当前渠道未通过工具能力探测')
    expect(readDecisionLines('session-acc-3').join('\n')).toContain('tool use 探测未通过')
  })

  it('flag 未设 → 默认走 loop（D5 缺省开启），复用脚本生成到 ready', async () => {
    delete process.env.BLOMA_AGENT_LOOP
    expect(agentLoopEnabled()).toBe(true)
    createChannel({
      name: 'default-on-channel',
      provider_type: 'anthropic',
      base_url: 'https://default-on.example',
      api_key: 'key-default-on',
      models: [{ id: 'm1', name: 'default-on-model', enabled: true, supports_tools: true }],
    })
    const project = createProject({ request_id: 'req-acc-4', mode: 'quick', initial_message: '记账' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])

    const server = createServer((req, res) => {
      if (fakeAppApiBranch(req, res)) return
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
      const { query } = scriptedQuery()
      const mvp = await runMvpTask({
        request_id: 'req-acc-4',
        session_id: 'session-acc-4',
        project_id: project.project_id,
        mode: 'quick',
        query,
      })
      expect(mvp.via_agent_loop).toBe(true)
      expect(readDecisionLines('session-acc-4').join('\n')).toContain('Agent Loop 生成启用')
    } finally {
      server.close()
    }
  }, 20000)

  it('BLOMA_AGENT_LOOP=0 → 明确关闭，runMvpTask 如实抛错并落「Agent Loop 不可用」', async () => {
    process.env.BLOMA_AGENT_LOOP = '0'
    expect(agentLoopEnabled()).toBe(false)
    createChannel({
      name: 'off-channel',
      provider_type: 'anthropic',
      base_url: 'https://off.example',
      api_key: 'key-off',
      models: [{ id: 'm1', name: 'off-model', enabled: true, supports_tools: true }],
    })
    const project = createProject({ request_id: 'req-acc-5', mode: 'quick', initial_message: '记账' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    const { query } = scriptedQuery()
    await expect(
      runMvpTask({
        request_id: 'req-acc-5',
        session_id: 'session-acc-5',
        project_id: project.project_id,
        mode: 'quick',
        query,
      }),
    ).rejects.toThrow('Agent Loop 已关闭或缺少模型调用句柄')
    expect(readDecisionLines('session-acc-5').join('\n')).not.toContain('Agent Loop 生成启用')
    expect(readDecisionLines('session-acc-5').join('\n')).toContain('Agent Loop 不可用')
  })

  // ---- 2026-08-26 移植：独立补盲中远端缺失的 M3 落盘契约 / P1-2 孤儿清理 / M2 安全熔断 ----

  it('[S4-AGENT-005] loop 生成后 via_agent_loop / agent_loop_status 落盘持久化（H2 resume 依赖此契约）', async () => {
    createChannel({
      name: 'persist-loop-channel',
      provider_type: 'anthropic',
      base_url: 'https://persist-loop.example',
      api_key: 'key-persist-loop',
      models: [{ id: 'm1', name: 'persist-loop-model', enabled: true, supports_tools: true }],
    })
    const project = createProject({ request_id: 'req-acc-persist', mode: 'quick', initial_message: '帮我做一个记账应用' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出', priority: 'P0' }])

    const server = createServer((req, res) => {
      if (fakeAppApiBranch(req, res)) return
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
      const { query } = scriptedQuery()
      const mvp = await runMvpTask({
        request_id: 'req-acc-persist',
        session_id: 'session-persist',
        project_id: project.project_id,
        mode: 'quick',
        query,
      })
      expect(mvp.via_agent_loop).toBe(true)
      expect(mvp.loop_result?.status).toBe('completed')
      const persisted = findProject(project.project_id)
      expect(persisted.via_agent_loop).toBe(true)
      expect(persisted.agent_loop_status).toBe('completed')
    } finally {
      server.close()
    }
  }, 20000)

  it('[S4-AGENT-006] loop 轮次耗尽（turn_limit）→ agent_loop_status 落盘为 turn_limit', async () => {
    createChannel({
      name: 'persist-limit-channel',
      provider_type: 'anthropic',
      base_url: 'https://persist-limit.example',
      api_key: 'key-persist-limit',
      models: [{ id: 'm1', name: 'persist-limit-model', enabled: true, supports_tools: true }],
    })
    const project = createProject({ request_id: 'req-acc-limit', mode: 'quick', initial_message: '帮我做一个记账应用' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出', priority: 'P0' }])

    const server = createServer((req, res) => {
      if (fakeAppApiBranch(req, res)) return
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

    // LIMIT 剧本：第一轮 write_file 落盘 index.html（避免 AGENT_LOOP_INCOMPLETE 提前报错），
    // 后续每轮调未知工具（即时 is_error）→ 循环永不收敛 → 跑满 AGENT_LOOP_MAX_TURNS(quick=24) → turn_limit
    let loopTurn = 0
    const limitQuery: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions) {
      if (options.tools?.some((tool) => tool.name === 'loop_support_probe')) {
        yield assistant([toolUse('probe-1', 'loop_support_probe', {})])
        yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' }
        return
      }
      if ((options.tools ?? []).length > 0) {
        loopTurn += 1
        const blocks =
          loopTurn === 1
            ? [toolUse('t1', 'write_file', { path: 'index.html', content: '<html><body><p>记账</p></body></html>' })]
            : [toolUse('l-1', 'no_such_tool', {})]
        yield assistant(blocks)
        yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' }
        return
      }
      // 宽限收口轮（本地机制 2026-08-29）：tools 已停用但模型仍坚持要工具 → 如实 turn_limit
      yield assistant([toolUse('g-1', 'no_such_tool', {})])
      yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' }
    }

    try {
      const mvp = await runMvpTask({
        request_id: 'req-acc-limit',
        session_id: 'session-limit',
        project_id: project.project_id,
        mode: 'quick',
        query: limitQuery,
      })
      expect(mvp.via_agent_loop).toBe(true)
      expect(mvp.loop_result?.status).toBe('turn_limit')
      expect(findProject(project.project_id).agent_loop_status).toBe('turn_limit')
      expect(findProject(project.project_id).via_agent_loop).toBe(true)
    } finally {
      server.close()
    }
  }, 30000)

  it('[S4-AGENT-008] 父 loop 结束时仍有 running 子委派 → finally 清理为 cancelled，不泄漏（P1-2）', async () => {
    createChannel({
      name: 'orphan-loop-channel',
      provider_type: 'anthropic',
      base_url: 'https://orphan-loop.example',
      api_key: 'key-orphan-loop',
      models: [{ id: 'm1', name: 'orphan-loop-model', enabled: true, supports_tools: true }],
    })
    const project = createProject({ request_id: 'req-acc-orphan', mode: 'quick', initial_message: '帮我做一个记账应用' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出', priority: 'P0' }])

    const server = createServer((req, res) => {
      if (fakeAppApiBranch(req, res)) return
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

    // 父 loop：写文件 → delegate_agent（fire-and-forget，不 wait）→ 文本收尾 → 父 completed
    // 子 loop：第一轮 ask_delegation_question 挂起（父不答 → 子停在 running）
    const ORPHAN_SCRIPT: MessageContentBlock[][] = [
      [text('我先把页面写出来。'), toolUse('t1', 'write_file', { path: 'index.html', content: INDEX_V2 })],
      [toolUse('t2', 'delegate_agent', { task: '调研配色方案', role: 'explore' })],
      [text('完成：记账 MVP 已就绪。')],
    ]
    let parentTurn = 0
    const orphanQuery: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions) {
      const tools = options.tools ?? []
      if (tools.some((tool) => tool.name === 'loop_support_probe')) {
        yield assistant([toolUse('probe-1', 'loop_support_probe', {})])
        yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' }
        return
      }
      if (tools.length === 0) {
        yield assistant([text('这不是 JSON')])
        yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
        return
      }
      if (tools.some((tool) => tool.name === 'delegate_agent')) {
        const script = ORPHAN_SCRIPT[Math.min(parentTurn, ORPHAN_SCRIPT.length - 1)]
        parentTurn += 1
        yield assistant(script)
        yield {
          type: 'result',
          subtype: 'success',
          stop_reason: script.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
        }
        return
      }
      // 子 loop（explore 只读含 ask）：第一轮 ask 挂起，父不答 → 停在 running
      yield assistant([toolUse('ask-1', 'ask_delegation_question', { question: '用什么配色？' })])
      yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' }
    }

    try {
      const mvp = await runMvpTask({
        request_id: 'req-acc-orphan',
        session_id: 'session-orphan',
        project_id: project.project_id,
        mode: 'quick',
        query: orphanQuery,
      })
      expect(mvp.via_agent_loop).toBe(true)
      // 父 loop 已收尾（completed）；running 的子委派必须被 finally 清理为 cancelled
      const orphans = listDelegations('session-orphan')
      expect(orphans.length).toBe(1)
      expect(orphans[0]!.status).toBe('cancelled')
    } finally {
      server.close()
    }
  }, 20000)

  it('[S4-JUDGE-004] GWT 通过但安全扫描不过（产物含 eval 高危）→ security_repair 让渡，零 repairing（M2）', async () => {
    setBrowserGwtDisabledForTests(true)
    const home = mkdtempSync(join(tmpdir(), 'proma-loop-sec-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    syncDocuments({ request_id: 'req-sync', session_id: 'session-1', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
    // 磁盘产物：命中 GWT 特征词 + 高危 eval（OWASP critical）→ 安全扫描 passed=false；
    // 界面为合法极简应用（L0 UI 门禁实跑：真控件+点击反应，不拦本用例要验的安全链）
    const JUDGE004_PAGE = '<html><body><h1>记账本</h1><p>记录收入与支出，支持每日流水查看</p><input aria-label="金额"><button>记一笔</button><script>const r = eval("1+1");document.querySelector("button").addEventListener("click",function(){document.querySelector("p").textContent="已记录收入与支出，流水已更新"})</script></body></html>'
    writeFileSync(
      join(project.root_path, 'index.html'),
      JUDGE004_PAGE,
      'utf8',
    )
    const events: string[] = []
    setProgrammingEventPublisher((event) => events.push(event.type))

    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(JUDGE004_PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const result = await runAgentLoopPostTesting({
        request_id: 'req-flow',
        session_id: 'session-1',
        project_id: project.project_id,
        mode: 'quick',
        preview_url: `http://127.0.0.1:${port}`,
        loop: { status: 'completed', turns: 8, finalText: '完成', toolCalls: [] },
      })
      expect(result.verdict).toBe('blocked')
      expect(findProject(project.project_id).current_stage).toBe('blocked_for_user_decision')
      expect(findProject(project.project_id).blocked_action).toBe('security_repair')
      expect(events.filter((type) => type === 'repairing')).toHaveLength(0)
      expect(events.filter((type) => type === 'judge_result')).toHaveLength(0)
      expect(findProject(project.project_id).test_repair_count ?? 0).toBe(0)
    } finally {
      server.close()
    }
  })

  it('[S4-GATE-001] 断言横幅骗过文本型 GWT 的假界面产物 → L0 UI-GATE 判败，终验不通过不转裁判', async () => {
    // 静态 GWT（文本断言模式）：假界面复刻 G-07dbf2c2 案——div 假按钮（0 真控件）+
    // 把验收断言话术印进页面。若无 L0，零功能壳子会因文本断言命中而全绿出厂。
    setBrowserGwtDisabledForTests(true)
    const home = mkdtempSync(join(tmpdir(), 'bloma-gate-fakeui-'))
    process.env.PROMA_HOME = home
    const FAKE_UI_PAGE = '<html><head><style>body{font-family:sans-serif}</style></head><body><h1>记账本</h1><p>记录收入与支出，支持每日流水查看</p><div class="proma-btn">记一笔</div><p>该功能项在产物中 可见 且 可交互 — 输入内容、点击按钮、查看结果</p></body></html>'
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    syncDocuments({ request_id: 'req-sync', session_id: 'session-1', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
    writeFileSync(join(project.root_path, 'index.html'), FAKE_UI_PAGE, 'utf8')
    const events: string[] = []
    setProgrammingEventPublisher((event) => events.push(event.type))

    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(FAKE_UI_PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const result = await runAgentLoopPostTesting({
        request_id: 'req-flow',
        session_id: 'session-1',
        project_id: project.project_id,
        mode: 'quick',
        preview_url: `http://127.0.0.1:${port}`,
        loop: { status: 'completed', turns: 8, finalText: '完成', toolCalls: [] },
      })
      // 无 query 不起修复轮 → 熔断让渡（blocked 卡先修再验入口 B 由单测覆盖）
      expect(result.verdict).toBe('blocked')
      expect(result.test_result.failure_summary.some((f) => f.scenario.startsWith('UI-GATE '))).toBe(true)
      expect(findProject(project.project_id).current_stage).toBe('blocked_for_user_decision')
      expect(findProject(project.project_id).blocked_action).toBe('test_repair')
      // 未进安全扫描/裁判：门禁在 GWT 同轮掐断
      expect(events.filter((type) => type === 'judge_result')).toHaveLength(0)
    } finally {
      server.close()
    }
  })
})
