import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importAttachment, readAttachmentPage, resolveAttachments, composerPath } from '../../main/platform/attachments/composer-store'
import { acceptMessage, updateReceipt } from '../../main/platform/attachments/send-inbox'
import { sessionMaterials, renderMaterialContext, readMaterial, validateMaterialSources, providedPages } from '../../main/platform/attachments/material-context'
import { buildAttachmentTools } from '../../main/agent/tools/attachment-tools'
import type { AttachmentInfo } from '../../shared/attachment-types'

const scope = { project_id: 'p', session_id: 'parent', draft_id: 'draft-parent' }
const text = (name: string, value: string) => importAttachment({ request_id: 'r', ...scope, name, media_type: 'text/plain', base64: Buffer.from(value).toString('base64') })
function authorize(infos: AttachmentInfo[], status: 'running' | 'queued' = 'running') {
  const id = 'client-' + Math.random().toString(36).slice(2)
  acceptMessage({ request_id: 'r', ...scope, client_message_id: id, attachment_refs: infos, content: 'use these files', mode: 'quick', current_stage: 'clarifying' }, true)
  updateReceipt(id, status)
  return sessionMaterials('p', 'parent')
}
beforeEach(() => vi.stubEnv('PROMA_HOME', mkdtempSync(join(tmpdir(), 'bloma-text-attachments-'))))
afterEach(() => vi.unstubAllEnvs())
describe('UTF-8 material snapshots and controlled reading', () => {
  it('imports Markdown/CSV/JSON/code including empty UTF-8 files and never executes HTML', () => {
    for (const name of ['需求.md', 'sample.csv', 'data.json', 'logic.py', 'empty.txt', 'reference.html']) {
      const value = name === 'empty.txt' ? '' : '<script>throw new Error("do not execute")</script>\n数据字段 currency'
      const info = text(name, value)
      expect(info.kind).toBe('text'); expect(info.encoding).toBe('utf-8')
      expect(readAttachmentPage(info).text).toBe(value)
      expect(resolveAttachments(scope, [info])[0].image).toBeUndefined()
    }
  })
  it('rejects unsupported formats, non-UTF-8, binary data, oversize and traversals', () => {
    expect(() => text('document.pdf', '%PDF')).toThrow('ATTACHMENT_TYPE')
    expect(() => importAttachment({ request_id: 'r', ...scope, name: 'legacy.txt', media_type: 'text/plain', base64: Buffer.from([0xff, 0xfe, 0x80]).toString('base64') })).toThrow('ATTACHMENT_ENCODING')
    expect(() => text('binary.txt', '\u0000hello')).toThrow('ATTACHMENT_BINARY')
    expect(() => text('big.txt', 'x'.repeat(1024 * 1024 + 1))).toThrow('ATTACHMENT_DATA')
    expect(() => resolveAttachments(scope, [{ attachment_id: '../escape' }])).toThrow('COMPOSER_BAD_ID')
  })
  it('permits 8 files but no more than 4 images; hash validation catches altered snapshots', () => {
    const infos = Array.from({ length: 9 }, (_, i) => text(`file-${i}.md`, 'unchanged'))
    expect(resolveAttachments(scope, infos.slice(0, 8))).toHaveLength(8)
    expect(() => resolveAttachments(scope, infos)).toThrow('ATTACHMENT_LIMIT')
    writeFileSync(composerPath('texts', infos[0].attachment_id), 'mutated')
    expect(() => resolveAttachments(scope, [infos[0]])).toThrow('ATTACHMENT_CHANGED')
  })
  it('pages by exact line ranges and exposes next_line; single long lines have explicit budget errors', () => {
    const info = text('lines.txt', Array.from({ length: 301 }, (_, i) => `line-${i + 1}`).join('\n'))
    const page = readAttachmentPage(info, 250, 30)
    expect(page.text).toContain('line-279'); expect(page.text).not.toContain('line-280')
    expect(page.next_line).toBe(280); expect(page.total_lines).toBe(301)
    expect(() => readAttachmentPage(info, 0)).toThrow('ATTACHMENT_RANGE')
    expect(() => readAttachmentPage(text('one.json', 'x'.repeat(12001)))).toThrow('ATTACHMENT_LINE_TOO_LONG')
  })
  it('queued materials never enter active context; short files are fully supplied', () => {
    const info = text('requirements.md', '必须离线\n金额精确到两位小数')
    expect(authorize([info], 'queued').attachments).toHaveLength(0)
    const context = authorize([info])
    const prompt = renderMaterialContext(context, 'parent')
    expect(prompt).toContain('金额精确到两位小数')
    expect(providedPages(context)[0]).toMatchObject({ start_line: 1, end_line: 2, truncated: false })
  })
  it('long-file context includes the final constraints and records honest unread ranges', () => {
    const info = text('tail.md', Array.from({ length: 1200 }, (_, i) => i === 1199 ? '最终限制：导出必须保留币种' : `说明 ${i + 1} ${'x'.repeat(60)}`).join('\n'))
    const context = authorize([info])
    const prompt = renderMaterialContext(context, 'parent')
    expect(prompt).toContain('最终限制：导出必须保留币种')
    expect(prompt).toContain('其余行未提供')
    expect(prompt).not.toContain('说明 600 ')
    expect(validateMaterialSources([{ attachment_id: info.attachment_id, sha256: info.sha256, start_line: 600, end_line: 601 }], context)).toEqual([])
    readMaterial(context, info.attachment_id, 'child', 600, 2)
    expect(validateMaterialSources([{ attachment_id: info.attachment_id, sha256: info.sha256, start_line: 600, end_line: 601 }], context)).toHaveLength(1)
  })
  it('child tools retain identical ids/hash and ignore worktree paths; unknown/crossed materials are denied', async () => {
    const info = text('data.csv', 'date,amount,currency\n2026-10-09,12.50,CNY')
    const context = authorize([info])
    const tools = buildAttachmentTools(context)
    const toolContext = { sessionId: 'child-in-worktree', projectId: 'p', requestId: 'r', state: {}, signal: new AbortController().signal } as unknown as import('../../main/agent/loop/agent-loop').ToolContext
    const list = await tools[0].execute({}, toolContext)
    expect(JSON.parse(list.output)[0].sha256).toBe(info.sha256)
    const page = await tools[1].execute({ attachment_id: info.attachment_id, start_line: 2, limit: 1 }, toolContext)
    expect(JSON.parse(page.output)).toMatchObject({ attachment_id: info.attachment_id, sha256: info.sha256, text: '2026-10-09,12.50,CNY' })
    expect((await tools[1].execute({ attachment_id: 'C:\\secrets.txt' }, toolContext)).isError).toBe(true)
    expect((await tools[1].execute({ attachment_id: info.attachment_id }, { ...toolContext, projectId: 'other' } as never)).isError).toBe(true)
  })
})
