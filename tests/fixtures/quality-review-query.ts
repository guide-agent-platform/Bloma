import type { SDKQuery } from '../../main/orchestration/stages/orchestration-contracts'

/** Explicit controlled C and A-handoff responses for unrelated regressions.
 * These extra requests still pass through the real shared budget. The wrapped
 * fixture's counter counts its original scripted A actions only, not quality. */
export function withEmptyQualityReview(query: SDKQuery): SDKQuery {
  const seen = new Set<string>()
  return async function* (prompt, options) {
    const isC = JSON.stringify(options.messages?.filter(m => m.role === 'system')).includes('独立只读代码/数据审阅C')
    if (!isC && JSON.stringify(options.messages?.at(-1)?.content).includes('宿主已为稳定候选启动独立C审阅')) {
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '受控审阅交接已收到，等待宿主按台账检查。' }] } }
      yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } }
      return
    }
    if (!isC) { yield* query(prompt, options); return }
    const first = !seen.has(options.sessionId); seen.add(options.sessionId)
    yield { type: 'assistant', message: { role: 'assistant', content: first
      ? [{ type: 'tool_use', id: 'controlled-c-materials', name: 'read_quality_review', input: {} },
        { type: 'tool_use', id: 'controlled-c-source', name: 'read_file', input: { path: 'app.cjs' } },
        { type: 'tool_use', id: 'controlled-c-submit', name: 'submit_quality_findings', input: { findings: [] } }]
      : [{ type: 'text', text: '受控C材料已提交；不声明软件质量。' }] } }
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } }
  }
}
