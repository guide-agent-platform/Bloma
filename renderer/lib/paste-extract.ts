// 粘贴提取纯逻辑（clipboard-image-paste P1，2026-08-29 r67）
// 信源：enhancements/clipboard-image-paste-prototype.ts 模块 1（12/12 中 7 断言直译）
// 渲染层约束：不碰 Node/IPC——本模块只做 DataTransfer → base64/拒绝清单的纯转换，
// 存盘经 electronAPI.pastedImage.save（IPC 四层链路），预览用内存 dataURL。

/** P1 白名单：PNG/JPEG/GIF/WebP（P2 drag-drop 复用同名单） */
export const PASTE_ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

/** 单图上限：与主进程 pastedImage.save 兜底校验一致（5MB） */
export const MAX_PASTED_IMAGE_BYTES = 5 * 1024 * 1024

export interface ExtractedPasteImage {
  media_type: string
  /** 无 dataURL 前缀的纯 base64（IPC 存盘载荷） */
  base64: string
  sizeBytes: number
}

export interface RejectedPasteItem {
  type: string
  reason: string
}

export interface ExtractPasteResult {
  images: ExtractedPasteImage[]
  rejected: RejectedPasteItem[]
  /** 有图片被处理（含拒绝）= true；纯文本/空剪贴板 = false（零干扰，不 preventDefault） */
  shouldPrevent: boolean
}

function mimeAllowed(type: string): boolean {
  return (PASTE_ALLOWED_MIME as readonly string[]).includes(type)
}

/**
 * 从 clipboardData.items 提取粘贴图片。
 * - 白名单 mime + ≤5MB → base64（FileReader 语义：File.array() 异步读字节）
 * - 超限拒绝（reason 含实际 MB，用户知情）；非白名单拒绝留痕
 * - 文本项不动；无任何图片意图 → { images: [], shouldPrevent: false }（粘贴文本行为与现状一致）
 */
export async function extractPastedImages(items: DataTransferItemList | null | undefined): Promise<ExtractPasteResult> {
  const images: ExtractedPasteImage[] = []
  const rejected: RejectedPasteItem[] = []
  if (!items) return { images, rejected, shouldPrevent: false }

  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue // 文本等非文件项：零干扰放行
    const file = item.getAsFile()
    if (!file) continue
    if (!mimeAllowed(file.type)) {
      rejected.push({ type: file.type || 'unknown', reason: `不支持的类型 ${file.type || 'unknown'}（仅支持 PNG/JPEG/GIF/WebP）` })
      continue
    }
    // FileReader 语义（蓝本 rich-text-input 同构）：readAsDataURL → 前缀剥离得纯 base64
    const dataUrl = await blobToDataUrl(file)
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    if (file.size > MAX_PASTED_IMAGE_BYTES) {
      const mb = (file.size / (1024 * 1024)).toFixed(1)
      rejected.push({ type: file.type, reason: `图片超过 5MB 上限（实际 ${mb} MB）` })
      continue
    }
    images.push({ media_type: file.type, base64, sizeBytes: file.size })
  }
  return { images, rejected, shouldPrevent: images.length > 0 || rejected.length > 0 }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('PASTE_READ_FAILED'))
    reader.readAsDataURL(blob)
  })
}

/** chip 缩略预览 dataURL（内存态，不落盘不经 IPC） */
export function toBase64DataUrl(base64: string, mediaType: string): string {
  return `data:${mediaType};base64,${base64}`
}

/** ext 名（IPC 存盘用）：media_type → 扩展名 */
export function extFromMime(mediaType: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/gif': 'gif',
    'image/webp': 'webp',
  }
  return map[mediaType] ?? 'png'
}
