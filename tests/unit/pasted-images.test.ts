import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_HYDRATED_IMAGES,
  getPastedImagesDir,
  hydrateMessagesImageBlocks,
  resolvePastedImagePath,
  savePastedImage,
} from '../../main/pasted-images'
import type { ConversationTurn } from '../../main/orchestrator'
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
