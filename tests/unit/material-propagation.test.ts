import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { importAttachment } from '../../main/platform/attachments/composer-store'
import { acceptMessage, updateReceipt } from '../../main/platform/attachments/send-inbox'
import { sessionMaterials } from '../../main/platform/attachments/material-context'

import { appendSessionMessage } from '../../main/platform/sessions/session-tree'
import { createProject } from '../../main/project/project-service'
import { startDelegation, registerParentLoopContext, waitForDelegations, disposeParentDelegationState } from '../../main/agent/delegation/agent-collaboration'
import { createToolState } from '../../main/agent/loop/agent-loop'
import { setChildRunContextProvider } from '../../main/agent/delegation/child-run-context'
import { getProjectRootOverride } from '../../shared/project-root-override'
import type { SDKQuery, SDKQueryOptions } from '../../main/orchestration/orchestrator'
import type { ToolContext } from '../../main/agent/loop/agent-loop'

beforeEach(() => vi.stubEnv('PROMA_HOME', mkdtempSync(join(tmpdir(), 'bloma-material-propagation-'))))
afterEach(() => { disposeParentDelegationState('parent'); setChildRunContextProvider(() => undefined); vi.unstubAllEnvs() })
function prepare() {
  const project = createProject({ request_id: 'r', mode: 'quick' })
  const scope = { project_id: project.project_id, session_id: 'parent', draft_id: 'draft-parent' }
  const info = importAttachment({ request_id: 'r', ...scope, name: '需求.md', media_type: 'text/plain', base64: Buffer.from('功能：按账户汇总金额\n独有字段：settlement_currency\n限制：导出必须保留币种').toString('base64') })
  const sample = importAttachment({ request_id: 'r', ...scope, name: 'sample.csv', media_type: 'text/csv', base64: Buffer.from('account,amount,settlement_currency\n餐费,12.50,CNY').toString('base64') })
  acceptMessage({ request_id: 'r', ...scope, client_message_id: 'client', content: '按材料做需求', attachment_refs: [info, sample], mode: 'quick', current_stage: 'clarifying' }, false)
  updateReceipt('client', 'running')
  appendSessionMessage('parent', { role: 'user', content: [{ type: 'text', text: '请按材料做需求' }], timestamp: Date.now() })
  return { scope, info, sample, context: sessionMaterials(project.project_id, 'parent') }
}
describe('material propagation through PRD and real delegated loop', () => {

  it('the actual child loop receives a scoped reading tool and returns the same id/hash/content', async () => {
    const { scope, sample, context } = prepare()
    const isolatedRoot = mkdtempSync(join(tmpdir(), 'bloma-material-worktree-'))
    setChildRunContextProvider(() => ({ rootOverride: isolatedRoot }))
    let calls = 0, sawTools = false, sawData = false, sawOverride = false
    const query: SDKQuery = async function* (_prompt, options: SDKQueryOptions) {
      sawTools ||= Boolean(options.tools?.some(tool => tool.name === 'read_attachment'))
      sawOverride ||= getProjectRootOverride() === isolatedRoot
      if (calls++ === 0) {
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'read-sample', name: 'read_attachment', input: { attachment_id: sample.attachment_id, start_line: 2, limit: 1 } }] } }
        yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' }
      } else {
        const serialized = JSON.stringify(options.messages)
        sawData = serialized.includes('餐费,12.50,CNY') && serialized.includes(sample.sha256)
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '读取完成，保留币种。' }] } }
        yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
      }
    }
    registerParentLoopContext('parent', { materials: context, query, env: {}, maxTokens: 4096, maxTurns: 5, delegationMaxTurns: 5, permissionMode: 'allow-all', temperature: 0, system: '仅检查材料', editFormat: 'diff', publish: () => {}, childToolsBuilder: () => [] })
    const parent: ToolContext = { projectId: scope.project_id, sessionId: 'parent', requestId: 'r', signal: new AbortController().signal, state: createToolState(0) }
    const child = startDelegation(parent, { task: '读取样例第二行确认币种', role: 'research' })
    const result = await waitForDelegations(parent, { strategy: 'all', timeout_ms: 5000 })
    expect(result[0].status).toBe('completed')
    expect(child.child_session_id).not.toBe('parent'); expect(sawTools).toBe(true); expect(sawData).toBe(true); expect(sawOverride).toBe(true)
  })
})
