import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { IPC_CHANNELS, type ApiResult } from '../../../shared/types'
import { createIpcHarness } from '../support/ipc-harness'

const root = fileURLToPath(new URL('../../..', import.meta.url))
// 与 shared/types.ts 的 IPC_CHANNELS 逐项一致。通道新增/删除（含整线退役）必须同步
// 本清单与 S0-IPC-006 扫描面（main/ipc.ts + main/ipc/ 全目录）——web 线拆除
// （2026-10-01）曾因漏同步致 S0-IPC-005/006 长期存量红、契约保护空转（教训勿重犯）。
const expectedChannels = {
  ATTACHMENT_HISTORY: 'attachment:history',
  ATTACHMENT_IMPORT: 'attachment:import',
  ATTACHMENT_PREVIEW: 'attachment:preview',
  ATTACHMENT_READ: 'attachment:read',
  ATTACHMENT_REUSE: 'attachment:reuse',
  CHAT_RECEIPT: 'chat:receipt',
  CHAT_RECEIPTS: 'chat:receipts',
  CHAT_RECOVER: 'chat:recover',
  CHAT_SUBMIT: 'chat:submit',
  CLIPBOARD_WRITE_TEXT: 'clipboard:write-text',
  COMPOSER_LOAD: 'composer:load',
  COMPOSER_SAVE: 'composer:save',
  NOTIFICATION_SPEAK: 'notification:speak',
  AGENT_SEND_MESSAGE: 'agent:send-message',
  AGENT_STEER_MESSAGE: 'agent:steer-message',
  AGENT_STEER_RESOLVE: 'agent:steer-resolve',
  AGENT_STEER_QUERY: 'agent:steer-query',
  AGENT_FORK_SESSION: 'agent:fork-session',
  AGENT_STOP: 'agent:stop',
  AGENT_LIST_SESSIONS: 'agent:list-sessions',
  AGENT_LOAD_MESSAGES: 'agent:load-messages',
  AGENT_CONFIRM_REQUIREMENTS: 'agent:confirm-requirements',
  PASTED_IMAGE_SAVE: 'pasted-image:save',
  SESSION_CLEAN_ORPHANS: 'session:clean-orphans',
  AGENT_STREAM_EVENT: 'agent:stream-event',
  PERMISSION_RESPONSE: 'permission:response',
  PERMISSION_SET_MODE: 'permission:set-mode',
  PROJECT_CREATE: 'project:create',
  PROJECT_LIST: 'project:list',
  PROJECT_ARCHIVE: 'project:archive',
  PROJECT_UNARCHIVE: 'project:unarchive',
  PROJECT_DELETE: 'project:delete',
  PROJECT_UPGRADE: 'project:upgrade',
  PROJECT_FINALIZE: 'project:finalize',
  PROJECT_EXPORT: 'project:export',
  PROJECT_RENAME: 'project:rename',
  PROJECT_UPGRADE_EXPORT: 'project:upgrade-export',
  PROJECT_FILE_READ: 'project:file-read',
  APP_SWITCH_STATE: 'app:switch-state',
  PROJECT_ABANDON: 'project:abandon',
  PROJECT_REOPEN: 'project:reopen',
  SANDBOX_RUN: 'sandbox:run',
  SANDBOX_STOP: 'sandbox:stop',
  SANDBOX_RESTORE: 'sandbox:restore',
  SNAPSHOT_CREATE: 'snapshot:create',
  SNAPSHOT_ROLLBACK: 'snapshot:rollback',
  SNAPSHOT_LIST: 'snapshot:list',
  SNAPSHOT_SCREENSHOT: 'snapshot:screenshot',
  SNAPSHOT_DOCUMENT_LIST: 'snapshot:document-list',
  SNAPSHOT_DOCUMENT_READ: 'snapshot:document-read',
  DOCUMENT_SYNC: 'document:sync',
  DOCUMENT_LIST: 'document:list',
  DOCUMENT_READ: 'document:read',
  ANALYTICS_TRACK: 'analytics:track',
  CHANNEL_LIST: 'channel:list',
  CHANNEL_CREATE: 'channel:create',
  CHANNEL_UPDATE: 'channel:update',
  CHANNEL_TEST: 'channel:test',
  CHANNEL_TEST_DIRECT: 'channel:test-direct',
  CHANNEL_FETCH_MODELS: 'channel:fetch-models',
  CHANNEL_DELETE: 'channel:delete',
  CATEGORY_ROUTING_LIST: 'category-routing:list',
  CATEGORY_ROUTING_UPDATE: 'category-routing:update',
  CATEGORY_ROUTING_ROLE_LIST: 'category-routing:role-list',
  CATEGORY_ROUTING_ROLE_UPDATE: 'category-routing:role-update',
  PROMPT_LIST: 'prompt:list',
  PROMPT_READ: 'prompt:read',
  PROMPT_SAVE: 'prompt:save',
  PROMPT_RESET: 'prompt:reset',
  DESKTOP_ARTIFACT_SUBSCRIBE: 'desktop:artifact-subscribe',
  DESKTOP_ARTIFACT_IMAGE: 'desktop:artifact-image',
  DESKTOP_ARTIFACT_EVENT: 'desktop:artifact-event',
  PROJECT_DELIVERABLES: 'project:deliverables',
  PROJECT_LAUNCH_APP: 'project:launch-app',
  CORRECTION_START: 'correction:start',
  CORRECTION_PICKS: 'correction:picks',
  CORRECTION_FINISH: 'correction:finish',
  SPEECH_CATALOG: 'speech:catalog',
  SPEECH_PREPARE: 'speech:prepare',
  SPEECH_CANCEL_PREPARATION: 'speech:cancel-preparation',
  SPEECH_TRANSCRIBE: 'speech:transcribe',
} as const

describe('Sprint 0 IPC contract acceptance', () => {
  it('[S0-IPC-005] Phase 1 channel 集合应与 API 规范完全一致', () => {
    expect(IPC_CHANNELS).toEqual(expectedChannels)
  })

  it('[S0-IPC-006] 每个 channel 应由 main 注册并由 preload 通过常量调用', () => {
    // PR4d 拆解后注册分居 main/ipc.ts（跨族接线）+ main/ipc/ 六族——扫描面聚合全目录
    const mainReferences = collectIpcChannelReferences(join(root, 'main', 'ipc.ts'))
    for (const file of readdirSync(join(root, 'main', 'ipc'))) {
      if (file.endsWith('.ts')) {
        for (const ref of collectIpcChannelReferences(join(root, 'main', 'ipc', file))) {
          mainReferences.add(ref)
        }
      }
    }
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
