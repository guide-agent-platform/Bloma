/**
 * 桌面线产物监听与清单（刀3，2026-10-02 确认协议与呈现层战役——呈现层最小版）。
 *
 * 用户验收盲区（战役定性第 5 条）：全程门禁绿 ≠ 用户看得见程序长什么样——调度员
 * 40 轮叙述里没有一张图。呈现层最小版三件套：driver 截图约定（任务书面）+
 * 本模块（fs.watch 变更信号 + 清单扫描 + 图片读取）+ 渲染端产物预览区。
 *
 * 设计（竞品 preview-watcher 模式结构借鉴，Windows 目标平台 recursive watch 原生支持）：
 * - 清单只收三类（实施稿拍板：png 直显 / md 只读 / json 链接）——00_VERIFY/screenshots/*.png、
 *   00_ARCH/*.md|*.json、DELIVERY.md；不做实时预览；
 * - watcher 是「有变化，请重新拉清单」的去抖信号（不传具体文件——增量 diff 收益小、
 *   目录重建边界复杂）；3s 去抖防目录级联事件风暴；
 * - 单订阅模型：渲染端一次只看一个项目——新订阅自动停旧 watcher（幂等重订阅安全）；
 * - 图片读取：png → base64 data URL（≤2MB 上限，超限如实报错不崩）。
 */

import { readFileSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

/** 产物清单条目（渲染端直显/点击读取）。 */
export interface DesktopArtifactItem {
  /** 项目内相对路径（posix 风格，渲染端展示与读取入参共用）。 */
  path: string
  /** image=png 直显；doc=md/json 只读文本。 */
  kind: 'image' | 'doc'
  /** 字节数（展示用）。 */
  bytes: number
  /** 修改时间毫秒（排序/新变更提示）。 */
  mtime: number
}

/** 扫描项目根 → 产物清单（三类白名单；目录缺失静默空清单）。 */
export function listDesktopArtifacts(root: string): DesktopArtifactItem[] {
  const items: DesktopArtifactItem[] = []
  const pushFile = (absPath: string, relPath: string, kind: DesktopArtifactItem['kind']) => {
    try {
      const stat = statSync(absPath)
      if (!stat.isFile()) return
      items.push({ path: relPath, kind, bytes: stat.size, mtime: stat.mtimeMs })
    } catch {
      // 竞态（扫描中被删）：跳过
    }
  }
  const scanDir = (relDir: string, accept: (name: string) => DesktopArtifactItem['kind'] | null) => {
    try {
      for (const entry of readdirSync(join(root, relDir), { withFileTypes: true })) {
        if (!entry.isFile()) continue
        const kind = accept(entry.name)
        if (kind) pushFile(join(root, relDir, entry.name), `${relDir}/${entry.name}`, kind)
      }
    } catch {
      // 目录不存在：静默（清单为空是合法状态）
    }
  }
  scanDir('00_VERIFY/screenshots', (name) => (name.toLowerCase().endsWith('.png') ? 'image' : null))
  scanDir('00_ARCH', (name) => {
    const lower = name.toLowerCase()
    if (lower.endsWith('.md') || lower.endsWith('.json')) return 'doc'
    return null
  })
  pushFile(join(root, 'DELIVERY.md'), 'DELIVERY.md', 'doc')
  return items.sort((a, b) => a.mtime - b.mtime)
}

// =========================================================================
// watcher（单订阅模型）
// =========================================================================

/** 变更信号（去抖后触发；渲染端据此重新拉清单）。 */
export type ArtifactChangeSignal = (projectId: string) => void

interface ActiveWatch {
  projectId: string
  watcher: FSWatcher
  timer: NodeJS.Timeout | undefined
}

let active: ActiveWatch | undefined

/** 去抖窗口：目录级联写（截图连续落盘）合并为一次信号。 */
const DEBOUNCE_MS = 3000

/**
 * 订阅项目产物变更（单订阅：新订阅自动停旧；同项目重订阅幂等重建）。
 * 监听面=项目根 recursive（Windows 原生支持；Python 项目生成期无 node_modules 噪音，
 * 事件只作去抖信号不逐条转发，成本可控）。目录不存在时 watch 会对「创建」报事件，
 * 重建清单自然覆盖。
 */
export function subscribeDesktopArtifacts(
  projectId: string,
  root: string,
  onEvent: ArtifactChangeSignal,
): void {
  if (active) {
    active.watcher.close()
    if (active.timer) clearTimeout(active.timer)
  }
  try {
    const watcher = watch(root, { recursive: true }, () => {
      const current = active
      if (!current || current.projectId !== projectId) return
      if (current.timer) clearTimeout(current.timer)
      current.timer = setTimeout(() => {
        active = active && active.projectId === projectId ? { ...active, timer: undefined } : active
        if (active && active.projectId === projectId) onEvent(projectId)
      }, DEBOUNCE_MS)
    })
    active = { projectId, watcher, timer: undefined }
  } catch (error) {
    // 项目根不存在等异常：订阅失败留痕（清单快照仍可用，仅失去实时性）
    console.error('[desktop-artifacts] 产物监听启动失败（清单快照仍可用）：', error)
  }
}

/** 停止监听（项目关闭/切换到非桌面线时；幂等）。 */
export function stopDesktopArtifactsWatch(): void {
  if (!active) return
  active.watcher.close()
  if (active.timer) clearTimeout(active.timer)
  active = undefined
}

/** 测试隔离：当前活跃订阅 id。 */
export function activeWatchProjectId(): string | undefined {
  return active?.projectId
}

// =========================================================================
// 图片读取
// =========================================================================

/** data URL 上限（2MB——窗口截图通常 <500KB；超限报错不崩）。 */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024

/**
 * 读取产物 png → data URL（渲染端 <img> 直显）。
 * fail-closed 边界：路径必须命中清单三类白名单（png 截图）；越界路径抛错
 * （不开放任意文件读取）。
 */
export function readDesktopArtifactImage(root: string, relativePath: string): { data_url: string; bytes: number } {
  const normalized = relativePath.replace(/\\/g, '/')
  if (normalized.includes('..') || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error('ARTIFACT_BAD_PATH: 路径必须是项目内相对路径')
  }
  if (!normalized.startsWith('00_VERIFY/screenshots/') || !normalized.toLowerCase().endsWith('.png')) {
    throw new Error('ARTIFACT_NOT_IMAGE: 图片读取只开放 00_VERIFY/screenshots/ 下的 png 截图')
  }
  const abs = join(root, normalized)
  const stat = statSync(abs)
  if (!stat.isFile()) throw new Error('ARTIFACT_NOT_FILE: 目标不是文件')
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`ARTIFACT_TOO_LARGE: 截图超过 2MB 上限（${stat.size} 字节）`)
  }
  const buf = readFileSync(abs)
  return { data_url: `data:image/png;base64,${buf.toString('base64')}`, bytes: stat.size }
}
