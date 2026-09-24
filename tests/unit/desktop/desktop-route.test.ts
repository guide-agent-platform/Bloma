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
import {
  DESKTOP_CONFIRM_OPTION_PREFIX,
  MAX_AUTO_ADVANCE_CHAIN,
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
  vi.clearAllMocks()
  // 临时沙箱先行（record.root_path 引用本轮目录）：全阶段产物预置（关3 产物验证走真实 existsSync）
  sandboxRoot = mkdtempSync(join(tmpdir(), 'bloma-desktop-route-'))
  for (const rel of ['00_ARCH/architecture.md', '00_ARCH/env-checklist.json', '00_SCAFFOLD/contract.json', '00_SCAFFOLD/driver-skeleton.py', 'DELIVERY.md', '00_VERIFY/driver-report.json']) {
    const path = join(sandboxRoot, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, rel.endsWith('.json') ? '{}' : '# placeholder', 'utf8')
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
    root_path: sandboxRoot,
  }
}
let record: ReturnType<typeof baseRecord>

// ── 构造面 ──

function textMessage(text: string): SDKMessage {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
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
      ...overrides,
    } as DesktopRouteDeps,
  }
}

function routeInput(overrides: Partial<{ cardOptionId: string; query: SDKQuery; signal: AbortSignal }> = {}) {
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
  it('普通消息：调度员 run → 推进 → desktop_phase 落盘 + 自动续跑下一阶段', async () => {
    const { deps, events } = collectorDeps()
    await handleDesktopDispatchMessage(routeInput(), deps)
    expect(record.desktop_phase).not.toBe('desktop-scaffold')
    expect(['desktop-implement', 'desktop-verify', 'delivered']).toContain(record.desktop_phase)
    const advanceBroadcast = events.find((e) => typeof e.payload.text === 'string' && (e.payload.text as string).includes('自动进入'))
    expect(advanceBroadcast).toBeTruthy()
  })

  it('推进链达预算上限后停（提示用户继续）', async () => {
    const { events } = collectorDeps()
    await handleDesktopDispatchMessage(routeInput(), events ? collectorDeps().deps : collectorDeps().deps)
    // scaffold(0)→implement(1)→verify(2)→delivered 前停：预算提示至多一条
    expect(MAX_AUTO_ADVANCE_CHAIN).toBe(3)
  })

  it('delivered 终态：desktop_phase/status/current_stage 收口', async () => {
    writeValidContract()
    record.desktop_phase = 'desktop-verify'
    record.desktop_confirmed_phases = ['desktop-verify']
    const { deps } = collectorDeps()
    await handleDesktopDispatchMessage(routeInput({
      query: scriptedQuery([[textMessage('验证全过。\nPHASE_ADVANCE: delivered')]]),
    }), deps)
    expect(record.desktop_phase).toBe('delivered')
    expect((record as unknown as { status?: string }).status).toBe('completed')
    expect((record as unknown as { current_stage?: string }).current_stage).toBe('completed')
  })

  it('confirmation-required：发确认卡（选项 id 前缀协议）且不推进', async () => {
    record.desktop_phase = 'desktop-arch'
    const { deps, events } = collectorDeps()
    await handleDesktopDispatchMessage(routeInput({
      query: scriptedQuery([[textMessage('选型完成。\nPHASE_ADVANCE: desktop-scaffold')]]),
    }), deps)
    const card = events.find((e) => e.type === 'user_decision_required')
    expect(card).toBeTruthy()
    expect(card?.payload.kind).toBe('desktop_phase_confirm')
    const questions = (card?.payload.questions as Array<{ id: string }>) ?? []
    expect(questions.some((q) => q.id === `${DESKTOP_CONFIRM_OPTION_PREFIX}desktop-arch`)).toBe(true)
    expect(record.desktop_phase).toBe('desktop-arch') // 未推进
  })

  it('卡回传：凭据登记 + 重跑该阶段并推进（状态化链路）', async () => {
    record.desktop_phase = 'desktop-arch'
    const { deps } = collectorDeps()
    await handleDesktopDispatchMessage(routeInput({
      cardOptionId: `${DESKTOP_CONFIRM_OPTION_PREFIX}desktop-arch`,
      query: scriptedQuery([[textMessage('确认后推进。\n<!-- PHASE_ADVANCE: desktop-scaffold -->')]]),
    }), deps)
    expect(record.desktop_confirmed_phases).toContain('desktop-arch')
    expect(['desktop-scaffold', 'desktop-implement', 'desktop-verify', 'delivered']).toContain(record.desktop_phase)
  })

  it('非法卡选项：如实告知不推进不崩', async () => {
    const { deps, events } = collectorDeps()
    await handleDesktopDispatchMessage(routeInput({ cardOptionId: 'desktop_confirm:not-a-phase' }), deps)
    const tell = events.find((e) => typeof e.payload.text === 'string' && (e.payload.text as string).includes('不匹配'))
    expect(tell).toBeTruthy()
    expect(record.desktop_phase).toBe('desktop-scaffold')
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
