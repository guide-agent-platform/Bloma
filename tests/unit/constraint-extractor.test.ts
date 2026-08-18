import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureConstraints, extractConstraints, scanSessionConstraints } from '../../main/constraint-extractor'
import { buildPrdBackplane } from '../../main/document-engine'
import { generateMvpLlm } from '../../main/mvp-engine-llm'
import { generateSketchLlm } from '../../main/sketch-engine-llm'
import { HISTORY_WINDOW_TURNS, runAgent, setAgentStreamPublisher, setSDKQueryForTests } from '../../main/orchestrator'
import { createChannel } from '../../main/channel-manager'
import { setSafeStorageAdapter } from '../../main/safe-storage'
import { createProject, findProject } from '../../main/project-service'
import { getAgentSessionPath } from '../../storage/config-paths'
import type { PrdBackplane, SketchRequirement } from '../../main/sketch-engine'
import type { AgentMessage, SDKMessage } from '../../shared/types'

/**
 * T4-L1/L2 确定性记忆主路（2026-08-18 修订版设计）：
 * 约束走门进背板（写入侧）+ 窗口改造与全量扫描（读取侧）。
 *
 * 验收核心场景「首轮约束 >30 轮仍生效」在这里以纯确定性链路锁定：
 * 提取 → 门捕获入库 → 背板组装 → 草图/MVP 提示词注入 → 全量扫描回灌，
 * 全程不依赖 LLM（L3 蒸馏是线上实测有漏才启用的兜底，另见 memory-distiller.test）。
 */

const originalPromaHome = process.env.PROMA_HOME

function useTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'bloma-constraint-'))
  process.env.PROMA_HOME = home
  setSafeStorageAdapter({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
  })
  return home
}

function writeSession(sessionId: string, messages: AgentMessage[]): void {
  const path = getAgentSessionPath(sessionId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, messages.map((message) => JSON.stringify(message)).join('\n') + '\n', 'utf8')
}

function turn(role: 'user' | 'assistant', text: string, index: number): AgentMessage {
  return { role, content: [{ type: 'text', text }], timestamp: index }
}

/** 生成 n 轮对话：第 1 轮用户消息带约束，其余是普通往返。 */
function longSession(turns: number): AgentMessage[] {
  const messages: AgentMessage[] = [turn('user', '帮我做一个记账应用，不含登录', 1), turn('assistant', '好的，先确认几个关键点。', 2)]
  for (let i = 3; i < turns * 2; i += 2) {
    messages.push(turn('user', `第 ${i} 轮：再细化一下界面`, i))
    messages.push(turn('assistant', `第 ${i + 1} 轮：已记录。`, i + 1))
  }
  return messages
}

describe('T4-L1 extractConstraints 确定性提取', () => {
  it('提取排除类与要求类约束短语', () => {
    expect(extractConstraints('做一个记账 app，不含登录，必须离线可用')).toEqual(['不含登录', '必须离线可用'])
    expect(extractConstraints('界面要克制，禁止联网，数据只能存本地')).toEqual(['禁止联网', '数据只能存本地'])
    expect(extractConstraints('不要排行榜')).toEqual(['不要排行榜'])
    expect(extractConstraints('别用英文，务必中文界面')).toEqual(['别用英文', '务必中文界面'])
  })

  it('无约束的普通诉求/寒暄不产生噪声', () => {
    expect(extractConstraints('帮我做一个记账本')).toEqual([])
    expect(extractConstraints('好的，就这样')).toEqual([])
    expect(extractConstraints('')).toEqual([])
  })
})

describe('T4-L2 全量扫描：首轮约束历轮可回', () => {
  beforeEach(() => {
    useTempHome()
  })

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  it('>30 轮会话，第 1 轮约束仍被扫出（读取侧不靠窗口）', () => {
    writeSession('session-long', longSession(32))
    expect(scanSessionConstraints('session-long')).toContain('不含登录')
  })

  it('只认 user 角色——assistant 的转述不算用户声明', () => {
    writeSession('session-assistant-only', [
      turn('assistant', '我会遵守不含登录这个要求', 1),
      turn('user', '帮我做个工具', 2),
    ])
    expect(scanSessionConstraints('session-assistant-only')).toEqual([])
  })

  it('历史窗口是显式常量（默认 10 轮，不再静默写死 20）', () => {
    expect(HISTORY_WINDOW_TURNS).toBe(10)
  })
})

describe('T4-L1 约束走门：捕获入库与决策留痕', () => {
  beforeEach(() => {
    useTempHome()
  })

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  it('captureConstraints 持久化 project.constraints 并落决策行；重复声明不重复入库', () => {
    const project = createProject({ request_id: 'req-c', mode: 'quick', initial_message: '记账本' })
    const first = captureConstraints({
      project_id: project.project_id,
      session_id: 'session-c',
      constraints: extractConstraints('不含登录，必须离线可用'),
      source: 'guide_gate',
    })
    expect(first).toEqual(['不含登录', '必须离线可用'])
    expect(findProject(project.project_id).constraints).toEqual(['不含登录', '必须离线可用'])

    // 重复声明：不加噪声、不再落决策
    const second = captureConstraints({
      project_id: project.project_id,
      session_id: 'session-c',
      constraints: ['不含登录'],
      source: 'session_scan',
    })
    expect(second).toEqual([])
    expect(findProject(project.project_id).constraints).toEqual(['不含登录', '必须离线可用'])

    const sessionLines = readFileSync(getAgentSessionPath('session-c'), 'utf8')
    expect(sessionLines.match(/constraint_captured/g)?.length).toBe(1)
  })

  it('项目索引缺失（测试字面 id）时静默跳过，不抛错不阻塞主流程', () => {
    expect(() =>
      captureConstraints({ project_id: 'literal-id', session_id: 'session-x', constraints: ['不含登录'], source: 'guide_gate' }),
    ).not.toThrow()
  })

  it('buildPrdBackplane 组装 constraints 常驻注入', () => {
    const project = createProject({ request_id: 'req-bp', mode: 'quick', initial_message: '记账本' })
    captureConstraints({ project_id: project.project_id, session_id: 'session-bp', constraints: ['不含登录', '必须离线可用'], source: 'guide_gate' })
    const requirements: SketchRequirement[] = [{ id: 'F-001', description: '记账本' }]
    const backplane = buildPrdBackplane(findProject(project.project_id), requirements, 'sketch_confirmed')
    expect(backplane.constraints).toEqual(['不含登录', '必须离线可用'])
  })
})

describe('T4-L1 约束注入生成提示词（背板常驻）', () => {
  beforeEach(() => {
    useTempHome()
  })

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    vi.restoreAllMocks()
  })

  it('草图提示词包含用户约束段', async () => {
    const project = createProject({ request_id: 'req-sk', mode: 'quick', initial_message: '记账本' })
    captureConstraints({ project_id: project.project_id, session_id: 'session-sk', constraints: ['不含登录'], source: 'guide_gate' })
    const prompts: string[] = []
    const query = async function* (prompt: string): AsyncGenerator<SDKMessage> {
      prompts.push(prompt)
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: '<!doctype html><html><head><style>a{}</style></head><body><button>存</button><script>1</script></body></html>' }] },
      }
      yield { type: 'result', subtype: 'success' }
    }
    await generateSketchLlm({
      project_id: project.project_id,
      requirements: [{ id: 'F-001', description: '记账本' }],
      constraints: findProject(project.project_id).constraints,
      query,
      env: {},
      sessionId: 'session-sk',
    })
    expect(prompts[0]).toContain('不含登录')
    expect(prompts[0]).toContain('用户约束')
  })

  it('MVP 提示词包含用户约束段', async () => {
    const project = createProject({ request_id: 'req-mvp', mode: 'quick', initial_message: '记账本' })
    const backplane: PrdBackplane = {
      project_id: project.project_id,
      name: '记账本',
      positioning: '记账本',
      requirements: [{ id: 'F-001', description: '记账本' }],
      acceptance: {},
      out_of_scope: [],
      constraints: ['不含登录', '必须离线可用'],
      assumptions: [],
    }
    const prompts: string[] = []
    const query = async function* (prompt: string): AsyncGenerator<SDKMessage> {
      prompts.push(prompt)
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: JSON.stringify({
              files: [{ path: 'index.html', content: '<!doctype html><html><head><style>a{}</style></head><body><button>存</button></body></html>' }],
              run_command: 'npm start',
            }),
          }],
        },
      }
      yield { type: 'result', subtype: 'success' }
    }
    await generateMvpLlm({ project_id: project.project_id, backplane, query, env: {}, sessionId: 'session-mvp' })
    expect(prompts[0]).toContain('用户约束')
    expect(prompts[0]).toContain('不含登录')
    expect(prompts[0]).toContain('必须离线可用')
  })
})

describe('T4-L2 runAgent 读取侧：全量扫描回灌引导上下文', () => {
  beforeEach(() => {
    useTempHome()
    createChannel({
      name: 'test-channel',
      provider_type: 'anthropic',
      base_url: 'https://example.test',
      api_key: 'key',
      models: [{ id: 'm1', name: 'model-a', enabled: true }],
    })
  })

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    setAgentStreamPublisher(() => undefined)
    setSDKQueryForTests(resetQuery)
    vi.unstubAllGlobals()
  })

  const resetQuery = async function* (): AsyncGenerator<SDKMessage> {
    yield { type: 'result', subtype: 'success' }
  }

  it('>30 轮后新消息：约束系统行进入模型历史，且漏网约束回填 project.constraints', async () => {
    const project = createProject({ request_id: 'req-e2e', mode: 'quick', initial_message: '帮我做一个记账应用' })
    // 项目建立时没有约束门（模拟 L1 落地前的历史会话）：约束只存在于第 1 轮 JSONL
    writeSession('session-e2e', longSession(32))

    const capturedHistories: Array<Array<{ role: string; content: string }>> = []
    setSDKQueryForTests(async function* (_prompt: string, options) {
      capturedHistories.push(options.history ?? [])
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: JSON.stringify({
              action: 'ask_clarification',
              reply: '想要哪种界面风格？',
              questions: [{ id: 'a', label: '简洁卡片', description: '清爽排版' }, { id: 'auto', label: '你帮我决定', description: '交给我' }],
            }),
          }],
        },
      }
      yield { type: 'result', subtype: 'success' }
    })

    await runAgent({
      request_id: 'req-e2e',
      session_id: 'session-e2e',
      project_id: project.project_id,
      content: '再加一个导出功能',
      mode: 'quick',
      current_stage: 'clarifying',
    })

    // 约束系统行注入模型历史（无论隔了多少轮）
    const constraintTurns = capturedHistories
      .flat()
      .filter((t) => t.role === 'system' && t.content.includes('不含登录'))
    expect(constraintTurns.length).toBeGreaterThan(0)
    // 历史窗口收敛为近 10 轮原文（不含约束系统行时 user/assistant 轮数 ≤ 10）
    const dialogueTurns = (capturedHistories[0] ?? []).filter((t) => t.role !== 'system')
    expect(dialogueTurns.length).toBeLessThanOrEqual(HISTORY_WINDOW_TURNS)
    // 漏网约束回填 L1 存储：从此随背板常驻，不依赖下一次扫描
    expect(findProject(project.project_id).constraints).toContain('不含登录')
  })
})
