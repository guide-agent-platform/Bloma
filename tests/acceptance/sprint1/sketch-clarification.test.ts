import { afterEach, describe, expect, it } from 'vitest'
import { IPC_CHANNELS, type AgentEvent, type ApiResult, type Project } from '../../../shared/types'
import { createIpcHarness } from '../support/ipc-harness'
import { useTemporaryPromaHome, type TemporaryPromaHome } from '../support/test-environment'

describe('Sprint 1 sketch clarification acceptance', () => {
  let environment: TemporaryPromaHome | undefined

  afterEach(() => {
    environment?.cleanup()
    environment = undefined
  })

  it('[S1-SKETCH-004] 模糊需求应给出不超过三个非技术选项并包含“你帮我决定”', async () => {
    environment = useTemporaryPromaHome('bloma-role-c-clarify-')
    const harness = createIpcHarness()
    const project = await createProject(harness, 'quick')

    const response = await harness.invoke(IPC_CHANNELS.AGENT_SEND_MESSAGE, {
      request_id: 'role-c-vague',
      session_id: 'role-c-vague-session',
      project_id: project.project_id,
      content: '帮我做个东西',
      mode: 'quick',
      current_stage: 'clarifying',
    }) as ApiResult<unknown>
    const decision = findEvent(harness.events, 'user_decision_required')
    const options = decision?.payload.options as Array<{ label: string; description?: string }>

    expect(response.ok).toBe(true)
    expect(options.length).toBeGreaterThanOrEqual(2)
    expect(options.length).toBeLessThanOrEqual(3)
    expect(options.some((option) => /你帮我决定/.test(option.label))).toBe(true)
    expect(JSON.stringify(options)).not.toMatch(/API|数据库|框架|代码|技术栈|HTTP/i)
  })

  it('[S1-SKETCH-005] 长期模式缺少使用对象时应继续澄清而不是直接生成', async () => {
    environment = useTemporaryPromaHome('bloma-role-c-longterm-clarify-')
    const harness = createIpcHarness()
    const project = await createProject(harness, 'longterm')

    const response = await harness.invoke(IPC_CHANNELS.AGENT_SEND_MESSAGE, {
      request_id: 'role-c-longterm-vague',
      session_id: 'role-c-longterm-session',
      project_id: project.project_id,
      content: '做一个可以记录收入支出并展示月度结余的管理页面',
      mode: 'longterm',
      current_stage: 'clarifying',
    }) as ApiResult<unknown>

    expect(response.ok).toBe(true)
    expect(findEvent(harness.events, 'user_decision_required')).toBeTruthy()
    expect(findEvent(harness.events, 'sketch_ready')).toBeUndefined()
  })
})

async function createProject(
  harness: ReturnType<typeof createIpcHarness>,
  mode: Project['mode'],
): Promise<Project> {
  const response = await harness.invoke(IPC_CHANNELS.PROJECT_CREATE, {
    request_id: `role-c-create-${mode}`,
    mode,
  }) as ApiResult<Project>
  expect(response.ok).toBe(true)
  if (!response.ok) throw new Error(response.error.message)
  return response.data
}

function findEvent(events: AgentEvent[], type: AgentEvent['type']): AgentEvent | undefined {
  return events.find((event) => event.type === type)
}
