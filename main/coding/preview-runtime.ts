/**
 * 真实脚手架变体标记（web 线拆除刀3 瘦身，2026-10-01）：
 * 变体标记文件是工具面写边界（agent-tools/tool-handlers）与 desktop 子会话
 * 工具集（buildDesktopChildTools realFullstackVariant）的权威判定源，予以保留；
 * web 预览执行面（fullstack spawn/静态文件服务器/vendor 供货/服务指纹）随
 * web 生成线退役删除——旧 web 项目预览能力随之退役（数据兼容层不含预览重启）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 真实脚手架变体标记文件（骨架渲染时写入项目根，随快照归档/恢复）：
 *  运行时/交付链/工具面都以它为权威判定，而非文件存在性启发。
 *  agent 写入被工具面拒绝（平台管理文件）。 */
export const REAL_VARIANT_MARKER = '.bloma-real-variant'
export type RealScaffoldVariant = 'real-static' | 'real-fullstack'

export function readRealScaffoldVariant(projectRoot: string): RealScaffoldVariant | null {
  try {
    const raw = readFileSync(join(projectRoot, REAL_VARIANT_MARKER), 'utf8').trim()
    return raw === 'real-static' || raw === 'real-fullstack' ? raw : null
  } catch {
    return null
  }
}

/** 写入变体标记（测试 seam 与存量项目标记维护；web 骨架渲染器已退役，生产写入方随 web 线拆除）。 */
export function writeRealScaffoldMarker(projectRoot: string, variant: RealScaffoldVariant): void {
  writeFileSync(join(projectRoot, REAL_VARIANT_MARKER), variant, 'utf8')
}
