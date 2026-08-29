// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  extractPastedImages,
  MAX_PASTED_IMAGE_BYTES,
  PASTE_ALLOWED_MIME,
  toBase64DataUrl,
} from '../../renderer/lib/paste-extract'

/**
 * 剪贴板图片粘贴 P1（clipboard-image-paste，2026-08-29 r67）：粘贴提取纯逻辑。
 * 提取自原型模块 1（12/12 中 7 断言直译 vitest）：白名单/大小限制/混合场景/零干扰语义。
 * 「零干扰」：无图粘贴返回空数组且不标记 shouldPrevent——文本粘贴行为与现状完全一致。
 *
 * jsdom 无 DataTransfer/DataTransferItemList 构造器：用满足消费接口的最小 fake
 * （可迭代 + kind + getAsFile），与 extractPastedImages 的真实消费面一致。
 */

const PNG_1PX_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function makeFile(bytes: Uint8Array, mime: string): File {
  return new File([bytes as BlobPart], 'pasted', { type: mime })
}

function pngBytes(): Uint8Array {
  return Uint8Array.from(atob(PNG_1PX_BASE64), (c) => c.charCodeAt(0))
}

interface FakeItem {
  kind: 'file' | 'string'
  type: string
  getAsFile: () => File | null
}

function makeItems(entries: Array<{ kind?: 'file' | 'string'; file?: File; type?: string }>): DataTransferItemList {
  const items: FakeItem[] = entries.map((e) => ({
    kind: e.kind ?? (e.file ? 'file' : 'string'),
    type: e.type ?? e.file?.type ?? 'text/plain',
    getAsFile: () => e.file ?? null,
  }))
  return Object.assign(items, { [Symbol.iterator]: items[Symbol.iterator].bind(items) }) as unknown as DataTransferItemList
}

describe('extractPastedImages 粘贴提取', () => {
  it('[S1-UI-035] 单张 PNG：提取 base64 + media_type + shouldPrevent=true（拦截默认粘贴行为）', async () => {
    const result = await extractPastedImages(makeItems([{ file: makeFile(pngBytes(), 'image/png') }]))
    expect(result.images).toHaveLength(1)
    expect(result.images[0].media_type).toBe('image/png')
    expect(result.images[0].base64).toBe(PNG_1PX_BASE64)
    expect(result.shouldPrevent).toBe(true)
  })

  it('[S1-UI-036] 纯文本粘贴零干扰：无图返回空、shouldPrevent=false（文本路径行为不变）', async () => {
    const result = await extractPastedImages(makeItems([{ kind: 'string', type: 'text/plain' }]))
    expect(result.images).toEqual([])
    expect(result.shouldPrevent).toBe(false)
    expect(result.rejected).toEqual([])
  })

  it('[S1-UI-037] 非白名单类型（如 exe/zip 伪装）：拒绝并留痕 reason', async () => {
    const result = await extractPastedImages(makeItems([{ file: makeFile(new Uint8Array([0x25, 0x50]), 'application/x-zip-compressed') }]))
    expect(result.images).toEqual([])
    expect(result.shouldPrevent).toBe(true) // 有粘贴意图被处理（拒绝也是处理）——防拖入文件静默当文本
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].reason).toContain('不支持')
  })

  it('[S1-UI-038] 超 5MB 拒绝：reason 含实际大小 MB（边界 MAX_PASTED_IMAGE_BYTES）', async () => {
    expect(MAX_PASTED_IMAGE_BYTES).toBe(5 * 1024 * 1024)
    const big = new Uint8Array(MAX_PASTED_IMAGE_BYTES + 1)
    big[0] = 0x89
    const result = await extractPastedImages(makeItems([{ file: makeFile(big, 'image/png') }]))
    expect(result.images).toEqual([])
    expect(result.rejected[0].reason).toMatch(/5\.0\s*MB|超过/)
  })

  it('[S1-UI-039] 5MB 整边界值放行（差一防护：<= 而非 <）', async () => {
    const exact = new Uint8Array(MAX_PASTED_IMAGE_BYTES)
    exact[0] = 0x89
    const result = await extractPastedImages(makeItems([{ file: makeFile(exact, 'image/png') }]))
    expect(result.images).toHaveLength(1)
  })

  it('[S1-UI-040] 文本+双图混合：按 items 顺序提取全部图片，文本不干扰', async () => {
    const result = await extractPastedImages(
      makeItems([{ kind: 'string' }, { file: makeFile(pngBytes(), 'image/png') }, { file: makeFile(pngBytes(), 'image/png') }]),
    )
    expect(result.images).toHaveLength(2)
    expect(result.shouldPrevent).toBe(true)
  })

  it('[S1-UI-041] 空剪贴板 no-op：无 items 返回空且不 preventDefault', async () => {
    const result = await extractPastedImages(makeItems([]))
    expect(result.images).toEqual([])
    expect(result.shouldPrevent).toBe(false)
  })

  it('[S1-UI-042] 白名单含 P1 四类：PNG/JPEG/GIF/WebP（P2 drag-drop 复用同名单）', () => {
    expect(PASTE_ALLOWED_MIME).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
  })

  it('[S1-UI-096] fuzz：null/undefined items 安全返回空（不抛错）', async () => {
    expect((await extractPastedImages(null)).images).toEqual([])
    expect((await extractPastedImages(undefined)).shouldPrevent).toBe(false)
  })
})

describe('toBase64DataUrl', () => {
  it('[S1-UI-043] base64 + media_type 组装 dataURL（chip 预览用，不落盘）', () => {
    expect(toBase64DataUrl(PNG_1PX_BASE64, 'image/png')).toBe(`data:image/png;base64,${PNG_1PX_BASE64}`)
  })
})
