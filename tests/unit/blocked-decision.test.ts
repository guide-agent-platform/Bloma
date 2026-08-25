import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import type { ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncDocuments } from '../../main/document-engine'
import {
  resolveBlockedDecision,
  resumeBlockedFlow,
  setProgrammingEventPublisher,
} from '../../main/programming-orchestrator'
import { createProject, findProject, recordSketchGenerated, updateProject } from '../../main/project-service'
import { createChannel } from '../../main/channel-manager'
import { setSafeStorageAdapter } from '../../main/safe-storage'
import {
  clearSandboxRuntimeForTests,
  setSandboxRuntimeForTests,
  setSnapshotCaptureProviderForTests,
} from '../../main/platform-services'
import { setBrowserGwtDisabledForTests } from '../../main/gwt-runner'
import type { SDKQuery, SDKQueryOptions } from '../../main/orchestrator'
import type { AgentEvent, MessageContentBlock, SDKMessage } from '../../shared/types'

/**
 * A2/A3 — 阻塞态让渡 + resume 闭环。
 *
 * 锁定两件事：
 * - resolveBlockedDecision：消费 metadata.selected_option_id（A3），并区分编程阻塞 vs 引导澄清。
 * - resumeBlockedFlow：继续/接受/补充说明三分支的真实语义（A2），而非退回重新澄清。
 */
describe('Blocked decision resume loop (A2/A3)', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    setProgrammingEventPublisher(() => undefined)
    clearSandboxRuntimeForTests()
    setSnapshotCaptureProviderForTests()
    setBrowserGwtDisabledForTests(false)
  })

  function makeBlockedProject(blockedAction: 'mvp_repair' | 'test_repair' | 'judge_return') {
    const home = mkdtempSync(join(tmpdir(), 'proma-blocked-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    updateProject(project.project_id, { blocked_action: blockedAction })
    return project
  }

  describe('resolveBlockedDecision', () => {
    it('returns undefined for non-blocked stages even if blocked_action is set', () => {
      const project = makeBlockedProject('mvp_repair')
      const decision = resolveBlockedDecision({
        request_id: 'req', session_id: 's', project_id: project.project_id,
        content: '继续尝试', mode: 'quick', current_stage: 'generating_mvp',
        metadata: { source: 'card_option', selected_option_id: 'continue' },
      })
      expect(decision).toBeUndefined()
    })

    it('returns undefined for the clarification blocked state (no blocked_action)', () => {
      const home = mkdtempSync(join(tmpdir(), 'proma-blocked-'))
      process.env.PROMA_HOME = home
      const project = createProject({ request_id: 'req-project', mode: 'quick' })
      // 引导澄清态：current_stage 也是 blocked_for_user_decision，但没有 blocked_action
      const decision = resolveBlockedDecision({
        request_id: 'req', session_id: 's', project_id: project.project_id,
        content: '范围选项', mode: 'quick', current_stage: 'blocked_for_user_decision',
        metadata: { source: 'card_option', selected_option_id: 'scope' },
      })
      expect(decision).toBeUndefined()
    })

    it('maps card_option selected_option_id to the corresponding decision (A3)', () => {
      const project = makeBlockedProject('test_repair')
      const base = { request_id: 'req', session_id: 's', project_id: project.project_id, mode: 'quick' as const }
      const resolve = (id: string) => resolveBlockedDecision({
        ...base, content: '', current_stage: 'blocked_for_user_decision',
        metadata: { source: 'card_option', selected_option_id: id },
      })
      expect(resolve('continue')).toBe('continue')
      expect(resolve('accept')).toBe('accept')
      expect(resolve('explain')).toBe('explain')
    })

    it('falls back to continue for an unknown card option id', () => {
      const project = makeBlockedProject('mvp_repair')
      const decision = resolveBlockedDecision({
        request_id: 'req', session_id: 's', project_id: project.project_id,
        content: '', mode: 'quick', current_stage: 'blocked_for_user_decision',
        metadata: { source: 'card_option', selected_option_id: 'some-legacy-id' },
      })
      expect(decision).toBe('continue')
    })

    it('falls back to free-text heuristics when the user types instead of tapping a card', () => {
      const project = makeBlockedProject('judge_return')
      const base = { request_id: 'req', session_id: 's', project_id: project.project_id, mode: 'quick' as const }
      const resolve = (content: string) => resolveBlockedDecision({
        ...base, content, current_stage: 'blocked_for_user_decision', metadata: { source: 'chat' },
      })
      expect(resolve('接受现状，就这样吧')).toBe('accept')
      expect(resolve('继续尝试再修一次')).toBe('continue')
      expect(resolve('这里不该这样')).toBe('explain')
    })
  })

  describe('resumeBlockedFlow', () => {
    it('accept → clears the block, resets counts, and moves the project to ready', async () => {
      const project = makeBlockedProject('test_repair')
      updateProject(project.project_id, { runtime_repair_count: 3, test_repair_count: 3, judge_return_count: 2 })
      const events: AgentEvent[] = []
      setProgrammingEventPublisher((event) => events.push(event))

      await resumeBlockedFlow(
        { request_id: 'req', session_id: 's', project_id: project.project_id, mode: 'quick', decision: 'accept', content: '' },
        (event) => events.push(event),
      )

      const after = findProject(project.project_id)
      expect(after.current_stage).toBe('ready')
      expect(after.blocked_action).toBeUndefined()
      expect(after.runtime_repair_count).toBe(0)
      expect(after.test_repair_count).toBe(0)
      expect(after.judge_return_count).toBe(0)
      expect(events.some((event) => event.type === 'stage_changed' && event.payload.stage === 'ready')).toBe(true)
    })

    it('explain → clears the block and returns to the clarifying stage', async () => {
      const project = makeBlockedProject('mvp_repair')
      const events: AgentEvent[] = []
      setProgrammingEventPublisher((event) => events.push(event))

      await resumeBlockedFlow(
        { request_id: 'req', session_id: 's', project_id: project.project_id, mode: 'quick', decision: 'explain', content: '' },
        (event) => events.push(event),
      )

      const after = findProject(project.project_id)
      expect(after.current_stage).toBe('clarifying')
      expect(after.blocked_action).toBeUndefined()
      expect(events.some((event) => event.type === 'stage_changed' && event.payload.stage === 'clarifying')).toBe(true)
    })

    it('continue + judge_return → re-runs judge review instead of re-clarifying', async () => {
      const project = makeBlockedProject('judge_return')
      // 铺设能让裁判判 pass 的素材：草图需求 + 文档 + 含核心功能点的页面
      recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
      syncDocuments({ request_id: 'req-sync', session_id: 'session-1', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
      writeFileSync(join(project.root_path, 'index.html'), '<p>记录收入与支出</p>', 'utf8')
      updateProject(project.project_id, { judge_return_count: 3 })

      await resumeBlockedFlow(
        { request_id: 'req', session_id: 's', project_id: project.project_id, mode: 'quick', decision: 'continue', content: '' },
        () => undefined,
      )

      const after = findProject(project.project_id)
      // 重新走裁判 → 判定通过 → ready（而不是停在 clarifying/blocked）
      expect(after.current_stage).toBe('ready')
      expect(after.blocked_action).toBeUndefined()
      expect(after.judge_return_count ?? 0).toBe(0)
    })

    it('continue + mvp_repair → 恢复重跑 runMvpTask 仍走 loop 生成（透传 query/channel_id），不静默重生成模板', async () => {
      const project = makeBlockedProject('mvp_repair')
      recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '基础四则运算计算器' }])

      setSafeStorageAdapter({
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
        decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
      })
      const channel = createChannel({ name: 'test', provider_type: 'anthropic', base_url: 'https://test', api_key: 'test-key', models: [{ id: 'm1', name: 'test-model', enabled: true, supports_tools: true }] })

      // 真实 HTTP 服务器：根路径动态返回 loop 已写入项目根目录的 index.html，/src/app.js 返回 calculate 逻辑，
      // 供 loop 的 run_preview / run_gwt_tests（静态兜底）与终验门禁同源拉取。
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
        portAllocator: async () => port,
        healthCheck: async () => true,
        processFactory: () => makeChildProcess(),
      })
      setSnapshotCaptureProviderForTests(async () => ({ extension: 'png', buffer: Buffer.from('fake-png') }))
      setBrowserGwtDisabledForTests(true)

      try {
        await resumeBlockedFlow(
          {
            request_id: 'req', session_id: 's', project_id: project.project_id, mode: 'quick',
            decision: 'continue', content: '',
            query: loopScriptedQuery(),
            channel_id: channel.id,
          },
          () => undefined,
        )

        // loop 产物（真实计算器）而非模板增删条目：app.js 含 calculate、index.html 含四则按钮
        expect(readFileSync(join(project.root_path, 'src', 'app.js'), 'utf8')).toContain('calculate')
        expect(readFileSync(join(project.root_path, 'index.html'), 'utf8')).toContain('÷')
        // 全程走完（loop 生成 + GWT + 裁判）回到 ready，未中途卡死
        expect(findProject(project.project_id).current_stage).toBe('ready')
        expect(findProject(project.project_id).blocked_action).toBeUndefined()
      } finally {
        server.close()
      }
    })
  })
})

/** loop 剧本：write_file 落盘真实计算器 → run_preview → run_gwt_tests → 收尾。 */
const CALCULATOR_INDEX_HTML =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /></head><body><h1>基础四则运算计算器</h1>' +
  '<button>+</button><button>−</button><button>×</button><button>÷</button><script src="/src/app.js"></script></body></html>'
const CALCULATOR_APP_JS =
  'function calculate(a, op, b) { return op === "+" ? a + b : a; }\ndocument.addEventListener("DOMContentLoaded", function () {});\n'
const CALCULATOR_LOOP_SCRIPT: MessageContentBlock[][] = [
  [
    { type: 'tool_use', id: 't1', name: 'write_file', input: { path: 'index.html', content: CALCULATOR_INDEX_HTML } },
    { type: 'tool_use', id: 't2', name: 'write_file', input: { path: 'src/app.js', content: CALCULATOR_APP_JS } },
  ],
  [{ type: 'tool_use', id: 't3', name: 'run_preview', input: {} }],
  [{ type: 'tool_use', id: 't4', name: 'run_gwt_tests', input: {} }],
  [{ type: 'text', text: '完成：基础四则运算计算器已就绪。' }],
]

/** loop 生成型 SDK query 桩：带 tools 的调用按剧本走（write_file → run_preview → run_gwt_tests）。 */
function loopScriptedQuery(): SDKQuery {
  let turn = 0
  return async function* (_prompt: string, options: SDKQueryOptions): AsyncGenerator<SDKMessage> {
    const tools = options.tools ?? []
    if (tools.length > 0) {
      const script = CALCULATOR_LOOP_SCRIPT[Math.min(turn, CALCULATOR_LOOP_SCRIPT.length - 1)]
      turn += 1
      yield { type: 'assistant', message: { role: 'assistant', content: script } }
      yield {
        type: 'result',
        subtype: 'success',
        stop_reason: script.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
      }
      return
    }
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '这不是 JSON' }] } }
    yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
  }
}

function makeChildProcess(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess
  Object.assign(emitter, { kill: vi.fn(() => true), pid: 1000 })
  return emitter
}
