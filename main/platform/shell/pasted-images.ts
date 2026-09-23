// 粘贴图片存储与水合（clipboard-image-paste P1，2026-08-29 r67）
// 信源：enhancements/clipboard-image-paste-prototype.ts 12/12（r67）+ U9 base64 模式（platform-services.ts）
//
// 职责边界：
// - 存储层：粘贴图落 {PROMA_HOME}/pasted-images/<sessionId>/<uuid>.<ext>，返回 imageId 短引用
//   （防 JSONL 膨胀——原型 8d 量化：800KB 截图直落 base64 每次 +1064KB）
// - 水合层：anthropicMessagesQuery 入口统一调用，把 messages 中 image 块读文件转 Anthropic
//   base64 source。跨轮仅最近 MAX_HYDRATED_IMAGES 个全量水合（多轮重复计费防护），
//   更早降级 '[图片已省略]'；文件缺失降级 '[图片已丢失]'（不 400 不崩）。
// - 安全：resolvePastedImagePath 严格校验 imageId 格式（两段式、白名单字符），防路径穿越。

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConversationTurn } from '../../orchestration/orchestrator'
import type { MessageContentBlock } from '../../../shared/types'
import { ensureDir, getPromaHome } from '../../../storage/config-paths'

/** 单图大小上限（与 renderer 白名单一致；5MB 足够截图语义） */
export const MAX_PASTED_IMAGE_BYTES = 5 * 1024 * 1024
/**
 * 请求体水合上限：跨轮按序仅最近 N 个 image 块全量 base64（更早的降级占位文本）。
 * Anthropic 每轮请求重发全部历史——不限制则多图对话每轮重复计费且易撞请求体上限。
 */
export const MAX_HYDRATED_IMAGES = 4

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** {PROMA_HOME}/pasted-images[/<sessionId>] */
export function getPastedImagesDir(sessionId?: string): string {
  const base = join(getPromaHome(), 'pasted-images')
  return sessionId ? join(base, sessionId) : base
}

/**
 * 会话删除清理（clipboard-paste P2 挂账兑现，r73）：递归删除该会话的粘贴图目录。
 * 挂点：session-service.cleanOrphanSessions（孤儿会话 JSONL 删除同步）。
 * 幂等：目录不存在返回 false 不抛错（删除主流程零感知）；仅删自己会话目录（不误删契约 096）。
 */
export function cleanupPastedImages(sessionId: string): boolean {
  if (!sessionId) return false
  const dir = getPastedImagesDir(sessionId)
  if (!existsSync(dir)) return false
  try {
    rmSync(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 保存粘贴图（IPC pastedImage.save 的实现核心）。
 * @returns imageId（`<sessionId>/<uuid>.<ext>` 短引用）与 media_type
 * @throws 无效扩展名/写盘失败（调用方 IPC 层转错误响应，不静默）
 */
export function savePastedImage(sessionId: string, base64Data: string, ext: string): { imageId: string; media_type: string } {
  const normalizedExt = ext.toLowerCase().replace(/^\./, '')
  const media_type = EXT_TO_MIME[normalizedExt]
  if (!media_type) throw new Error(`PASTED_IMAGE_BAD_EXT: 不支持的图片扩展名 ${ext}`)
  const dir = ensureDir(getPastedImagesDir(sessionId))
  const filename = `${randomUUID()}.${normalizedExt}`
  writeFileSync(join(dir, filename), Buffer.from(base64Data, 'base64'))
  return { imageId: `${sessionId}/${filename}`, media_type }
}

/** imageId 合法形态：`<sessionId>/<filename>.<ext>`，两段均白名单字符（防路径穿越） */
const IMAGE_ID_PATTERN = /^[A-Za-z0-9_-]+\/[A-Za-z0-9-]+\.(png|jpeg|jpg|gif|webp)$/

/**
 * imageId → 绝对路径。非法 id（含 `..`、URL 编码穿越、多段路径等）一律抛错。
 * 白名单正则先行：不匹配即拒绝，天然排除 `../`、`%2f`、绝对路径注入。
 */
export function resolvePastedImagePath(imageId: string): string {
  if (!IMAGE_ID_PATTERN.test(imageId)) throw new Error(`PASTED_IMAGE_BAD_ID: 非法图片引用`)
  const [sessionId, filename] = imageId.split('/')
  const abs = join(getPastedImagesDir(sessionId), filename)
  // 双保险：解析后仍须落在 pasted-images 根内（防御未来目录配置变化）
  const root = join(getPromaHome(), 'pasted-images')
  if (!abs.startsWith(root)) throw new Error(`PASTED_IMAGE_BAD_ID: 路径越界`)
  return abs
}

/**
 * 水合 messages 中全部 image 块（anthropicMessagesQuery 入口调用，全 SDK 查询路径统一覆盖）。
 *
 * - 不突变输入（请求体专用水合产物，JSONL/内存态仍是 imageId 短引用）
 * - 跨轮按出现顺序收集 image 块，仅最后 MAX_HYDRATED_IMAGES 个全量水合，更早替换 '[图片已省略]'
 * - 单块读失败替换 '[图片已丢失]'，不中断不抛错
 * - string 轮与 text/tool 块原样透传（引用共享，无深拷贝成本）
 */
export function hydrateMessagesImageBlocks(turns: ConversationTurn[]): ConversationTurn[] {
  // 第一遍：按顺序收集全部 image 块引用（轮序 → 块序）
  const imageRefs: Array<{ turn: number; block: number }> = []
  turns.forEach((turn, ti) => {
    if (typeof turn.content === 'string') return
    turn.content.forEach((block, bi) => {
      if (block.type === 'image') imageRefs.push({ turn: ti, block: bi })
    })
  })
  if (imageRefs.length === 0) return turns
  const hydrateSet = new Set(imageRefs.slice(-MAX_HYDRATED_IMAGES).map((r) => `${r.turn}:${r.block}`))

  // 第二遍：构造新数组（含 image 块的轮次重建）
  return turns.map((turn, ti) => {
    if (typeof turn.content === 'string') return turn
    if (!turn.content.some((b) => b.type === 'image')) return turn
    const content: MessageContentBlock[] = turn.content.map((block, bi) => {
      if (block.type !== 'image') return block
      const key = `${ti}:${bi}`
      if (!hydrateSet.has(key)) {
        return { type: 'text', text: '[图片已省略]' }
      }
      try {
        const abs = resolvePastedImagePath(block.imageId ?? '')
        if (!existsSync(abs)) throw new Error('not found')
        return {
          type: 'image',
          media_type: block.media_type ?? 'image/png',
          source: { type: 'base64', media_type: block.media_type ?? 'image/png', data: readFileSync(abs).toString('base64') },
        }
      } catch {
        return { type: 'text', text: '[图片已丢失]' }
      }
    })
    return { ...turn, content }
  })
}
