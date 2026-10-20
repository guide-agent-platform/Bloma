import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgent, setAgentStreamPublisher, setSDKQueryForTests } from '../../../main/orchestration/orchestrator'
import { createProject, findProject } from '../../../main/project/project-service'
import { guideDecideQuery } from '../../support/guide-decide-stream'
import { useTemporaryPromaHome, type TemporaryPromaHome } from '../support/test-environment'
import type { AgentEvent } from '../../../shared/types'
import { resetSessionTreeForTests } from '../../../main/platform/sessions/session-tree'

vi.mock('../../../main/platform/llm/channel-manager', async importOriginal => ({
  ...await importOriginal<typeof import('../../../main/platform/llm/channel-manager')>(),
  getChannelByIdRaw: () => ({
    id: 'test-channel', name: 'Test', provider_type: 'anthropic',
    base_url: 'https://model.invalid', api_key: 'test-encrypted', enabled: true,
    models: [{ id: 'test-model', name: 'test-model', enabled: true }],
  }),
  decryptApiKey: () => 'test-key',
  getFirstEnabledChannel: () => undefined,
}))
vi.mock('../../../main/guide/guide-research', async importOriginal => ({
  ...await importOriginal<typeof import('../../../main/guide/guide-research')>(),
  researchMarketSimilar: vi.fn(async (queries: string[]) => ({
    available: false, queries, results: [], summary: '', reason: 'empty',
  })),
}))

// 旧夹具将JSON文本当作决策，并期待生成Web草图。当前验收使用真实guide_decide
// 工具流与宿主路由，保留首轮护栏、连续澄清收敛与实际分析事件的行为验证。
describe('原生向导澄清与确认门验收', () => {
  let environment: TemporaryPromaHome | undefined
  beforeEach(() => resetSessionTreeForTests())
  afterEach(() => {
    environment?.cleanup()
    environment = undefined
    setAgentStreamPublisher(() => undefined)
    setSDKQueryForTests(async function* () { throw new Error('No fixture configured') })
    vi.restoreAllMocks()
  })

  function setup() {
    environment = useTemporaryPromaHome('bloma-native-guide-acceptance-')
    const project = createProject({ request_id: 'project', mode: 'quick' })
    const events: AgentEvent[] = []
    setAgentStreamPublisher(event => events.push(event))
    const send = (content: string, index: number, optionId?: string) => runAgent({
      request_id: `request-${index}`, session_id: 'native-guide-session', project_id: project.project_id,
      content, mode: 'quick', current_stage: findProject(project.project_id).current_stage,
      channel_id: 'test-channel',
      ...(optionId ? { metadata: { source: 'card_option' as const, selected_option_id: optionId } } : {}),
    })
    return { project, events, send }
  }

  it('guide_decide原生决策产生澄清卡并记录conversation_submitted', async () => {
    const { project, events, send } = setup()
    setSDKQueryForTests(guideDecideQuery({
      action: 'ask_clarification', reply: '主要给谁使用？',
      questions: [{ id: 'self', label: '自己使用' }, { id: 'family', label: '全家使用' }],
    }, { narration: false }))
    await send('做一个家庭记账工具', 1)
    const cards = events.filter(event => event.type === 'user_decision_required')
    expect(cards).toHaveLength(1)
    expect(cards[0].payload.kind).toBe('clarification')
    expect(findProject(project.project_id).current_stage).toBe('blocked_for_user_decision')
    const analytics = readFileSync(join(environment!.home, 'agent-workspaces', 'default-software-builder', 'analytics.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map(line => JSON.parse(line))
    expect(analytics.find(event => event.event_type === 'conversation_submitted')?.project_id).toBe(project.project_id)
  })

  it('首轮模型企图直接开工仍须澄清，不进入桌面制作或旧Web草图', async () => {
    const { project, events, send } = setup()
    setSDKQueryForTests(guideDecideQuery({
      action: 'generate_sketch', reply: '马上开始',
      requirements: [{ id: 'F-001', description: '记录家庭收支' }],
    }, { narration: false }))
    await send('做一个家庭记账工具', 1)
    expect(events.find(event => event.type === 'user_decision_required')?.payload.kind).toBe('clarification')
    expect(events.some(event => event.type === 'sketch_ready')).toBe(false)
    expect(findProject(project.project_id).desktop_phase).toBeUndefined()
  })

  it('连续三轮点选后仍追问时转需求确认，保留已选方向且不擅自开工', async () => {
    const { project, events, send } = setup()
    vi.stubEnv('BLOMA_CLARIFY_TWO_LAYER', '0')
    try {
      setSDKQueryForTests(guideDecideQuery({
        action: 'ask_clarification', reply: '主要给谁使用？',
        questions: [{ id: 'self', label: '自己使用' }, { id: 'family', label: '全家使用' }],
      }, { narration: false }))
      await send('做一个家庭记账工具', 0)
      await send('自己使用', 1, 'self')
      await send('按月统计', 2, 'monthly')
      await send('导出CSV', 3, 'export')
      const cards = events.filter(event => event.type === 'user_decision_required')
      expect(cards).toHaveLength(4)
      expect(cards[3].payload.kind).toBe('requirement_confirm')
      for (const chosen of ['自己使用', '按月统计', '导出CSV']) expect(JSON.stringify(cards[3].payload.requirements)).toContain(chosen)
      expect(findProject(project.project_id).current_stage).toBe('blocked_for_user_decision')
      expect(findProject(project.project_id).desktop_phase).toBeUndefined()
      const session = readFileSync(join(environment!.home, 'agent-sessions', 'native-guide-session.jsonl'), 'utf8')
      expect(session).toContain('clarification_forced_confirm')
      expect(session).toContain('做一个家庭记账工具')
    } finally { vi.unstubAllEnvs() }
  })
})
