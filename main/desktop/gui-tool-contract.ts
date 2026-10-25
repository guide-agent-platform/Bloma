import type { ToolOutcome } from '../agent/loop/agent-loop'

export const LEGACY_GUI_ACTION_KINDS = ['fill', 'click', 'expect', 'restart', 'lock_data', 'unlock_data', 'storage_full', 'storage_restore', 'corrupt_data', 'remove_data']
export const SOFTWARE_GUI_ACTION_KINDS = ['fill', 'select', 'click', 'expect', 'restart', 'upload', 'native_upload', 'download', 'expect_file', 'press', 'scroll', 'drag']
export const GUI_ACTION_KINDS = [...new Set([...LEGACY_GUI_ACTION_KINDS, ...SOFTWARE_GUI_ACTION_KINDS])]
/** The same public contract drives both tool schemas and on-demand guidance. */
export function guiStepsSchema(maxItems = 96, kinds = GUI_ACTION_KINDS) {
  return { type: 'array', minItems: 1, maxItems, description: '每步需id和kind。fill需selector/value；select选择原生下拉框，需selector及value或label恰好一项；click需selector；expect需selector及equals/contains/nonempty三选一。expect_file使用path及equals/contains/sha256/nonempty之一。restart前后每段均需expect或expect_file；无需持久化检查时不加restart。',
    items: { type: 'object', required: ['id', 'kind'], additionalProperties: false, properties: {
      id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: '唯一操作编号；acceptance_refs引用expect步骤的这个编号。' },
      kind: { type: 'string', enum: kinds, description: '字段名kind；不用action/type/op。' },
      selector: { type: 'string', minLength: 1, maxLength: 512, description: '真实CSS控件选择器，fill/click/expect必填。' },
      ...(kinds.includes('upload') ? { has_text: { type: 'string', minLength: 1, maxLength: 200, description: 'Electron/浏览器按可见内容过滤selector定位的元素。列表选笔记B用selector:".note-item",has_text:"笔记B"，不要依赖新增/编辑后会变的nth-child。它用于定位，不替代expect的equals/contains。' } } : {}),
      value: { type: 'string', maxLength: 4096, description: 'fill输入文本或select精确选项value；断言精确值使用equals。' },
      ...(kinds.includes('select') ? { label: { type: 'string', maxLength: 4096, description: 'select按可见选项文字精确选择，与value二选一。' } } : {}),
      path: { type: 'string', description: 'upload/native_upload引用fixtures.path（input/内）；native_upload仅用于Electron的原生Open对话框。download/expect_file使用隔离outputs/内路径。' },
      key: { type: 'string', minLength: 1, maxLength: 128, description: 'press键组合，如Control+A、Enter。' },
      target_selector: { type: 'string', minLength: 1, maxLength: 512, description: 'drag的目标CSS选择器。' },
      sha256: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'expect_file的精确文件内容摘要。' },
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
