import { restorePromaHome } from '../support/proma-home-guard'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import type { ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncDocuments } from '../../main/project/document-engine'
import { writeTestReport } from '../../main/verification/gwt-service'
import {
  resolveBlockedDecision,
  resumeBlockedFlow,
  setProgrammingEventPublisher,
} from '../../main/coding/programming-orchestrator'
import { createProject, findProject, recordSketchGenerated, updateProject } from '../../main/project/project-service'
import { createChannel } from '../../main/platform/llm/channel-manager'
import { setSafeStorageAdapter } from '../../main/platform/storage/safe-storage'
import { clearSandboxRuntimeForTests, setSandboxRuntimeForTests } from '../../main/delivery/sandbox'
import { setSnapshotCaptureProviderForTests } from '../../main/delivery/snapshots'
import { setBrowserGwtDisabledForTests } from '../../main/verification/gwt-runner'
import type { SDKQuery, SDKQueryOptions } from '../../main/orchestration/orchestrator'
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
    restorePromaHome(originalPromaHome)
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

    it('Phase 7 U2 H6：accept 开关 on → 话术「先使用已可用的部分」+已知未通过项持续可见；delivery_status 不被 accept 改写', async () => {
      process.env.BLOMA_DECISION_CONDITIONAL = '1'
      try {
        const project = makeBlockedProject('test_repair')
        recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记账' }])
        syncDocuments({ request_id: 'req', session_id: 's', project_id: project.project_id, checkpoint: 'mvp_tested' })
        // 终验报告落盘：1 项失败（accept 话术应如实带上，问题清单不清除）
        writeTestReport({
          request_id: 'req', session_id: 's', project_id: project.project_id,
          result: { total_count: 2, passed_count: 1, failed_count: 1, failure_summary: [{ scenario: 'F-005 搜索过滤未命中', reason: '断言未通过' }] },
        })
        updateProject(project.project_id, { delivery_status: 'partial' })
        const events: AgentEvent[] = []
        setProgrammingEventPublisher((event) => events.push(event))

        await resumeBlockedFlow(
          { request_id: 'req', session_id: 's', project_id: project.project_id, mode: 'quick', decision: 'accept', content: '' },
          (event) => events.push(event),
        )

        const completion = events.find((event) => event.type === 'message_delta')
        expect(String(completion?.payload.text ?? '')).toContain('先使用已可用的部分')
        expect(String(completion?.payload.text ?? '')).toContain('1 项检查未通过')
        expect(String(completion?.payload.text ?? '')).toContain('F-005')
        // H6 验收：accept 后 delivery_status 不变、问题仍可见（不被接受动作改写）
        expect(findProject(project.project_id).delivery_status).toBe('partial')
      } finally {
        delete process.env.BLOMA_DECISION_CONDITIONAL
      }
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

    // ---- M4-B loop-aware resume 移植（2026-08-26，远端缺失项：S4-JUDGE-001~003）----

    it('[S4-JUDGE-001] resume test_repair：loop 异常终止态（turn_limit）→ 走 loop 门禁 → judge 让渡不重修', async () => {
      setBrowserGwtDisabledForTests(true)
      setSafeStorageAdapter({
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
        decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
      })
      const project = makeBlockedProject('test_repair')
      updateProject(project.project_id, { via_agent_loop: true, agent_loop_status: 'turn_limit' })
      recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
      syncDocuments({ request_id: 'req-sync', session_id: 'session-1', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
      // 合法极简应用（L0 UI 门禁实跑需真控件+点击反应；断言文本保留供裁判规则命中）
      writeFileSync(
        join(project.root_path, 'index.html'),
        '<html><body><h1>记账本</h1><p>记录收入与支出，支持每日流水查看</p><input aria-label="金额"><button>记一笔</button><script>document.querySelector("button").addEventListener("click",function(){document.querySelector("p").textContent="已记录收入与支出，流水已更新"})</script></body></html>',
        'utf8',
      )

      const server = createServer((req, res) => {
        const root = findProject(project.project_id).root_path
        const path = req.url === '/' ? '/index.html' : (req.url ?? '/index.html')
        let content: string
        try {
          // 先读文件再写 headers：GWT 会请求 /src/app.js（功能断言），项目无此文件时
          // readFileSync 抛错必须发生在 writeHead 之前，避免 ERR_HTTP_HEADERS_SENT
          content = readFileSync(join(root, path.replace(/^\//, '')), 'utf8')
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
        portAllocator: async () => port,
        healthCheck: async () => true,
        processFactory: () => makeChildProcess(),
      })
      setSnapshotCaptureProviderForTests(async () => ({ extension: 'png', buffer: Buffer.from('fake-png') }))
      const events: string[] = []
      setProgrammingEventPublisher((event) => events.push(event.type))

      try {
        await resumeBlockedFlow(
          { request_id: 'req', session_id: 's', project_id: project.project_id, mode: 'quick', decision: 'continue', content: '' },
          (event) => events.push(event.type),
        )

        const after = findProject(project.project_id)
        // loop 门禁只终验不重修：GWT 过 → 安全过 → judge loop-aware 判让渡（turn_limit 非 completed）
        expect(after.current_stage).toBe('blocked_for_user_decision')
        expect(after.blocked_action).toBe('judge_return')
        expect(after.test_repair_count ?? 0).toBe(0)
        expect(events.filter((type) => type === 'repairing')).toHaveLength(0)
        expect(events).toContain('judge_result')
        expect(after.via_agent_loop).toBe(true)
      } finally {
        server.close()
      }
    })

    it('[S4-JUDGE-002] resume judge_return：loop completed → 走正常读盘判定 → ready', async () => {
      const project = makeBlockedProject('judge_return')
      updateProject(project.project_id, { via_agent_loop: true, agent_loop_status: 'completed', judge_return_count: 3 })
      recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
      syncDocuments({ request_id: 'req-sync', session_id: 'session-1', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
      writeFileSync(join(project.root_path, 'index.html'), '<p>记录收入与支出</p>', 'utf8')
      const events: string[] = []
      setProgrammingEventPublisher((event) => events.push(event.type))

      await resumeBlockedFlow(
        { request_id: 'req', session_id: 's', project_id: project.project_id, mode: 'quick', decision: 'continue', content: '' },
        (event) => events.push(event.type),
      )

      const after = findProject(project.project_id)
      // judge_return 分支带 loop 元数据 + repairInternalized：completed 走正常读盘 → pass → ready
      expect(after.current_stage).toBe('ready')
      expect(after.blocked_action).toBeUndefined()
      expect(after.judge_return_count ?? 0).toBe(0)
      expect(events).toContain('judge_result')
    })

    it('[S4-JUDGE-003] resume judge_return：via_agent_loop 但 status 未落盘 → ?? turn_limit 兜底 fail-closed 走让渡', async () => {
      const project = makeBlockedProject('judge_return')
      updateProject(project.project_id, { via_agent_loop: true, judge_return_count: 2 })
      recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
      syncDocuments({ request_id: 'req-sync', session_id: 'session-1', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
      writeFileSync(join(project.root_path, 'index.html'), '<p>记录收入与支出</p>', 'utf8')

      await resumeBlockedFlow(
        { request_id: 'req', session_id: 's', project_id: project.project_id, mode: 'quick', decision: 'continue', content: '' },
        () => undefined,
      )

      const after = findProject(project.project_id)
      // fail-closed：状态缺失保守判 turn_limit → judge 让渡，绝不默认 completed 放行
      expect(after.current_stage).toBe('blocked_for_user_decision')
      expect(after.blocked_action).toBe('judge_return')
      expect(after.judge_return_count ?? 0).toBe(1)
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

// ===========================================================================
// Phase 7 U2 H5/H6（2026-09-10）：决策卡条件化 + 先用语义（BLOMA_DECISION_CONDITIONAL）
// ===========================================================================
describe('Phase 7 U2 · H5 决策卡条件化（buildBlockedQuestions）', () => {
  const originalSwitch = process.env.BLOMA_DECISION_CONDITIONAL

  afterEach(() => {
    if (originalSwitch === undefined) delete process.env.BLOMA_DECISION_CONDITIONAL
    else process.env.BLOMA_DECISION_CONDITIONAL = originalSwitch
  })

  it('开关 off（缺省）→ 固定三选项（字节级现状回归锁）', async () => {
    const { buildBlockedQuestions } = await import('../../main/coding/programming-orchestrator')
    const questions = buildBlockedQuestions({ reason: 'test', failures: [{ scenario: 'F-001 x' }], mustDeliverFeatureIds: ['F-001'] })
    expect(questions.map((q) => q.label)).toEqual(['继续尝试', '接受现状', '补充说明'])
  })

  it('开关 on + test 失败（有必交失败+有可用部分）→ 主按钮=先修好X再交付（推荐），accept=先使用已可用的部分', async () => {
    process.env.BLOMA_DECISION_CONDITIONAL = '1'
    const { buildBlockedQuestions } = await import('../../main/coding/programming-orchestrator')
    const questions = buildBlockedQuestions({
      reason: 'test',
      failures: [{ scenario: 'F-002 搜索过滤未命中' }],
      mustDeliverFeatureIds: ['F-001', 'F-002'],
    })
    expect(questions[0]).toMatchObject({ id: 'continue', label: '先修好F-002再交付' })
    expect(questions[0].description).toContain('推荐')
    expect(questions[1]).toMatchObject({ id: 'accept', label: '先使用已可用的部分' })
    expect(questions[1].description).toContain('不算完成')
    // 回传 id 集仍是三值（resume 闭环零改动）
    expect(new Set(questions.map((q) => q.id))).toEqual(new Set(['continue', 'accept', 'explain']))
  })

  it('开关 on + test 全败（无可用部分）→ accept 文案如实降级（核心任务未通过不建议当可用版本）', async () => {
    process.env.BLOMA_DECISION_CONDITIONAL = '1'
    const { buildBlockedQuestions } = await import('../../main/coding/programming-orchestrator')
    const questions = buildBlockedQuestions({
      reason: 'test',
      failures: [{ scenario: 'F-001 入口失败' }, { scenario: 'F-002 主流程失败' }],
      mustDeliverFeatureIds: ['F-001', 'F-002'],
    })
    expect(questions[1].label).toBe('先保留这一版')
    expect(questions[1].description).toContain('不建议当作可用版本')
  })

  it('开关 on + security → 主按钮=继续修复安全问题；judge → 主按钮=告诉我怎么调整（方向性优先听用户）', async () => {
    process.env.BLOMA_DECISION_CONDITIONAL = '1'
    const { buildBlockedQuestions } = await import('../../main/coding/programming-orchestrator')
    expect(buildBlockedQuestions({ reason: 'security' })[0].label).toBe('继续修复安全问题')
    expect(buildBlockedQuestions({ reason: 'judge' })[0]).toMatchObject({ id: 'explain', label: '告诉我怎么调整' })
  })
})

// ===========================================================================
// Phase 7 U2 尾批（2026-09-11）：H5 四问卡——「按新方案生成一个版本」第四出口
// （消费 W4-F5 升级信号：连续 ≥2 轮修复零推进；E1 §五：有理由的备选非抽卡重来）
// ===========================================================================
describe('Phase 7 尾批 · H5 四问卡（regenerate 第四出口）', () => {
  const originalSwitch = process.env.BLOMA_DECISION_CONDITIONAL

  afterEach(() => {
    if (originalSwitch === undefined) delete process.env.BLOMA_DECISION_CONDITIONAL
    else process.env.BLOMA_DECISION_CONDITIONAL = originalSwitch
  })

  it('开关 on + test + 升级信号（escalated）→ 追加第四出口「按新方案生成一个版本」', async () => {
    process.env.BLOMA_DECISION_CONDITIONAL = '1'
    const { buildBlockedQuestions } = await import('../../main/coding/programming-orchestrator')
    const questions = buildBlockedQuestions({
      reason: 'test',
      failures: [{ scenario: 'F-002 搜索过滤未命中' }],
      mustDeliverFeatureIds: ['F-001', 'F-002'],
      escalated: true,
    })
    const regenerate = questions.find((q) => q.id === 'regenerate')
    expect(regenerate).toBeDefined()
    expect(regenerate!.label).toBe('按新方案生成一个版本')
    expect(regenerate!.description).toContain('保留已确认需求与草图')
    // 三原出口仍在（第四出口是追加不是替换）
    expect(new Set(questions.slice(0, 3).map((q) => q.id))).toEqual(new Set(['continue', 'accept', 'explain']))
  })

  it('无升级信号不出现第四出口（E1 §五：预算用完但有推进不推重做）', async () => {
    process.env.BLOMA_DECISION_CONDITIONAL = '1'
    const { buildBlockedQuestions } = await import('../../main/coding/programming-orchestrator')
    const questions = buildBlockedQuestions({
      reason: 'test',
      failures: [{ scenario: 'F-002 搜索过滤未命中' }],
      mustDeliverFeatureIds: ['F-001', 'F-002'],
    })
    expect(questions.some((q) => q.id === 'regenerate')).toBe(false)
  })

  it('security/judge 路径即使升级也不出第四出口（重做判据只在 test 链）', async () => {
    process.env.BLOMA_DECISION_CONDITIONAL = '1'
    const { buildBlockedQuestions } = await import('../../main/coding/programming-orchestrator')
    expect(buildBlockedQuestions({ reason: 'security', escalated: true }).some((q) => q.id === 'regenerate')).toBe(false)
    expect(buildBlockedQuestions({ reason: 'judge', escalated: true }).some((q) => q.id === 'regenerate')).toBe(false)
  })

  it('开关 off：escalated 也不出第四出口（字节级现状）', async () => {
    delete process.env.BLOMA_DECISION_CONDITIONAL
    const { buildBlockedQuestions } = await import('../../main/coding/programming-orchestrator')
    const questions = buildBlockedQuestions({
      reason: 'test',
      failures: [{ scenario: 'F-001 x' }],
      mustDeliverFeatureIds: ['F-001'],
      escalated: true,
    })
    expect(questions.map((q) => q.id)).toEqual(['continue', 'accept', 'explain'])
  })

  it('resolveBlockedDecision：点选 regenerate 识别；自由文本「换个方案/按新方案」识别、泛泛词不误判', async () => {
    const { resolveBlockedDecision } = await import('../../main/coding/programming-orchestrator')
    const home = mkdtempSync(join(tmpdir(), 'proma-blocked-4q-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    updateProject(project.project_id, { blocked_action: 'test_repair' })
    const base = { request_id: 'req', session_id: 's', project_id: project.project_id, mode: 'quick' as const }
    const pick = (id: string) => resolveBlockedDecision({
      ...base, content: '', current_stage: 'blocked_for_user_decision',
      metadata: { source: 'card_option', selected_option_id: id },
    })
    expect(pick('regenerate')).toBe('regenerate')
    const freeText = (content: string) => resolveBlockedDecision({
      ...base, content, current_stage: 'blocked_for_user_decision',
    })
    expect(freeText('换个方案重新做')).toBe('regenerate')
    expect(freeText('按新方案来一版')).toBe('regenerate')
    expect(freeText('重新生成一版')).toBe('regenerate')
    // 泛泛词不误判：不带方案/思路信号的「重新」走 explain 兜底
    expect(freeText('重新看看')).toBe('explain')
  })
})
