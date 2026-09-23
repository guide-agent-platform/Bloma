import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cleanupPastedImages,
  MAX_HYDRATED_IMAGES,
  getPastedImagesDir,
  hydrateMessagesImageBlocks,
  resolvePastedImagePath,
  savePastedImage,
} from '../../main/platform/shell/pasted-images'
import { createProject, deleteProject } from '../../main/project/project-service'
import { recordSessionActivity } from '../../main/platform/sessions/session-service'
import type { ConversationTurn } from '../../main/orchestration/orchestrator'
import type { MessageContentBlock } from '../../shared/types'
import { restorePromaHome } from '../support/proma-home-guard'

/**
 * 剪贴板图片粘贴 P1（clipboard-image-paste，2026-08-29 r67）：存储与水合层。
 *
 * 存储策略（防 JSONL 膨胀）：粘贴图落 {PROMA_HOME}/pasted-images/<sessionId>/<uuid>.<ext>，
 * 会话 JSONL 只落 imageId 短引用——原型 8d 量化：800KB 截图直落 base64 每次 +1064KB。
 * 水合策略（API 边界统一，anthropicMessagesQuery 入口调用）：跨轮按序仅最近
 * MAX_HYDRATED_IMAGES 个 image 块全量水合为 Anthropic base64 source（多轮重复计费防护），
 * 更早的降级 '[图片已省略]' 文本；文件缺失降级 '[图片已丢失]'（不 400 不崩）。
 */

let savedHome: string | undefined

beforeEach(() => {
  savedHome = process.env.PROMA_HOME
  process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'pasted-images-'))
})

afterEach(() => {
  restorePromaHome(savedHome)
})

/** 1x1 红点 PNG（真实字节，非 mock——真实文件回环）。 */
const PNG_1PX_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('pasted-images 存储层', () => {
  it('[S4-AGENT-083] savePastedImage 落文件返回短引用 imageId；JSONL 语义=引用不落 base64', () => {
    const saved = savePastedImage('sess-1', PNG_1PX_BASE64, 'png')
    expect(saved.media_type).toBe('image/png')
    // imageId 含会话段 + 文件名段（嵌套目录，会话删除可整目录清理）
    expect(saved.imageId).toMatch(/^sess-1\/[0-9a-f-]+\.png$/)
    const abs = resolvePastedImagePath(saved.imageId)
    expect(existsSync(abs)).toBe(true)
    expect(readFileSync(abs).toString('base64')).toBe(PNG_1PX_BASE64)
    // 目录结构：{PROMA_HOME}/pasted-images/<sessionId>/
    expect(abs).toContain(join('pasted-images', 'sess-1'))
  })

  it('[S4-AGENT-084] 路径穿越防护：../ 与非法字符 imageId 一律拒绝', () => {
    expect(() => resolvePastedImagePath('../escape.png')).toThrow()
    expect(() => resolvePastedImagePath('sess/../../etc/passwd')).toThrow()
    expect(() => resolvePastedImagePath('sess-1/..%2f..%2fwin.png')).toThrow()
    expect(() => resolvePastedImagePath('')).toThrow()
    // 合法 id 不抛
    expect(() => resolvePastedImagePath('sess-1/0b3ee271-5a7f-4d22-9d6a-1f31fb31d201.png')).not.toThrow()
  })

  it('[S4-AGENT-085] getPastedImagesDir 隔离于 PROMA_HOME 下 pasted-images 目录', () => {
    expect(getPastedImagesDir()).toContain(join('pasted-images'))
    expect(getPastedImagesDir('s1')).toContain(join('pasted-images', 's1'))
  })
})

describe('pasted-images 水合层（API 边界统一）', () => {
  function img(imageId: string, media_type = 'image/png'): MessageContentBlock {
    return { type: 'image', imageId, media_type }
  }

  function userTurn(blocks: MessageContentBlock[]): ConversationTurn {
    return { role: 'user', content: blocks }
  }

  it('[S4-AGENT-086] 水合：image 块按 imageId 读文件转 Anthropic base64 source；string 轮与 text 块原样透传', () => {
    const saved = savePastedImage('sess-2', PNG_1PX_BASE64, 'png')
    const turns: ConversationTurn[] = [
      { role: 'system', content: '系统提示词' },
      { role: 'user', content: '纯文本轮不动' },
      userTurn([{ type: 'text', text: '看这张图' }, img(saved.imageId, 'image/png')]),
    ]
    const out = hydrateMessagesImageBlocks(turns)
    // 输入不突变
    expect((turns[2].content as MessageContentBlock[])[1]).toEqual(img(saved.imageId, 'image/png'))
    const blocks = out[2].content as MessageContentBlock[]
    expect(blocks[0]).toEqual({ type: 'text', text: '看这张图' })
    expect(blocks[1].type).toBe('image')
    expect(blocks[1].source).toEqual({ type: 'base64', media_type: 'image/png', data: PNG_1PX_BASE64 })
  })

  it('[S4-AGENT-087] 省费限制：仅最近 MAX_HYDRATED_IMAGES(=4) 个全量水合，更早的降级 [图片已省略]', () => {
    expect(MAX_HYDRATED_IMAGES).toBe(4)
    // 每轮 1 图 × 6 轮：水合产物为 Anthropic 严格形态（不携带 imageId 顶层字段），
    // 故按轮断言——前 2 轮降级占位、后 4 轮含水合 source
    const turns: ConversationTurn[] = Array.from({ length: 6 }, () =>
      userTurn([img(savePastedImage('sess-3', PNG_1PX_BASE64, 'png').imageId)]),
    )
    const out = hydrateMessagesImageBlocks(turns)
    expect((out[0].content as MessageContentBlock[])[0].text).toBe('[图片已省略]')
    expect((out[1].content as MessageContentBlock[])[0].text).toBe('[图片已省略]')
    for (const i of [2, 3, 4, 5]) {
      const block = (out[i].content as MessageContentBlock[])[0]
      expect(block.source?.data).toBe(PNG_1PX_BASE64)
      expect(block.imageId).toBeUndefined() // API 严格形态：不携带引用字段（防 extra field 400）
    }
  })

  it('[S4-AGENT-088] 故障注入：文件缺失/读取失败 → 降级 [图片已丢失] 文本块，不抛错不 400', () => {
    const turns = [userTurn([{ type: 'text', text: '图' }, img('sess-x/ghost-404.png', 'image/png')])]
    const out = hydrateMessagesImageBlocks(turns)
    const blocks = out[0].content as MessageContentBlock[]
    expect(blocks[1].type).toBe('text')
    expect(blocks[1].text).toBe('[图片已丢失]')
  })

  it('[S4-AGENT-089] 故障注入：水合全程不因单个坏块中断——好图正常水合 + 坏图降级共存', () => {
    const good = savePastedImage('sess-4', PNG_1PX_BASE64, 'png').imageId
    const turns = [userTurn([img('sess-x/bad.png'), img(good)])]
    const out = hydrateMessagesImageBlocks(turns)
    const blocks = out[0].content as MessageContentBlock[]
    expect(blocks[0].text).toBe('[图片已丢失]')
    expect(blocks[1].source?.data).toBe(PNG_1PX_BASE64)
  })
})

describe('会话删除清理钩子（clipboard-paste P2 挂账，r73）', () => {
  it('[S4-AGENT-096] cleanupPastedImages 递归删除该会话粘贴图目录；其他会话不受影响（不误删契约）', () => {
    const s1 = savePastedImage('sess-del', PNG_1PX_BASE64, 'png')
    savePastedImage('sess-del', PNG_1PX_BASE64, 'png') // 同会话第二张
    const keep = savePastedImage('sess-keep', PNG_1PX_BASE64, 'png')
    expect(existsSync(resolvePastedImagePath(s1.imageId))).toBe(true)

    expect(cleanupPastedImages('sess-del')).toBe(true)

    // 该会话目录整体消失（含全部粘贴图）
    expect(existsSync(getPastedImagesDir('sess-del'))).toBe(false)
    // 其他会话不误删
    expect(existsSync(resolvePastedImagePath(keep.imageId))).toBe(true)
    // 幂等：再删一次返回 false（目录已不存在），不抛错
    expect(cleanupPastedImages('sess-del')).toBe(false)
  })

  it('[S4-AGENT-097] 故障注入：目录不存在/非法 sessionId → 不抛错静默（删除主流程零感知）', () => {
    expect(() => cleanupPastedImages('never-existed')).not.toThrow()
    expect(cleanupPastedImages('never-existed')).toBe(false)
    expect(() => cleanupPastedImages('')).not.toThrow()
  })
})

describe('项目删除清理集成（R1 deepseek P1 挂点修复，r73）', () => {
  it('[S4-AGENT-098] deleteProject → 该项目全部会话的粘贴图目录同步回收', () => {
    const project = createProject({ request_id: 'req-pm', mode: 'quick', initial_message: '粘贴图清理' })
    const sessionId = 'sess-of-deleted-project'
    recordSessionActivity(sessionId, project.project_id)
    savePastedImage(sessionId, PNG_1PX_BASE64, 'png')
    savePastedImage('sess-other-project', PNG_1PX_BASE64, 'png')

    deleteProject({ request_id: 'req-del', project_id: project.project_id })

    // 项目删除 → 其会话粘贴图目录被回收；其他会话不受影响
    expect(existsSync(getPastedImagesDir(sessionId))).toBe(false)
    expect(existsSync(getPastedImagesDir('sess-other-project'))).toBe(true)
  })
})
