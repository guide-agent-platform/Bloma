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
  AGENT_SEND_MESSAGE: 'agent:send-message',
  CHAT_SUBMIT: 'chat:submit',
  COMPOSER_LOAD: 'composer:load',
  COMPOSER_SAVE: 'composer:save',
  ATTACHMENT_IMPORT: 'attachment:import',
  ATTACHMENT_PREVIEW: 'attachment:preview',
  ATTACHMENT_READ: 'attachment:read',
  CHAT_RECEIPT: 'chat:receipt',
  CHAT_RECEIPTS: 'chat:receipts',
  CHAT_RECOVER: 'chat:recover',
  ATTACHMENT_HISTORY: 'attachment:history',
  ATTACHMENT_REUSE: 'attachment:reuse',
  /** 运行中转向（P0-1 steer，2026-09-08）：活跃主 loop 期间输入框改道本通道，批间注入 */
  AGENT_STEER_MESSAGE: 'agent:steer-message',
  /** I3 转向生效确认链（P7-7，2026-09-11）：中/高档影响卡三选回执 */
  AGENT_STEER_RESOLVE: 'agent:steer-resolve',
  /** I3：会话 steer 状态查询（渲染端刷新后状态条恢复） */
  AGENT_STEER_QUERY: 'agent:steer-query',
  /** 会话 fork（P0-2，2026-09-08）：从任意 user 消息重开，复制前缀到新会话 */
  AGENT_FORK_SESSION: 'agent:fork-session',
  CLIPBOARD_WRITE_TEXT: 'clipboard:write-text',
  PASTED_IMAGE_SAVE: 'pasted-image:save',
  AGENT_STOP: 'agent:stop',
  AGENT_LIST_SESSIONS: 'agent:list-sessions',
  AGENT_LOAD_MESSAGES: 'agent:load-messages',
  AGENT_CONFIRM_REQUIREMENTS: 'agent:confirm-requirements',
  SESSION_CLEAN_ORPHANS: 'session:clean-orphans',
  AGENT_STREAM_EVENT: 'agent:stream-event',
  PERMISSION_RESPONSE: 'permission:response',
  PERMISSION_SET_MODE: 'permission:set-mode',
  PROJECT_CREATE: 'project:create',
  PROJECT_IMPORT: 'project:import',
  PROJECT_MIGRATE_WORKFLOW: 'project:migrate-workflow',
  PROJECT_LIST: 'project:list',
  PROJECT_ARCHIVE: 'project:archive',
  PROJECT_UNARCHIVE: 'project:unarchive',
  PROJECT_DELETE: 'project:delete',
  PROJECT_UPGRADE: 'project:upgrade',
  PROJECT_FINALIZE: 'project:finalize',
  PROJECT_EXPORT: 'project:export',
  PROJECT_RENAME: 'project:rename',
  PROJECT_UPGRADE_EXPORT: 'project:upgrade-export',
  /** 产物文件只读查看（项目根内、拒基础设施目录与二进制）——文档面板文件渲染 */
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
  /** 刀3 呈现层（2026-10-02）：桌面线产物预览——订阅（启动 watcher+快照清单）/图片读取/变更推送 */
  DESKTOP_ARTIFACT_SUBSCRIBE: 'desktop:artifact-subscribe',
  DESKTOP_ARTIFACT_IMAGE: 'desktop:artifact-image',
  DESKTOP_ARTIFACT_EVENT: 'desktop:artifact-event',
  /** 交付面板（2026-10-04 呈现层收口）：桌面项目文件清单+DELIVERY.md+启动声明；启动程序 */
  PROJECT_DELIVERABLES: 'project:deliverables',
  PROJECT_LAUNCH_APP: 'project:launch-app',
  SOFTWARE_SUGGESTIONS_DECIDE: 'software:suggestions-decide',
  SOFTWARE_LONGTERM_ACTION: 'software:longterm-action',
  SOFTWARE_MODEL_SETTINGS_GET: 'software:model-settings-get',
  SOFTWARE_MODEL_SETTINGS_SAVE: 'software:model-settings-save',
  /** 点选纠错会话（批11 MVP-E，2026-10-08）：修改预览实例拉起/选区轮询/收口 */
  CORRECTION_START: 'correction:start',
  CORRECTION_PICKS: 'correction:picks',
  CORRECTION_FINISH: 'correction:finish',
  /** 语音输入（2026-10-05 语音批 A 线）：就绪快照轮询 / 准备（下载模型）/ 取消准备 / 转写 */
  SPEECH_CATALOG: 'speech:catalog',
  SPEECH_PREPARE: 'speech:prepare',
  SPEECH_CANCEL_PREPARATION: 'speech:cancel-preparation',
  SPEECH_TRANSCRIBE: 'speech:transcribe',
  NOTIFICATION_SPEAK: 'notification:speak',
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
