/**
 * 桌面线路由器测试（接线批，2026-09-24）——分流/凭据链/推进落盘端到端。
 *
 * mock 面：project-service 状态化桩（findProject/updateProject 读写同一可变记录——
 * 凭据登记后重跑能读到新状态）；沙箱用临时目录预置真实产物文件（关3 产物验证
 * 走真实 existsSync）；驱动 spawn 注入桩（delivered 腿不真跑 python）。
 * 环境密闭：开关显式设/还原。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '../../../shared/types'
import type { AgentEvent } from '../../../shared/types'
import type { SDKQuery, SDKQueryOptions } from '../../../main/orchestration/orchestrator'

vi.mock('../../../main/project/project-service', () => ({
  findProject: vi.fn(),
  updateProject: vi.fn(),
}))

import { findProject, updateProject } from '../../../main/project/project-service'
import { isMvpConfirmPending, resetMvpConfirmForTests } from '../../../main/desktop/mvp-confirm'
import {
  DESKTOP_CONFIRM_OPTION_PREFIX,
  MAX_AUTO_ADVANCE_CHAIN,
  enterDesktopLine,
  handleDesktopDispatchMessage,
  isDesktopLineActive,
  resetDesktopRouteLedgersForTests,
  shouldEnterDesktopLine,
  type DesktopRouteDeps,
} from '../../../main/desktop/desktop-route'

const mockFindProject = vi.mocked(findProject)
const mockUpdateProject = vi.mocked(updateProject)

// ── 环境密闭 ──
const SWITCH = 'BLOMA_DESKTOP_DISPATCH'
let switchOriginal: string | undefined
let sandboxRoot: string

beforeEach(() => {
  switchOriginal = process.env[SWITCH]
  process.env[SWITCH] = '1'
  resetDesktopRouteLedgersForTests()
  resetMvpConfirmForTests()
  vi.clearAllMocks()
  // 临时沙箱先行（record.root_path 引用本轮目录）：全阶段产物预置（关3 产物验证走真实 existsSync）
  sandboxRoot = mkdtempSync(join(tmpdir(), 'bloma-desktop-route-'))
  for (const rel of ['00_ARCH/architecture.md', '00_ARCH/env-checklist.json', '00_SCAFFOLD/contract.json', '00_SCAFFOLD/driver-skeleton.py', 'DELIVERY.md', 'LAUNCH.json', '00_VERIFY/driver-report.json']) {
    const path = join(sandboxRoot, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, rel === 'LAUNCH.json' ? '{"schema_version":1,"command":["python","app.py"]}' : rel.endsWith('.json') ? '{}' : '# placeholder', 'utf8')
  }
  // 状态化项目记录：updateProject 写回记录，findProject 读记录（链路状态可见）
  record = baseRecord()
  mockFindProject.mockImplementation(() => record as never)
  mockUpdateProject.mockImplementation(((_id: string, patch: Record<string, unknown>) => {
    Object.assign(record, patch)
    return record
  }) as never)
})

afterEach(() => {
  if (switchOriginal === undefined) delete process.env[SWITCH]
  else process.env[SWITCH] = switchOriginal
  rmSync(sandboxRoot, { recursive: true, force: true })
})

function baseRecord() {
  return {
    project_id: 'p1',
    name: 'clip-tool',
    template_type: 'desktop_tool',
    desktop_phase: 'desktop-scaffold',
    desktop_confirmed_phases: [] as string[],
    /** 项目模式（quick 直通道判定用；缺省不设——非 quick 走原全链，兼容既有用例）。 */
    mode: undefined as string | undefined,
    root_path: sandboxRoot,
  }
}
let record: ReturnType<typeof baseRecord>

// ── 构造面 ──

function textMessage(text: string): SDKMessage {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
}

function toolUseMessage(id: string, name: string, input: Record<string, unknown> = {}): SDKMessage {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }
}

function scriptedQuery(responses: SDKMessage[][]): SDKQuery {
  let call = 0
  return async function* (_prompt: string, _options: SDKQueryOptions) {
    const script = responses[Math.min(call, responses.length - 1)] ?? []
    call += 1
    for (const message of script) yield message
    yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
  }
}

/** deps 收集器：事件/落盘全记账；driverSpawn 桩默认驱动全过。 */
function collectorDeps(overrides: Partial<DesktopRouteDeps> = {}) {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = []
  const systemLogs: string[] = []
  return {
    events,
    systemLogs,
    deps: {
      publish: (_t: unknown, type: AgentEvent['type'] | string, payload: Record<string, unknown>) => {
        events.push({ type: String(type), payload })
      },
      persistAssistant: () => undefined,
      persistSystem: (_s: string, text: string) => { systemLogs.push(text) },
      complete: () => undefined,
      driverSpawn: async () => ({ code: 0, stdout: 'PASS a\nSUMMARY pass=1', stderr: '' }),
      securityScan: () => ({ passed: true, blocking: 0, scanned: 3, listing: '' }),
      launchSmoke: async () => ({ passed: true, detail: '启动冒烟通过（测试注入）' }),
      ...overrides,
    } as DesktopRouteDeps,
  }
}

function routeInput(overrides: Partial<{ cardOptionId: string; content: string; query: SDKQuery; signal: AbortSignal }> = {}) {
  return {
    projectId: 'p1',
    sessionId: 's1',
    requestId: 'r1',
    content: '继续',
    query: scriptedQuery([[textMessage('阶段完成。\n<!-- PHASE_ADVANCE: desktop-implement -->')]]),
    env: {},
    maxTokens: 1024,
    ...overrides,
  }
}

/** 合法契约文本（verify 腿 readContract 读真实临时文件——预置 {} 不是法契约，换合法内容）。 */
function writeValidContract() {
  writeFileSync(join(sandboxRoot, '00_SCAFFOLD', 'contract.json'), JSON.stringify({
    schema_version: 1,
    entry: 'app.py',
    driver: {
      command: ['python', 'driver-skeleton.py'],
      timeout_ms: 60000,
      exit_code_semantics: { '0': 'pass', '1': 'fail', '2': 'blocked' },
      assert_readback: 'stdout 锚点',
    },
    env_whitelist: [],
    components: [],
  }), 'utf8')
}

describe('判定矩阵（开关字节锁）', () => {
  it('isDesktopLineActive：开关/品类/阶段三要素齐才激活', () => {
    expect(isDesktopLineActive(record as never)).toBe(true)
    process.env[SWITCH] = ''
    expect(isDesktopLineActive(record as never)).toBe(false)
    process.env[SWITCH] = '1'
    expect(isDesktopLineActive({ ...record, template_type: 'web_fullstack' } as never)).toBe(false)
    expect(isDesktopLineActive({ ...record, desktop_phase: undefined } as never)).toBe(false)
    expect(isDesktopLineActive({ ...record, desktop_phase: 'not-a-phase' } as never)).toBe(false)
    expect(isDesktopLineActive(undefined)).toBe(false)
  })

  it('shouldEnterDesktopLine：开关+品类（PRD 改道判据，不要求已进入）', () => {
    expect(shouldEnterDesktopLine({ ...record, desktop_phase: undefined } as never)).toBe(true)
    expect(shouldEnterDesktopLine({ ...record, template_type: 'game' } as never)).toBe(false)
    process.env[SWITCH] = ''
    expect(shouldEnterDesktopLine(record as never)).toBe(false)
  })
})

describe('handleDesktopDispatchMessage 消息路由', () => {
  it('普通消息：调度员 run → 推进 → desktop_phase 落盘 + 自动续跑下一阶段 + stage_changed 事件（渲染端阶段条数据源）', async () => {
    const { deps, events } = collectorDeps()
    await handleDesktopDispatchMessage(routeInput(), deps)
    expect(record.desktop_phase).not.toBe('desktop-scaffold')
    expect(['desktop-implement', 'desktop-verify', 'delivered']).toContain(record.desktop_phase)
    const advanceBroadcast = events.find((e) => typeof e.payload.text === 'string' && (e.payload.text as string).includes('自动进入'))
    expect(advanceBroadcast).toBeTruthy()
    // 阶段推进事件：每个推进节点一条 stage_changed（stage=桌面 id）
    const stageEvents = events.filter((e) => e.type === 'stage_changed' && typeof e.payload.stage === 'string')
    expect(stageEvents.length).toBeGreaterThanOrEqual(1)
    expect(stageEvents.some((e) => String(e.payload.stage).startsWith('desktop-'))).toBe(true)
  })

  it('链预算 4：PRD 后零 kick 走到 delivered（arch→scaffold→implement→verify 自动连跑；脑测修复 2）', async () => {
    writeValidContract()
    record.desktop_phase = 'desktop-arch'
    const { deps, events } = collectorDeps()
    await handleDesktopDispatchMessage(routeInput({
      query: scriptedQuery([
        [textMessage('选型完成。\n<!-- PHASE_ADVANCE: desktop-scaffold -->')],
        [textMessage('骨架完成。\n<!-- PHASE_ADVANCE: desktop-implement -->')],
        [textMessage('实现完成。\n<!-- PHASE_ADVANCE: desktop-verify -->')],
        [textMessage('验证全绿。\nPHASE_ADVANCE: delivered')],
      ]),
    }), deps)
    expect(MAX_AUTO_ADVANCE_CHAIN).toBe(4)
    expect(record.desktop_phase).toBe('delivered') // 零中间 kick
    expect(events.some((e) => typeof e.payload.text === 'string' && (e.payload.text as string).includes('预算已用完'))).toBe(false)
  })

  it('delivered 交付后反馈：回炉 implement 迭代段（通知卡承诺兑现；脑测修复 1）', async () => {
    writeValidContract()
    record.desktop_phase = 'delivered'
    ;(record as unknown as { status?: string }).status = 'completed'
    ;(record as unknown as { current_stage?: string }).current_stage = 'completed'
    const receivedAll: string[] = []
    const query: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions) {
      receivedAll.push(JSON.stringify(options.messages ?? []))
      const responses = [
        [textMessage('迭代完成。\n<!-- PHASE_ADVANCE: desktop-verify -->')],
        [textMessage('验证全绿。\nPHASE_ADVANCE: delivered')],
      ]
      const idx = receivedAll.length - 1
      const script = responses[Math.min(idx, responses.length - 1)]
      for (const message of script) yield message
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
    }
    const { deps, events } = collectorDeps()
    await handleDesktopDispatchMessage(routeInput({
      content: '把倒计时改成进度条',
      query,
    }), deps)
    // 回炉后走完再交付（delivered+completed）或中途（implement/verify+iterating）——
    // 两者皆合法，关键是离开 delivered 进迭代语义且状态自洽
    expect(['desktop-implement', 'desktop-verify', 'delivered']).toContain(record.desktop_phase)
    if (record.desktop_phase !== 'delivered') {
      expect((record as unknown as { current_stage?: string }).current_stage).toBe('iterating')
      expect((record as unknown as { status?: string }).status).toBe('active')
    }
    expect(events.some((e) => typeof e.payload.text === 'string' && (e.payload.text as string).includes('进入迭代'))).toBe(true)
    const allText = receivedAll.join('')
    expect(allText).toContain('【交付后迭代】')
    expect(allText).toContain('把倒计时改成进度条')
  })

  it('旧确认卡回传：同步清 blocked 残留（脑测修复 5；链走通不重置 blocked）', async () => {
    writeValidContract()
    record.desktop_phase = 'desktop-scaffold'
    ;(record as Record<string, unknown>).desktop_blocked = { reason: 'user-stop', note: 'x', at: new Date().toISOString() }
    const { deps } = collectorDeps()
    await handleDesktopDispatchMessage(routeInput({
      cardOptionId: 'desktop_confirm:desktop-scaffold:n-old',
      query: scriptedQuery([
        [textMessage('收到。\n<!-- PHASE_ADVANCE: desktop-implement -->')],
        [textMessage('继续。\n<!-- PHASE_ADVANCE: desktop-verify -->')],
        [textMessage('验证全绿。\nPHASE_ADVANCE: delivered')],
      ]),
    }), deps)
    expect((record as unknown as { desktop_blocked?: unknown }).desktop_blocked).toBeUndefined()
    expect(record.desktop_phase).toBe('delivered') // 全链通（blocked 未复发）
  })

  it('delivered 终态：desktop_phase/status/current_stage 收口 + stage_changed', async () => {
    writeValidContract()
    // 刀3：预置程序截图（通知卡内嵌清单的数据源）
    mkdirSync(join(sandboxRoot, '00_VERIFY', 'screenshots'), { recursive: true })
    writeFileSync(join(sandboxRoot, '00_VERIFY', 'screenshots', 'S1.png'), 'png')
    record.desktop_phase = 'desktop-verify'
    record.desktop_confirmed_phases = ['desktop-verify']
    const { deps, events } = collectorDeps()
    await handleDesktopDispatchMessage(routeInput({
      query: scriptedQuery([[textMessage('验证全过。\nPHASE_ADVANCE: delivered')]]),
    }), deps)
    expect(record.desktop_phase).toBe('delivered')
    expect((record as unknown as { status?: string }).status).toBe('completed')
    expect((record as unknown as { current_stage?: string }).current_stage).toBe('completed')
    // 终态也发 stage_changed（渲染端阶段条跳到「交付」）
    expect(events.some((e) => e.type === 'stage_changed' && e.payload.stage === 'delivered')).toBe(true)
    // 刀3：预置截图 png → 通知卡内嵌截图清单
    expect(events.some((e) => typeof e.payload.text === 'string' && (e.payload.text as string).includes('程序截图'))).toBe(true)
  })

  it('MVP 确认门（确认门新规 2026-10-04）：longterm verify 全绿不直接交付——挂 MVP 卡，确认后才 delivered（viaMvpConfirm 话术）', async () => {
    writeValidContract()
    record.desktop_phase = 'desktop-verify'
    record.mode = 'longterm'
    const { deps, events } = collectorDeps()
    await handleDesktopDispatchMessage(routeInput({
      query: scriptedQuery([[textMessage('验证全绿。\nPHASE_ADVANCE: delivered')]]),
    }), deps)
    // 门挂起：不置 delivered，发 MVP 确认卡
    expect(record.desktop_phase).toBe('desktop-verify')
    const card = events.find((e) => e.type === 'user_decision_required')
    expect(card?.payload.kind).toBe('mvp_confirm')
    // 确认回传 → 交付收口 + 「已按你的确认正式交付」话术
    const confirmDeps = collectorDeps()
    await handleDesktopDispatchMessage(routeInput({ cardOptionId: 'mvp_confirm_go' }), confirmDeps.deps)
    expect(record.desktop_phase).toBe('delivered')
    expect((record as unknown as { status?: string }).status).toBe('completed')
    expect(confirmDeps.events.some((e) => typeof e.payload.text === 'string' && (e.payload.text as string).includes('已按你的确认正式交付'))).toBe(true)
  })

  it('MVP 确认门：挂起期间普通消息＝修改意见回炉 implement（【交付前迭代】）；quick 不设门', async () => {
    writeValidContract()
    record.desktop_phase = 'desktop-verify'
    record.mode = 'longterm'
    const { deps } = collectorDeps()
    await handleDesktopDispatchMessage(routeInput({
      query: scriptedQuery([[textMessage('验证全绿。\nPHASE_ADVANCE: delivered')]]),
    }), deps)
    expect(record.desktop_phase).toBe('desktop-verify')
    // 普通消息＝反馈 → 回炉 implement（脚本给出下一轮实现推进）
    const rework = collectorDeps()
    await handleDesktopDispatchMessage(routeInput({
      content: '把结果显示改成大字号',
      query: scriptedQuery([[textMessage('已改。\n<!-- PHASE_ADVANCE: desktop-verify -->')]]),
    }), rework.deps)
    // 回炉语义：先改再交 ack + 离开交付收口（迭代中；阶段在 implement/verify 链上）
    expect(rework.events.some((e) => typeof e.payload.text === 'string' && (e.payload.text as string).includes('先改再交'))).toBe(true)
    expect(rework.events.some((e) => e.type === 'stage_changed' && e.payload.stage === 'desktop-implement')).toBe(true)
    expect(isMvpConfirmPending('p1')).toBe(false)
    // quick 模式同一收口点不设门（直接 delivered，快速直通道不变）
    const quickRecord = record
    quickRecord.mode = 'quick'
    quickRecord.desktop_phase = 'desktop-verify'
    const quickDeps = collectorDeps()
    await handleDesktopDispatchMessage(routeInput({
      query: scriptedQuery([[textMessage('验证全绿。\nPHASE_ADVANCE: delivered')]]),
    }), quickDeps.deps)
    // quick 从 verify 推进 delivered 不走 MVP 门（快速直通道的门在 implement 收口处，也不设 MVP）
    expect(quickDeps.events.some((e) => e.type === 'user_decision_required' && e.payload.kind === 'mvp_confirm')).toBe(false)
  })

  it('刀1 撤 manual 门：desktop-arch 门禁过即推进（零 confirmation-required、零确认卡）', async () => {
    record.desktop_phase = 'desktop-arch'
    const { deps, events } = collectorDeps()
    await handleDesktopDispatchMessage(routeInput({
      query: scriptedQuery([[textMessage('选型完成。\nPHASE_ADVANCE: desktop-scaffold')]]),
    }), deps)
    expect(events.some((e) => e.type === 'user_decision_required')).toBe(false) // 不发确认卡
    expect(record.desktop_phase).not.toBe('desktop-arch') // 门禁（artifact 全预置）过即推进
  })

  it('刀1 旧确认卡回传：如实告知协议升级 + 照常跑当前阶段（推进链不再依赖卡）', async () => {
    record.desktop_phase = 'desktop-arch'
    const { deps, events } = collectorDeps()
    await handleDesktopDispatchMessage(routeInput({
      cardOptionId: `${DESKTOP_CONFIRM_OPTION_PREFIX}desktop-arch:n-current`,
      query: scriptedQuery([[textMessage('收到。\n<!-- PHASE_ADVANCE: desktop-scaffold -->')]]),
    }), deps)
    const tell = events.find((e) => typeof e.payload.text === 'string' && (e.payload.text as string).includes('确认协议已升级'))
    expect(tell).toBeTruthy()
    expect(['desktop-scaffold', 'desktop-implement', 'desktop-verify', 'delivered']).toContain(record.desktop_phase)
  })

  it('刀1 文本意图：停止词 → desktop_blocked 落库 + 人话卡 + 不跑调度员（阶段不动）', async () => {
    record.desktop_phase = 'desktop-scaffold'
    const { deps, events } = collectorDeps()
    await handleDesktopDispatchMessage(routeInput({
      content: '先停一下，我改主意了',
      query: scriptedQuery([[textMessage('不应被跑到')]]),
    }), deps)
    const blocked = (record as unknown as { desktop_blocked?: { reason: string } }).desktop_blocked
    expect(blocked).toMatchObject({ reason: 'user-stop' })
    const notice = events.find((e) => typeof e.payload.text === 'string' && (e.payload.text as string).includes('【已暂停，需要你拿主意】'))
    expect(notice).toBeTruthy()
    expect(record.desktop_phase).toBe('desktop-scaffold') // 阶段不动
  })

  it('刀1 文本意图：反义词优先——「不通过」不触发放行（含子串「通过」的实证防御）', async () => {
    record.desktop_phase = 'desktop-scaffold'
    ;(record as Record<string, unknown>).desktop_blocked = { reason: 'gate-exhausted', note: 'x', at: new Date().toISOString() }
    const { deps, events } = collectorDeps()
    await handleDesktopDispatchMessage(routeInput({
      content: '不通过，需要调整',
      query: scriptedQuery([[textMessage('不应被跑到')]]),
    }), deps)
    // stop 优先：仍处 blocked，且人话卡再次出现（不误放行）
    expect((record as unknown as { desktop_blocked?: unknown }).desktop_blocked).toMatchObject({ reason: 'user-stop' })
    expect(events.some((e) => typeof e.payload.text === 'string' && (e.payload.text as string).includes('【已暂停，需要你拿主意】'))).toBe(true)
    expect(record.desktop_phase).toBe('desktop-scaffold')
  })

  it('刀1 blocked 态继续词 → 放行清 blocked + 全链推进到 delivered（implement→verify→delivered 零人工确认端到端）', async () => {
    writeValidContract()
    record.desktop_phase = 'desktop-implement'
    ;(record as Record<string, unknown>).desktop_blocked = { reason: 'gate-exhausted', note: 'artifacts-missing', at: new Date().toISOString() }
    const { deps, events } = collectorDeps()
    await handleDesktopDispatchMessage(routeInput({
      content: '继续',
      query: scriptedQuery([
        [textMessage('实现完成。\n<!-- PHASE_ADVANCE: desktop-verify -->')],
        [textMessage('验证全绿。\nPHASE_ADVANCE: delivered')],
      ]),
    }), deps)
    expect((record as unknown as { desktop_blocked?: unknown }).desktop_blocked).toBeUndefined()
    expect(events.some((e) => typeof e.payload.text === 'string' && (e.payload.text as string).includes('已放行'))).toBe(true)
    expect(record.desktop_phase).toBe('delivered')
    // 端到端验收锁：全程零 confirmation-required、零确认卡、delivered 通知卡已发
    expect(events.some((e) => e.type === 'user_decision_required')).toBe(false)
    const notice = events.find((e) => typeof e.payload.text === 'string' && (e.payload.text as string).includes('【交付完成】'))
    expect(notice).toBeTruthy()
    expect((notice?.payload.text as string)).toContain('DELIVERY.md')
    expect((notice?.payload.text as string)).toContain('不用从头再来')
  })

  it('刀1 正常态继续词：无特殊处理（普通消息进调度员，不凭文本推进）', async () => {
    record.desktop_phase = 'desktop-scaffold'
    const { deps, events } = collectorDeps()
    await handleDesktopDispatchMessage(routeInput({
      content: '继续',
      query: scriptedQuery([[textMessage('没有输出标记')]]), // 调度员没推进 → 拒收续接闭环兜底
    }), deps)
    // 无「已放行」话术（非 blocked 态继续词不构成任何授权）
    expect(events.some((e) => typeof e.payload.text === 'string' && (e.payload.text as string).includes('已放行'))).toBe(false)
  })

  it('拒收（no-marks）：教育播报 + 续接驱动同阶段重跑（第二次带标记推进）', async () => {
    const { deps, events } = collectorDeps()
    let call = 0
    const query: SDKQuery = async function* () {
      call += 1
      if (call === 1) {
        yield textMessage('我做好了（其实没输出标记）')
      } else {
        yield textMessage('补齐了。\n<!-- PHASE_ADVANCE: desktop-implement -->')
      }
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
    }
    await handleDesktopDispatchMessage(routeInput({ query }), deps)
    const rejectEdu = events.find((e) => typeof e.payload.text === 'string' && (e.payload.text as string).includes('未收集到任何锚定形态'))
    expect(rejectEdu).toBeTruthy()
    expect(['desktop-implement', 'desktop-verify', 'delivered']).toContain(record.desktop_phase)
    expect(call).toBeGreaterThanOrEqual(2) // 续接驱动发生
  })

  it('驱动 fail（verify 腿）：拒收不推进（验证只看回读）', async () => {
    writeValidContract()
    record.desktop_phase = 'desktop-verify'
    record.desktop_confirmed_phases = ['desktop-verify']
    const { deps, events } = collectorDeps({
      driverSpawn: async () => ({ code: 1, stdout: 'FAIL b: 断言失败', stderr: '' }),
    })
    await handleDesktopDispatchMessage(routeInput({
      query: scriptedQuery([[textMessage('PHASE_ADVANCE: delivered')]]),
    }), deps)
    expect(record.desktop_phase).not.toBe('delivered')
    const edu = events.filter((e) => typeof e.payload.text === 'string').map((e) => e.payload.text as string).join('\n')
    // 拒收闭环：驱动 fail 教育 + 续接重跑后再拒（防环计数 2 次内）
    expect(edu).toContain('驱动执行未通过')
  })

  it('loop 未收口（cancelled/error）：阶段不动 + 可重试话术（loop 取消收尾已在批次 D dispatcher-loop 测试覆盖，此处验路由分支经非 completed 结果触发）', async () => {
    // 构造非 completed：query 直接 throw（断流 fail-soft → error 状态）——路由走「未收口」分支
    const query: SDKQuery = async function* () {
      yield textMessage('半截')
      throw new Error('STREAM_BROKEN: route-cancel-leg')
    }
    const { deps, events } = collectorDeps()
    await handleDesktopDispatchMessage({
      projectId: 'p1', sessionId: 's1', requestId: 'r1', content: '继续',
      query, env: {}, maxTokens: 1024,
    }, deps)
    const tell = events.find((e) => typeof e.payload.text === 'string' && (e.payload.text as string).includes('未收口'))
    expect(tell).toBeTruthy()
    expect(record.desktop_phase).toBe('desktop-scaffold')
  })
})

describe('快速型直通道（2026-10-03 拍板：quick 快速做出可用应用，跳过工程化验收）', () => {
  it('quick 项目 implement 门禁全绿 → 安全门过 → 直达 delivered：跳过 verify、发交付通知卡、零 verify 轮次', async () => {
    record.mode = 'quick'
    record.desktop_phase = 'desktop-implement'
    let queryCalls = 0
    const query: SDKQuery = async function* (_prompt: string, _options: SDKQueryOptions) {
      queryCalls += 1
      yield textMessage('实现完成。\n<!-- PHASE_ADVANCE: desktop-verify -->')
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
    }
    const { deps, events } = collectorDeps()
    await handleDesktopDispatchMessage(routeInput({ query }), deps)
    expect(record.desktop_phase).toBe('delivered')
    expect((record as unknown as { status?: string }).status).toBe('completed')
    expect((record as unknown as { current_stage?: string }).current_stage).toBe('completed')
    expect(queryCalls).toBe(1) // 不跑 verify（工程验收是长期模式设施）
    expect(events.some((e) => e.type === 'stage_changed' && e.payload.stage === 'delivered')).toBe(true)
    expect(events.some((e) => typeof e.payload.text === 'string' && (e.payload.text as string).includes('【交付完成】'))).toBe(true)
  })

  it('安全门未过 → 停在 implement 出人话卡（高危清单直达）+ incomplete；阶段不动待修复重扫', async () => {
    record.mode = 'quick'
    record.desktop_phase = 'desktop-implement'
    const completions: Array<{ sessionId: string; projectId: string; outcome?: 'success' | 'incomplete' }> = []
    const query: SDKQuery = async function* (_prompt: string, _options: SDKQueryOptions) {
      yield textMessage('实现完成。\n<!-- PHASE_ADVANCE: desktop-verify -->')
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
    }
    const { deps, events } = collectorDeps({
      securityScan: () => ({ passed: false, blocking: 2, scanned: 5, listing: '- app.py:3 eval 动态执行' }),
      complete: (sessionId, projectId, outcome) => completions.push({ sessionId, projectId, outcome }),
    })
    await handleDesktopDispatchMessage(routeInput({ query }), deps)
    expect(record.desktop_phase).toBe('desktop-implement') // 不交付，停在实现阶段
    expect(events.some((e) => typeof e.payload.text === 'string' && (e.payload.text as string).includes('安全扫描未通过'))).toBe(true)
    expect(events.some((e) => typeof e.payload.text === 'string' && (e.payload.text as string).includes('eval 动态执行'))).toBe(true)
    // 2026-10-03 删留执行补齐：标题承诺的 incomplete 终态如实断言（失败交付不走 success）
    expect(completions.some((c) => c.outcome === 'incomplete')).toBe(true)
    expect(completions.some((c) => c.outcome === 'success' || c.outcome === undefined)).toBe(false)
  })

  it('longterm 项目 implement 推进 → 照旧走 verify 工程验收；verify→delivered 被 MVP 确认门拦下（确认门新规 2026-10-04）', async () => {
    record.mode = 'longterm'
    record.desktop_phase = 'desktop-implement'
    writeValidContract()
    let queryCalls = 0
    const query: SDKQuery = async function* (_prompt: string, _options: SDKQueryOptions) {
      queryCalls += 1
      const script = queryCalls === 1
        ? [textMessage('实现完成。\n<!-- PHASE_ADVANCE: desktop-verify -->')]
        : [textMessage('验证全绿。\nPHASE_ADVANCE: delivered')]
      for (const message of script) yield message
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
    }
    const { deps, events } = collectorDeps()
    await handleDesktopDispatchMessage(routeInput({ query }), deps)
    expect(queryCalls).toBe(2) // verify 照常执行
    // MVP 门：longterm 交付前挂起，不置 delivered，发确认卡
    expect(record.desktop_phase).toBe('desktop-verify')
    expect(events.some((e) => e.type === 'user_decision_required' && e.payload.kind === 'mvp_confirm')).toBe(true)
    // 确认后才交付
    const confirmDeps = collectorDeps()
    await handleDesktopDispatchMessage(routeInput({ cardOptionId: 'mvp_confirm_go' }), confirmDeps.deps)
    expect(record.desktop_phase).toBe('delivered')
  })

  it('enterDesktopLine 起跑分叉：quick 直入 implement 快速实现，longterm 从 desktop-arch 完整链开始', async () => {
    const query: SDKQuery = async function* (_prompt: string, _options: SDKQueryOptions) {
      yield textMessage('完成。\n<!-- PHASE_ADVANCE: desktop-verify -->')
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
    }
    const { deps: quickDeps, events: quickEvents } = collectorDeps()
    record.mode = 'quick'
    await enterDesktopLine(
      { projectId: 'p1', sessionId: 's1', requestId: 'r1', content: '开始' },
      query, {}, quickDeps,
    )
    expect((record as unknown as { desktop_phase?: string }).desktop_phase !== 'desktop-arch').toBe(true)
    expect(record.desktop_phase).toBe('delivered') // 从 implement 起跑 → 直通道交付
    expect(quickEvents.some((e) => typeof e.payload.text === 'string' && (e.payload.text as string).includes('快速模式'))).toBe(true)

    // longterm：从 desktop-arch 起跑（按当前阶段动态推进，验证起跑点在完整链头部）
    const { deps: ltDeps } = collectorDeps()
    record.mode = 'longterm'
    record.desktop_phase = 'desktop-arch'
    const nextMark = () => {
      const marks: Record<string, string> = {
        'desktop-arch': 'desktop-scaffold',
        'desktop-scaffold': 'desktop-implement',
        'desktop-implement': 'desktop-verify',
      }
      return marks[record.desktop_phase as string] ?? 'delivered'
    }
    const ltQuery: SDKQuery = async function* (_prompt: string, _options: SDKQueryOptions) {
      yield textMessage(`完成。\nPHASE_ADVANCE: ${nextMark()}`)
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
    }
    await enterDesktopLine(
      { projectId: 'p1', sessionId: 's2', requestId: 'r2', content: '开始' },
      ltQuery, {}, ltDeps,
    )
    expect(['desktop-scaffold', 'desktop-implement', 'desktop-verify', 'delivered']).toContain(record.desktop_phase)
  })
})

describe('事件直通与需求注入（2026-09-26 首跑修复）', () => {
  it('loop 过程事件按原类型直通（tool_call_started/completed 不再被折叠为 message_delta）', async () => {
    const { deps, events } = collectorDeps()
    await handleDesktopDispatchMessage(routeInput({
      query: scriptedQuery([
        [toolUseMessage('t1', 'read_file', { path: '00_SCAFFOLD/contract.json' }), textMessage('读完了。')],
        [textMessage('完成。\n<!-- PHASE_ADVANCE: desktop-implement -->')],
      ]),
    }), deps)
    expect(events.some((event) => event.type === 'tool_call_started')).toBe(true)
    expect(events.some((event) => event.type === 'tool_call_completed')).toBe(true)
  })

  it('刀2 checkpoint 消费：同阶段重跑时任务书头部注入「上一轮已验证结论」（勿重验），跨阶段不注入', async () => {
    // 同阶段（desktop-scaffold 与 checkpoint 一致）：system 轮含已验证结论与勿重验指示
    ;(record as Record<string, unknown>).desktop_checkpoint = {
      stage: 'desktop-scaffold',
      at: '2026-10-02T15:00:00.000Z',
      verified_gates: ['scaffold-contract: 产物核验通过'],
    }
    let capturedSystem = ''
    const query: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions) {
      const first = (options.messages ?? [])[0]
      // 仅首次调用捕获（推进链后续阶段的 system 不覆盖本断言目标）
      if (!capturedSystem && first && first.role === 'system') capturedSystem = String((first as { content?: unknown }).content ?? '')
      yield textMessage('PHASE_ADVANCE: desktop-implement')
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
    }
    await handleDesktopDispatchMessage(routeInput({ query }), collectorDeps().deps)
    expect(capturedSystem).toContain('【上一轮已验证结论】')
    expect(capturedSystem).toContain('勿重验')
    expect(capturedSystem).toContain('PHASE_ADVANCE: desktop-implement')
    expect(capturedSystem.indexOf('【上一轮已验证结论】')).toBeLessThan(capturedSystem.indexOf('【本阶段任务书】'))

    // 跨阶段（checkpoint 属 desktop-arch，当前已是下一阶段）：不注入旧结论
    let capturedSystem2 = ''
    const query2: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions) {
      const first = (options.messages ?? [])[0]
      if (!capturedSystem2 && first && first.role === 'system') capturedSystem2 = String((first as { content?: unknown }).content ?? '')
      yield textMessage('PHASE_ADVANCE: desktop-verify')
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
    }
    record.desktop_phase = 'desktop-implement'
    ;(record as Record<string, unknown>).desktop_checkpoint = {
      stage: 'desktop-arch',
      at: '2026-10-02T15:00:00.000Z',
      verified_gates: ['arch-decision: 产物核验通过'],
    }
    await handleDesktopDispatchMessage(routeInput({ query: query2 }), collectorDeps().deps)
    expect(capturedSystem2).not.toContain('【上一轮已验证结论】')
  })

  it('需求摘要注入：deps.requirementsDigest 按项目 id 装配（进调度员上下文链路）', async () => {
    const digest = vi.fn(() => 'F-001 [P0] 托盘倒计时工具')
    const { deps } = collectorDeps({ requirementsDigest: digest })
    await handleDesktopDispatchMessage(routeInput(), deps)
    expect(digest).toHaveBeenCalledWith('p1')
  })
})

describe('启动冒烟门（2026-10-04 呈现层收口：程序能跑起来才算交付）', () => {
  it('冒烟未过（启动即崩）→ 停在 implement 出人话卡（stderr 尾部直达）+ incomplete；阶段不动', async () => {
    record.mode = 'quick'
    record.desktop_phase = 'desktop-implement'
    const query: SDKQuery = async function* (_prompt: string, _options: SDKQueryOptions) {
      yield textMessage('实现完成。\n<!-- PHASE_ADVANCE: desktop-verify -->')
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
    }
    const { deps, events } = collectorDeps({
      launchSmoke: async () => ({ passed: false, detail: '异常退出（退出码 1）', outputExcerpt: 'TclError: bad screen distance "10 2"' }),
    })
    await handleDesktopDispatchMessage(routeInput({ query }), deps)
    expect(record.desktop_phase).toBe('desktop-implement')
    expect((record as unknown as { status?: string }).status).not.toBe('completed')
    expect(events.some((e) => typeof e.payload.text === 'string' && (e.payload.text as string).includes('启动验证未通过'))).toBe(true)
    expect(events.some((e) => typeof e.payload.text === 'string' && (e.payload.text as string).includes('TclError'))).toBe(true)
  })

  it('冒烟通过 → delivered 通知卡 + 阶段落 delivered（截图由冒烟落盘，此处只验门序）', async () => {
    record.mode = 'quick'
    record.desktop_phase = 'desktop-implement'
    const query: SDKQuery = async function* (_prompt: string, _options: SDKQueryOptions) {
      yield textMessage('实现完成。\n<!-- PHASE_ADVANCE: desktop-verify -->')
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
    }
    const { deps } = collectorDeps()
    await handleDesktopDispatchMessage(routeInput({ query }), deps)
    expect(record.desktop_phase).toBe('delivered')
  })
})
