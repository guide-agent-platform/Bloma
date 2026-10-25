import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import { findProject } from '../project/project-service'
import { readLaunchDeclaration } from '../desktop/launch-smoke'
import { parseGuiSuite, type GuiAcceptanceSuite } from '../desktop/gui-acceptance'
import { observeSoftwareGui } from './gui-observer'
import { softwareVerificationFingerprint as verificationFingerprint } from '../desktop/verification-fingerprint'
import { savePastedImage, MAX_PASTED_IMAGE_BYTES } from '../platform/shell/pasted-images'
import type { createSoftwareCollaborationPolicy } from './collaboration-policy'
import { guiInputFailure, guiStepsSchema, SOFTWARE_GUI_ACTION_KINDS } from '../desktop/gui-tool-contract'
import { actDebugSession, closeDebugSession, openDebugSession, readDebugSession, installDebugFixtures, activeDebugSessionId, assertDebugSessionProcess, retainedDebugFixtures } from './debug-sessions'
import { activeSoftwarePreview } from './process-manager'
import { GUI_FIXTURE_SCHEMA, materializeGuiFixtures, sealGuiFixtures } from '../desktop/gui-fixtures'
import { guiVerificationReadiness } from './verification-readiness'

export function buildSoftwareInspectTool(projectId: string, policy: ReturnType<typeof createSoftwareCollaborationPolicy>, previewChanged?: (url?: string) => void): AgentLoopTool {
  return { name: 'inspect_app', description: '实际操作Electron/浏览器程序。默认自动打开并持续复用本会话实例，源码变化时重载实际入口并保留测试数据；返回控件定位、当前值和具体失败。无需每次传会话id。restart动作会重启程序并保留数据；mode=once才使用单次全新隔离现场。open可带process_id连接本会话已有服务；read/reload/close可显式控制。默认只有新日志和截图路径，仅已知视觉渠道设include_image=true。调试成功不等于最终验收，完成规则登记后用verify_app。',
    input_schema: { type: 'object', properties: { mode: { type: 'string', enum: ['once', 'open', 'act', 'read', 'reload', 'close'] },
      debug_session_id: { type: 'string' }, process_id: { type: 'string' }, since_seq: { type: 'integer', minimum: 0 },
      include_image: { type: 'boolean' }, fixtures: GUI_FIXTURE_SCHEMA, steps: guiStepsSchema(32, SOFTWARE_GUI_ACTION_KINDS) } },
    execute: async (input, ctx) => {
      let temporary: string | undefined
      let openingDebugId: string | undefined
      try {
        policy.assertCommand(ctx)
        let mode = input.mode
        if (mode === undefined || ['open', 'act', 'reload'].includes(String(mode))) {
          const existing = input.debug_session_id as string | undefined ?? activeDebugSessionId(projectId, ctx.sessionId)
          if (existing) {
            const snapshot = readDebugSession(projectId, ctx.sessionId, existing)
            if (!['opening', 'ready'].includes(snapshot.state)) { input = { ...input, debug_session_id: undefined }; mode = 'open' }
            else {
              input = { ...input, debug_session_id: existing }
              if (mode === undefined || mode === 'open' || mode === 'act') mode = snapshot.stale ? 'reload' : 'act'
            }
          } else mode = 'open'
        }
        if (!['once', 'open', 'act', 'read', 'reload', 'close'].includes(String(mode))) throw Error('GUI_DEBUG_MODE_INVALID: mode需once/open/act/read/reload/close')
        if (mode !== 'once') {
          const args = { projectId, sessionId: ctx.sessionId, id: String(input.debug_session_id ?? ''), signal: ctx.signal }
          if (mode !== 'open' && !input.debug_session_id) throw Error('GUI_DEBUG_ID_REQUIRED: 使用open返回的debug_session_id')
          if (mode !== 'open' && input.process_id) assertDebugSessionProcess(projectId, ctx.sessionId, args.id, String(input.process_id))
          const cursor = input.since_seq ?? (mode === 'act' || mode === 'reload' ? readDebugSession(projectId, ctx.sessionId, args.id).log_cursor ?? 0 : 0)
          let sealed: GuiAcceptanceSuite | undefined
          let additions: GuiAcceptanceSuite | undefined
          if (mode !== 'read' && mode !== 'close') {
            const root = findProject(projectId).root_path, existing = mode === 'open' ? undefined : readDebugSession(projectId, ctx.sessionId, args.id)
            const fixtures = [...new Map([...(existing?.fixtures ?? (mode === 'open' ? retainedDebugFixtures(projectId, ctx.sessionId) : [])), ...((input.fixtures ?? []) as NonNullable<GuiAcceptanceSuite['fixtures']>)].map(file => [file.path, file])).values()]
            const suite = parseGuiSuite({ version: 1, scope_hash: verificationFingerprint(root) ?? '', covers: ['F-001'], fixtures,
              steps: input.steps ?? [{ id: 'fixture_binding', kind: 'expect', selector: 'body', nonempty: true }] }, { allowActionsOnly: true })
            // Existing inputs are already frozen. Adding another input must not
            // silently re-read old source files under the newer code version.
            additions = input.fixtures ? sealGuiFixtures(projectId, root, { ...suite, fixtures: input.fixtures as GuiAcceptanceSuite['fixtures'] }) : undefined
            sealed = suite
          }
          const steps = input.steps ? sealed?.steps : undefined
          let snapshot
          if (mode === 'open') {
            const root = findProject(projectId).root_path, declared = readLaunchDeclaration(root)
            if (!declared?.ok) throw Error('DEBUG_LAUNCH_REQUIRED')
            snapshot = await openDebugSession({ projectId, sessionId: ctx.sessionId, root, launch: declared.launch, signal: ctx.signal, processId: input.process_id as string | undefined })
            openingDebugId = snapshot.id
            if (additions) installDebugFixtures(projectId, ctx.sessionId, snapshot.id, additions)
            snapshot = await actDebugSession({ ...args, id: snapshot.id, steps: steps ?? [{ id: 'screen', kind: 'expect', selector: 'body', nonempty: true }] })
          } else if (mode === 'close') snapshot = await closeDebugSession(projectId, ctx.sessionId, args.id)
          else if (mode === 'read') snapshot = readDebugSession(projectId, ctx.sessionId, args.id, Number(input.since_seq ?? 0))
          else { if (additions) installDebugFixtures(projectId, ctx.sessionId, args.id, additions); snapshot = await actDebugSession({ ...args, steps, reload: mode === 'reload' }) }
          if (mode === 'act' || mode === 'reload') snapshot = readDebugSession(projectId, ctx.sessionId, args.id, Number(cursor))
          if (mode === 'open' && snapshot.url) previewChanged?.(snapshot.url)
          if (mode === 'close') previewChanged?.(activeSoftwarePreview(projectId, ctx.sessionId))
          const imageBytes = input.include_image === true && snapshot.screenshot ? readFileSync(snapshot.screenshot) : undefined
          const images = imageBytes && imageBytes.length <= MAX_PASTED_IMAGE_BYTES ? [savePastedImage(ctx.sessionId, imageBytes.toString('base64'), 'png')] : undefined
          const failed = snapshot.steps.find(step => !step.passed)
          return { output: JSON.stringify({ debug_session_id: snapshot.id, state: snapshot.state, stale: snapshot.stale, error: snapshot.error, failed_step: failed,
            verification_readiness: guiVerificationReadiness(projectId),
            version: snapshot.version, resumed_from: snapshot.resumed_from, ui: snapshot.ui, steps: snapshot.steps, observations: snapshot.observations, log_cursor: snapshot.log_cursor,
            observations_omitted: snapshot.observations_omitted, data_dir: snapshot.data_dir, url: snapshot.url, screenshot: snapshot.screenshot,
            visual_review: images ? 'image_attached_for_current_channel' : 'not_reviewed_by_model', evidence: '持续开发观察，非最终验收凭据' }), images,
            isError: snapshot.state === 'failed' || Boolean(snapshot.error) || snapshot.stale || snapshot.steps.some(step => !step.passed) }
        }
        const root = findProject(projectId).root_path, launch = readLaunchDeclaration(root)
        if (!launch?.ok || !['electron', 'browser'].includes(launch.launch.ui ?? '')) throw Error('INSPECT_RUNTIME_UNSUPPORTED: 请登记实际Electron/浏览器入口；其它入口由对应宿主观察器检查')
        const fingerprint = verificationFingerprint(root)
        if (!fingerprint) throw Error('INSPECT_SOURCE_UNREADABLE')
        const suite = sealGuiFixtures(projectId, root, parseGuiSuite({ version: 1, scope_hash: fingerprint, covers: ['F-001'], fixtures: input.fixtures, steps: input.steps ?? [{ id: 'screen', kind: 'expect', selector: 'body', nonempty: true }] }, { allowActionsOnly: true }))
        temporary = mkdtempSync(join(tmpdir(), 'bloma-inspect-'))
        materializeGuiFixtures(projectId, suite, join(temporary, 'data'))
        const screenshotDir = join(root, '00_VERIFY/screenshots', `inspect-${randomUUID()}`)
        mkdirSync(screenshotDir, { recursive: true })
        const result = await observeSoftwareGui({ projectId, root, launch: launch.launch, suite, temporary, signal: ctx.signal, screenshotDir })
        const files = readdirSync(screenshotDir).filter(file => file.endsWith('.png')).sort()
        const name = files.find(file => file.endsWith('-failed.png')) ?? files.at(-1), file = name ? join(screenshotDir, name) : undefined
        const bytes = result.status !== 'unverified' && file ? readFileSync(file) : undefined
        const images = input.include_image === true && bytes && bytes.length <= MAX_PASTED_IMAGE_BYTES ? [savePastedImage(ctx.sessionId, bytes.toString('base64'), 'png')] : undefined
        return { output: JSON.stringify({ ...result, screenshot: file, visual_review: images ? 'image_attached_for_current_channel' : 'not_reviewed_by_model', evidence: '开发观察，不是最终验收凭据', verification_readiness: guiVerificationReadiness(projectId), source_unchanged: verificationFingerprint(root) === fingerprint }), images, isError: result.status !== 'passed' }
      } catch (error) {
        if (openingDebugId) await closeDebugSession(projectId, ctx.sessionId, openingDebugId)
        if (/^GUI_/.test(error instanceof Error ? error.message : String(error))) return guiInputFailure(error)
        return { output: String(error), isError: true }
      }
      finally { if (temporary) rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
    } }
}
