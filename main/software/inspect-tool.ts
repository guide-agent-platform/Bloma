import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import { findProject } from '../project/project-service'
import { readLaunchDeclaration } from '../desktop/launch-smoke'
import { parseGuiSuite } from '../desktop/gui-acceptance'
import { observeSoftwareGui } from './gui-observer'
import { verificationFingerprint } from '../desktop/verification-fingerprint'
import { savePastedImage, MAX_PASTED_IMAGE_BYTES } from '../platform/shell/pasted-images'
import type { createSoftwareCollaborationPolicy } from './collaboration-policy'

export function buildSoftwareInspectTool(projectId: string, policy: ReturnType<typeof createSoftwareCollaborationPolicy>): AgentLoopTool {
  return { name: 'inspect_app', description: '运行LAUNCH.json实际Electron/浏览器入口，用隔离数据操作界面。默认返回DOM观察和截图位置，适用于纯文本渠道；仅已知当前渠道支持图像时设include_image=true把截图送给模型。steps可选fill/click/expect/restart，默认查看body；结束关闭检查进程。浏览器须先stop_process释放相同端口。这是开发观察，不改变最终验收输入；Python界面仍用register_gui_check宿主观察。',
    input_schema: { type: 'object', properties: { include_image: { type: 'boolean' }, steps: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: true } } } },
    execute: async (input, ctx) => {
      let temporary: string | undefined
      try {
        policy.assertCommand(ctx)
        const root = findProject(projectId).root_path, launch = readLaunchDeclaration(root)
        if (!launch?.ok || !['electron', 'browser'].includes(launch.launch.ui ?? '')) throw Error('INSPECT_RUNTIME_UNSUPPORTED: 请登记实际Electron/浏览器入口；其它入口由对应宿主观察器检查')
        const fingerprint = verificationFingerprint(root)
        if (!fingerprint) throw Error('INSPECT_SOURCE_UNREADABLE')
        const suite = parseGuiSuite({ version: 1, scope_hash: fingerprint, covers: ['F-001'], steps: input.steps ?? [{ id: 'screen', kind: 'expect', selector: 'body', nonempty: true }] })
        temporary = mkdtempSync(join(tmpdir(), 'bloma-inspect-'))
        const screenshotDir = join(root, '00_VERIFY/screenshots', `inspect-${randomUUID()}`)
        mkdirSync(screenshotDir, { recursive: true })
        const result = await observeSoftwareGui({ projectId, root, launch: launch.launch, suite, temporary, signal: ctx.signal, screenshotDir })
        const files = readdirSync(screenshotDir).filter(file => file.endsWith('.png')).sort()
        const name = files.find(file => file.endsWith('-failed.png')) ?? files.at(-1), file = name ? join(screenshotDir, name) : undefined
        const bytes = result.status !== 'unverified' && file ? readFileSync(file) : undefined
        const images = input.include_image === true && bytes && bytes.length <= MAX_PASTED_IMAGE_BYTES ? [savePastedImage(ctx.sessionId, bytes.toString('base64'), 'png')] : undefined
        return { output: JSON.stringify({ ...result, screenshot: file, visual_review: images ? 'image_attached_for_current_channel' : 'not_reviewed_by_model', evidence: '开发观察，不是最终验收凭据', source_unchanged: verificationFingerprint(root) === fingerprint }), images, isError: result.status !== 'passed' }
      } catch (error) { return { output: String(error), isError: true } }
      finally { if (temporary) rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
    } }
}
