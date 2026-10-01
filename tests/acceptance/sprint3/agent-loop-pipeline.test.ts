import { restorePromaHome } from '../../support/proma-home-guard'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAgentLoopPostTesting, runIterationTask, runMvpTask, setProgrammingEventPublisher } from '../../../main/coding/programming-orchestrator'
import { createProject, findProject, recordSketchGenerated } from '../../../main/project/project-service'
import { syncDocuments } from '../../../main/project/document-engine'
import { createChannel } from '../../../main/platform/llm/channel-manager'
import { setSafeStorageAdapter } from '../../../main/platform/storage/safe-storage'
import { clearSandboxRuntimeForTests, setSandboxRuntimeForTests } from '../../../main/delivery/sandbox'
import { setBrowserGwtDisabledForTests } from '../../../main/verification/gwt-runner'
import { getAnalyticsPath, getAgentSessionPath, getDocumentsDir } from '../../../storage/config-paths'
import { listDelegations } from '../../../main/agent/delegation/agent-collaboration'
import type { MessageContentBlock, SDKMessage } from '../../../shared/types'
import type { SDKQuery, SDKQueryOptions } from '../../../main/orchestration/orchestrator'

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
