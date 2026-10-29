import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import { findProject } from '../project/project-service'
import { requireLaunchDeclaration } from '../desktop/launch-smoke'
import { parseGuiSuite, type GuiAcceptanceSuite } from '../desktop/gui-acceptance'
import { observeSoftwareGui } from './gui-observer'
import { softwareVerificationFingerprint as verificationFingerprint } from '../desktop/verification-fingerprint'
import { savePastedImage, MAX_PASTED_IMAGE_BYTES } from '../platform/shell/pasted-images'
import type { createSoftwareCollaborationPolicy } from './collaboration-policy'
import { guiInputFailure, guiStepsSchema, SOFTWARE_GUI_ACTION_KINDS } from '../desktop/gui-tool-contract'
import { actDebugSession, closeDebugSession, closeDebugSessions, openDebugSession, readDebugSession, installDebugFixtures, activeDebugSessionId, assertDebugSessionProcess, retainedDebugFixtures } from './debug-sessions'
import { activeSoftwarePreview, stopSoftwareSession, ownedSoftwarePreview } from './process-manager'
import { restoreSourceFiles, sourceCheckpointChanges } from './source-checkpoints'
import { GUI_FIXTURE_SCHEMA, materializeGuiFixtures, sealGuiFixtures } from '../desktop/gui-fixtures'
import { guiVerificationReadiness } from './verification-readiness'

export function buildSoftwareInspectTool(projectId: string, policy: ReturnType<typeof createSoftwareCollaborationPolicy>, previewChanged?: (url?: string) => void): AgentLoopTool {
  return { name: 'inspect_app', description: '实际操作Electron/浏览器程序。script填写项目内JS模块路径，export default async({page,context,expect,assert,dataDir})使用标准Playwright；脚本在不注入平台密钥的独立工程进程执行，支持交互、等待、上传下载及断言。steps兼容旧动作，与script二选一。默认复用实例并自动重载变化；read显示源码检查点、current_source与差异；restore用checkpoint_id/expected_source/paths还原所选文件并备份旧内容。mode=once仅旧steps单次现场。调试和恢复均不等于验收，通过规则后verify_app。',
    input_schema: { type: 'object', properties: { mode: { type: 'string', enum: ['once', 'open', 'act', 'read', 'reload', 'close', 'restore'] },
      debug_session_id: { type: 'string' }, process_id: { type: 'string' }, since_seq: { type: 'integer', minimum: 0 },
      script: { type: 'string', minLength: 1, maxLength: 512 }, timeout_ms: { type: 'integer', minimum: 100, maximum: 300000 },
      phase:{type:'string',enum:['initial','reopened'],description:'node:test开发检查可区分初次与重开；正式verify_app自动管理两次执行。'},
      checkpoint_id: { type: 'string' }, expected_source: { type: 'string' }, paths: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } },
      include_image: { type: 'boolean' }, fixtures: GUI_FIXTURE_SCHEMA, steps: guiStepsSchema(32, SOFTWARE_GUI_ACTION_KINDS) } },
    execute: async (input, ctx) => {
      let temporary: string | undefined
      let openingDebugId: string | undefined
      try {
        policy.assertCommand(ctx)
        if (input.mode === 'restore') {
          if (input.script !== undefined || input.steps !== undefined || typeof input.checkpoint_id !== 'string' || typeof input.expected_source !== 'string' || !Array.isArray(input.paths)) throw Error('SOURCE_RESTORE_ARGUMENTS_REQUIRED: 提供checkpoint_id、read返回的current_source和要恢复的paths')
          for (const path of input.paths) { if (typeof path !== 'string') throw Error('SOURCE_RESTORE_PATH_INVALID'); policy.assertFileWrite(path, ctx) }
          const before = sourceCheckpointChanges(projectId, ctx.sessionId, findProject(projectId).root_path, input.checkpoint_id)
          if (before.current_source !== input.expected_source) throw Error('SOURCE_RESTORE_CURRENT_CHANGED')
          await closeDebugSessions(projectId, ctx.sessionId); await stopSoftwareSession(projectId, ctx.sessionId)
          ctx.signal.throwIfAborted()
          const result = restoreSourceFiles(projectId, ctx.sessionId, findProject(projectId).root_path, input.checkpoint_id, input.expected_source, input.paths as string[])
          previewChanged?.(undefined)
          return { output: JSON.stringify(result), feedback: { schema_version: 1, execution: 'completed', verification: 'not_applicable', source: 'host', scope: 'source_restore' } }
        }
        if (input.script !== undefined && (typeof input.script !== 'string' || !input.script || input.steps !== undefined || ['once', 'read', 'close'].includes(String(input.mode)))) throw Error('BROWSER_SCRIPT_INPUT_INVALID: script需项目内JS模块路径，与steps二选一；不能用于once/read/close')
        let mode = input.mode
        const explicitDebugSession = Boolean(input.debug_session_id)
        if (mode === undefined || ['open', 'act', 'reload'].includes(String(mode))) {
          const existing = input.debug_session_id as string | undefined ?? activeDebugSessionId(projectId, ctx.sessionId)
          if (existing) {
            const snapshot = readDebugSession(projectId, ctx.sessionId, existing)
            if (!['opening', 'ready'].includes(snapshot.state)) { input = { ...input, debug_session_id: undefined }; mode = 'open' }
            else {
              let switched = false
              if (!explicitDebugSession && input.process_id) {
                try { assertDebugSessionProcess(projectId, ctx.sessionId, existing, String(input.process_id)) }
                catch (mismatch) {
                  // An explicit process_id is a request to inspect that owned
                  // service. Validate it before closing the old debug window;
                  // never adopt foreign/stale PIDs or stop borrowed backends.
                  const root = findProject(projectId).root_path
                  try {
                    const launch = requireLaunchDeclaration(root, 'DEBUG_LAUNCH_REQUIRED')
                    const target = ownedSoftwarePreview(projectId, ctx.sessionId, String(input.process_id))
                    if (launch.ui !== 'browser' || target.root !== resolve(root) || !target.data_dir || target.source !== verificationFingerprint(root)) throw mismatch
                  } catch { throw mismatch }
                  await closeDebugSession(projectId, ctx.sessionId, existing)
                  input = { ...input, debug_session_id: undefined }; mode = 'open'; switched = true
                }
              }
              if (!switched) {
                input = { ...input, debug_session_id: existing }
                if (mode === undefined || mode === 'open' || mode === 'act') mode = snapshot.stale ? 'reload' : 'act'
              }
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
            const root = findProject(projectId).root_path, launch = requireLaunchDeclaration(root, 'DEBUG_LAUNCH_REQUIRED')
            snapshot = await openDebugSession({ projectId, sessionId: ctx.sessionId, root, launch, signal: ctx.signal, processId: input.process_id as string | undefined })
            openingDebugId = snapshot.id
            if (additions) installDebugFixtures(projectId, ctx.sessionId, snapshot.id, additions)
            snapshot = await actDebugSession({ ...args, id: snapshot.id, script: input.script as string | undefined, timeoutMs: input.timeout_ms as number | undefined,
              phase:input.phase as 'initial'|'reopened'|undefined,
              steps: input.script ? undefined : steps ?? [{ id: 'screen', kind: 'expect', selector: 'body', nonempty: true }] })
          } else if (mode === 'close') snapshot = await closeDebugSession(projectId, ctx.sessionId, args.id)
          else if (mode === 'read') snapshot = readDebugSession(projectId, ctx.sessionId, args.id, Number(input.since_seq ?? 0))
          else { if (additions) installDebugFixtures(projectId, ctx.sessionId, args.id, additions); snapshot = await actDebugSession({ ...args, steps, script: input.script as string | undefined, phase:input.phase as 'initial'|'reopened'|undefined, timeoutMs: input.timeout_ms as number | undefined, reload: mode === 'reload' }) }
          if (mode === 'act' || mode === 'reload') snapshot = readDebugSession(projectId, ctx.sessionId, args.id, Number(cursor))
          if (mode === 'open' && snapshot.url) previewChanged?.(snapshot.url)
          if (mode === 'close') previewChanged?.(activeSoftwarePreview(projectId, ctx.sessionId))
          const imageBytes = input.include_image === true && snapshot.screenshot ? readFileSync(snapshot.screenshot) : undefined
          const images = imageBytes && imageBytes.length <= MAX_PASTED_IMAGE_BYTES ? [savePastedImage(ctx.sessionId, imageBytes.toString('base64'), 'png')] : undefined
          const failed = snapshot.steps.find(step => !step.passed)
          const root = findProject(projectId).root_path
          let changes: unknown
          if (mode === 'read' && snapshot.source_checkpoint) {
            try { changes = sourceCheckpointChanges(projectId, ctx.sessionId, root, snapshot.source_checkpoint.id) }
            catch (error) { changes = { error: String(error) } }
          }
          return { output: JSON.stringify({ debug_session_id: snapshot.id, state: snapshot.state, stale: snapshot.stale, error: snapshot.error, failed_step: failed,
            observed_source: snapshot.source, current_source: verificationFingerprint(root), source_checkpoint: snapshot.source_checkpoint, checkpoint_error: snapshot.checkpoint_error, source_changes: changes,
            verification_readiness: guiVerificationReadiness(projectId),
            version: snapshot.version, resumed_from: snapshot.resumed_from, ui: snapshot.ui, steps: snapshot.steps, observations: snapshot.observations, log_cursor: snapshot.log_cursor,
            observations_omitted: snapshot.observations_omitted, data_dir: snapshot.data_dir, url: snapshot.url, screenshot: snapshot.screenshot,
            screenshot_error: snapshot.screenshot_error, visual_review: images ? 'image_attached_not_reviewed' : 'not_reviewed_by_model', evidence: '持续开发观察，非最终验收凭据' }), images,
            isError: snapshot.state === 'failed' || Boolean(snapshot.error) || snapshot.stale || snapshot.steps.some(step => !step.passed)
              || snapshot.observations.some(row => row.version === snapshot.version && /^renderer\.(?:error|startup_error)$/.test(row.kind)) }
        }
        const root = findProject(projectId).root_path, launch = requireLaunchDeclaration(root, 'DEBUG_LAUNCH_REQUIRED')
        if (!['electron', 'browser'].includes(launch.ui ?? '')) throw Error('INSPECT_RUNTIME_UNSUPPORTED: 请登记实际Electron/浏览器入口；其它入口由对应宿主观察器检查')
        const fingerprint = verificationFingerprint(root)
        if (!fingerprint) throw Error('INSPECT_SOURCE_UNREADABLE')
        const suite = sealGuiFixtures(projectId, root, parseGuiSuite({ version: 1, scope_hash: fingerprint, covers: ['F-001'], fixtures: input.fixtures, steps: input.steps ?? [{ id: 'screen', kind: 'expect', selector: 'body', nonempty: true }] }, { allowActionsOnly: true }))
        temporary = mkdtempSync(join(tmpdir(), 'bloma-inspect-'))
        materializeGuiFixtures(projectId, suite, join(temporary, 'data'))
        const screenshotDir = join(root, '00_VERIFY/screenshots', `inspect-${randomUUID()}`)
        mkdirSync(screenshotDir, { recursive: true })
        const result = await observeSoftwareGui({ projectId, root, launch, suite, temporary, signal: ctx.signal, screenshotDir })
        const files = readdirSync(screenshotDir).filter(file => file.endsWith('.png')).sort()
        const name = files.find(file => file.endsWith('-failed.png')) ?? files.at(-1), file = name ? join(screenshotDir, name) : undefined
        const bytes = result.status !== 'unverified' && file ? readFileSync(file) : undefined
        const images = input.include_image === true && bytes && bytes.length <= MAX_PASTED_IMAGE_BYTES ? [savePastedImage(ctx.sessionId, bytes.toString('base64'), 'png')] : undefined
        return { output: JSON.stringify({ ...result, screenshot: file, visual_review: images ? 'image_attached_not_reviewed' : 'not_reviewed_by_model', evidence: '开发观察，不是最终验收凭据', verification_readiness: guiVerificationReadiness(projectId), source_unchanged: verificationFingerprint(root) === fingerprint }), images, isError: result.status !== 'passed' }
      } catch (error) {
        if (openingDebugId) await closeDebugSession(projectId, ctx.sessionId, openingDebugId)
        if (/^GUI_/.test(error instanceof Error ? error.message : String(error))) return guiInputFailure(error)
        return { output: String(error), isError: true }
      }
      finally { if (temporary) rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
    } }
}
