import type { MaterialContext } from '../../../shared/attachment-types'
import type { AgentLoopTool } from '../loop/agent-loop'
import { readMaterial } from '../../platform/attachments/material-context'

export function buildAttachmentTools(context: MaterialContext): AgentLoopTool[] {
  if (!context.attachments.length) return []
  return [
    { name: 'list_attachments', description: '列出当前任务授权的不可变用户材料及哈希、行数；不读取任意磁盘路径。', input_schema: { type: 'object', properties: {} }, execute: async () => ({ output: JSON.stringify(context.attachments) }) },
    { name: 'read_attachment', description: '按行读取授权文本材料。start_line 从 1 起，limit 默认 200，最多 1000；返回实际范围及 next_line，未返回的范围不能声称已读。图片不提供 OCR。', input_schema: { type: 'object', properties: { attachment_id: { type: 'string' }, start_line: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 1000 } }, required: ['attachment_id'] }, execute: async (input, toolContext) => {
      try {
        if (toolContext.projectId !== context.project_id) throw new Error('MATERIAL_DENIED: 材料不属于当前项目')
        return { output: JSON.stringify(readMaterial(context, String(input.attachment_id), toolContext.sessionId, input.start_line === undefined ? 1 : Number(input.start_line), input.limit === undefined ? 200 : Number(input.limit))) }
      }
      catch (error) { return { output: error instanceof Error ? error.message : String(error), isError: true } }
    } },
  ]
}
