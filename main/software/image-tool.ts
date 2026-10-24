import { readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { findProject } from '../project/project-service'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import { MAX_PASTED_IMAGE_BYTES, savePastedImage } from '../platform/shell/pasted-images'

export function buildSoftwareImageTool(projectId: string): AgentLoopTool {
  return { name: 'view_image', description: '查看项目内实际截图或图片（png/jpeg/webp，最大5MB）。把图片送给支持视觉的当前模型；日志只保留短引用，不写base64。不支持视觉的渠道不能据此声称看过界面。',
    input_schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    execute: async (input, ctx) => {
      try {
        ctx.signal.throwIfAborted()
        if (ctx.projectId !== projectId || !/^[A-Za-z0-9_-]+$/.test(ctx.sessionId)) throw Error('IMAGE_OWNER_INVALID')
        const root = realpathSync(findProject(projectId).root_path), file = realpathSync(resolve(root, String(input.path))), rel = relative(root, file)
        if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw Error('IMAGE_OUTSIDE_PROJECT')
        const ext = extname(file).slice(1).toLowerCase()
        if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext) || statSync(file).size > MAX_PASTED_IMAGE_BYTES) throw Error('IMAGE_FORMAT_OR_SIZE_INVALID')
        const image = savePastedImage(ctx.sessionId, readFileSync(file).toString('base64'), ext)
        return { output: `实际图片：${rel}。请根据可见内容评估，不把图片存在当作功能通过。`, images: [image] }
      } catch (error) { return { output: String(error), isError: true } }
    } }
}
