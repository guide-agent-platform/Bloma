import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { IPC_CHANNELS, type ApiResult } from '../../../shared/types'
import { createIpcHarness } from '../support/ipc-harness'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const expectedChannels = {
  AGENT_SEND_MESSAGE: 'agent:send-message',
  AGENT_STOP: 'agent:stop',
  AGENT_LIST_SESSIONS: 'agent:list-sessions',
  AGENT_LOAD_MESSAGES: 'agent:load-messages',
  AGENT_STREAM_EVENT: 'agent:stream-event',
  PERMISSION_RESPONSE: 'permission:response',
  PROJECT_CREATE: 'project:create',
  PROJECT_LIST: 'project:list',
  PROJECT_ARCHIVE: 'project:archive',
  PROJECT_CONFIRM_SKETCH: 'project:confirm-sketch',
  PROJECT_SUBMIT_CORRECTION: 'project:submit-correction',
  PROJECT_UPGRADE: 'project:upgrade',
  SANDBOX_RUN: 'sandbox:run',
  SANDBOX_STOP: 'sandbox:stop',
  SNAPSHOT_CREATE: 'snapshot:create',
  SNAPSHOT_ROLLBACK: 'snapshot:rollback',
  DOCUMENT_SYNC: 'document:sync',
  ANALYTICS_TRACK: 'analytics:track',
  CHANNEL_LIST: 'channel:list',
  CHANNEL_CREATE: 'channel:create',
  CHANNEL_TEST: 'channel:test',
  CHANNEL_DELETE: 'channel:delete',
} as const

describe('Sprint 0 IPC contract acceptance', () => {
  it('[S0-IPC-005] Phase 1 channel 集合应与 API 规范完全一致', () => {
    expect(IPC_CHANNELS).toEqual(expectedChannels)
  })

  it('[S0-IPC-006] 每个 channel 应由 main 注册并由 preload 通过常量调用', () => {
    const mainReferences = collectIpcChannelReferences(join(root, 'main', 'ipc.ts'))
    const preloadReferences = collectIpcChannelReferences(join(root, 'preload', 'bridge.ts'))
    const expectedNames = Object.keys(expectedChannels).sort()

    expect([...mainReferences].sort()).toEqual(expectedNames)
    expect([...preloadReferences].sort()).toEqual(expectedNames)
  })

  it('[S0-IPC-007] 非法项目模式应返回保留 request_id 的统一失败 ApiResult', async () => {
    const harness = createIpcHarness()
    const response = await harness.invoke(IPC_CHANNELS.PROJECT_CREATE, {
      request_id: 'role-c-invalid-mode',
      mode: 'temporary',
    }) as ApiResult<unknown>

    expect(response).toEqual({
      ok: false,
      request_id: 'role-c-invalid-mode',
      error: expect.objectContaining({
        code: 'VALIDATION_ERROR',
        retryable: false,
        user_visible_message: '这次操作缺少必要信息，请再试一次。',
      }),
    })
  })
})

function collectIpcChannelReferences(path: string): Set<string> {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const references = new Set<string>()

  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node)
      && node.expression.getText(source) === 'IPC_CHANNELS'
    ) {
      references.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return references
}
