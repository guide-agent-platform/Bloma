import type { ToolOutcome } from '../agent/loop/agent-loop'

export const GUI_ACTION_KINDS = ['fill', 'click', 'expect', 'restart', 'lock_data', 'unlock_data', 'storage_full', 'storage_restore', 'corrupt_data', 'remove_data']
export const SOFTWARE_GUI_ACTION_KINDS = ['fill', 'click', 'expect', 'restart']
/** The same public contract drives both tool schemas and on-demand guidance. */
export function guiStepsSchema(maxItems = 96, kinds = GUI_ACTION_KINDS) {
  return { type: 'array', minItems: 1, maxItems, description: '每步需id和kind。fill需selector/value；click需selector；expect需selector及equals/contains/nonempty三选一。restart前后每段均需expect；无需持久化检查时不加restart。',
    items: { type: 'object', required: ['id', 'kind'], additionalProperties: false, properties: {
      id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: '唯一操作编号；acceptance_refs引用expect步骤的这个编号。' },
      kind: { type: 'string', enum: kinds, description: '字段名kind；不用action/type/op。' },
      selector: { type: 'string', minLength: 1, maxLength: 512, description: '真实CSS控件选择器，fill/click/expect必填。' },
      value: { type: 'string', maxLength: 4096, description: '仅fill输入文本；断言精确值使用equals。' },
      equals: { type: 'string', maxLength: 4096, description: 'expect精确预期；不用expected/text/expectedText。' },
      contains: { type: 'string', minLength: 1, maxLength: 4096 }, nonempty: { type: 'boolean', enum: [true] },
      property: { type: 'string', enum: ['text', 'value', 'count'], description: 'expect读取text（默认）、表单value或元素count。' },
      timeout_ms: { type: 'integer', minimum: 1, maximum: 10000 },
    } } }
}
export const GUI_CHECK_EXAMPLE = {
  steps: [{ id: 'press', kind: 'click', selector: '#calculate' }, { id: 'answer', kind: 'expect', selector: '#result', equals: '5' }],
  acceptance_refs: { answer: ['F-001'] },
}
export function guiInputFailure(error: unknown, details: Record<string, unknown> = {}): ToolOutcome {
  const message = error instanceof Error ? error.message : String(error)
  const invalidInput = message.startsWith('GUI_')
  return { isError: true, output: JSON.stringify({ error: message, ...details, example: GUI_CHECK_EXAMPLE,
    guidance: '修正工具参数；后续字段未必已校验。kind/id/equals见input_schema，完整协议用read_production_context(topic="verification-gui")。参数拒绝不代表产品业务失败。' }),
    feedback: { schema_version: 1, execution: invalidInput ? 'not_run' : 'failed', verification: 'unverified', source: 'host', category: invalidInput ? 'invalid_input' : 'verification_harness',
      scope: 'gui_tool_contract', reason: message.split(':')[0], recovery: invalidInput ? 'correct_input' : 'repair_verifier' } }
}
