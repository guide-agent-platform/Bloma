/**
 * 托盘 + 全局热键（2026-10-06 体验批 B；结构借鉴 Proma 上游 tray.ts / global-shortcut-service，
 * 按 Bloma 单主窗形态大幅简化——多会话菜单/闪烁/session 列表不搬）。
 *
 * 行为：
 * - 主窗 close → 隐藏到托盘（真退出走托盘菜单；before-quit 置 quitting 标记放行）；
 * - 首次最小化气泡提示（Windows displayBalloon，一次为限）；
 * - 托盘菜单：显示 Bloma / 退出；单击图标切换主窗显隐；
 * - 全局热键 Ctrl+Alt+B 唤起/隐藏（注册失败降级 console.warn，不阻塞启动）；
 * - tooltip 30s 轮询活跃项目阶段（「项目名 · 阶段」，无活跃项目显示 Bloma）。
 */

import { app, BrowserWindow, globalShortcut, Menu, nativeImage, Tray } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

let tray: Tray | null = null
let tooltipTimer: NodeJS.Timeout | undefined
let balloonShown = false
/** 真退出标记（before-quest 置真；close 处理器据此放行）。 */
let quitting = false
/** 项目阶段数据源（注入式——platform 件不反向依赖 domain 项目服务，notifications 同款；
 * entry 层接线真源，未接线时 tooltip 只显示「Bloma」）。 */
let projectSource: { listActiveProjects: () => Array<{ name?: string; current_stage: string }> } | undefined

export function setTrayProjectSource(source: { listActiveProjects: () => Array<{ name?: string; current_stage: string }> } | null): void {
  projectSource = source ?? undefined
}

function trayIconPath(): string {
  // dev: 仓库根 resources/；esbuild bundle 后 main 根 = dist-main/main/（build:main cpSync 不含 resources），
  // 故两态探测：仓库根与 dist-main 向上。打包态预留 process.resourcesPath。
  const candidates = [
    join(app.getAppPath(), 'resources', 'tray', 'icon32.png'),
    join(app.getAppPath(), 'resources', 'tray', 'icon16.png'),
    join(process.resourcesPath ?? '', 'tray', 'icon32.png'),
  ]
  return candidates.find((path) => existsSync(path)) ?? candidates[0]!
}

/** 活跃项目阶段摘要（tooltip 用；数据源未接线/异常静默）。 */
function activeStageSummary(): string | null {
  try {
    const active = (projectSource?.listActiveProjects() ?? []).filter((project) => project.current_stage !== 'completed')
    const busy = active.find((project) =>
      ['generating_sketch', 'sketch_ready', 'generating_mvp', 'testing', 'judge_review', 'repairing', 'upgrading'].includes(project.current_stage),
    )
    if (busy) return `${busy.name ?? '未命名项目'} · ${busy.current_stage}`
    if (active.length > 0) return `${active[0]!.name ?? '未命名项目'}`
    return null
  } catch {
    return null
  }
}

function refreshTooltip(): void {
  if (!tray) return
  const summary = activeStageSummary()
  tray.setToolTip(summary ? `Bloma · ${summary}` : 'Bloma')
}

function toggleMainWindow(mainWindow: BrowserWindow): void {
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide()
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}

/** 主窗 close→托盘的首次气泡提示（由 index.ts 的 close 处理器调用）。 */
export function notifyHiddenToTray(): void {
  if (balloonShown || !tray || process.platform !== 'win32') return
  balloonShown = true
  tray.displayBalloon({
    title: 'Bloma 已最小化到托盘',
    content: '程序仍在运行；单击托盘图标恢复，退出请走托盘菜单。',
  })
}

/**
 * 安装托盘与热键（main/index.ts 在主窗创建后调用；幂等）。
 * 主窗 close→隐藏的拦截在 index.ts createMainWindow 内挂（防窗口重建丢失）。
 */
export function installTrayAndShortcut(getMainWindow: () => BrowserWindow | undefined): void {
  if (tray) return

  const image = nativeImage.createFromPath(trayIconPath())
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
  tray.setToolTip('Bloma')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 Bloma', click: () => { const win = getMainWindow(); if (win) toggleMainWindow(win) } },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true
        app.quit()
      },
    },
  ]))
  tray.on('click', () => {
    const win = getMainWindow()
    if (win) toggleMainWindow(win)
  })

  // 全局热键（冲突降级：不阻塞启动）
  try {
    const registered = globalShortcut.register('Ctrl+Alt+B', () => {
      const current = getMainWindow()
      if (current) toggleMainWindow(current)
    })
    if (!registered) console.warn('[tray] 全局热键 Ctrl+Alt+B 注册失败（可能被占用），托盘点击仍可用')
  } catch (error) {
    console.warn('[tray] 全局热键注册异常（降级）:', error)
  }

  // tooltip 阶段轮询（30s；unref 不阻退出）
  refreshTooltip()
  tooltipTimer = setInterval(refreshTooltip, 30_000)
  tooltipTimer.unref?.()

  app.on('before-quit', () => {
    quitting = true
  })
}

/** 卸载（测试/退出清理）。 */
export function teardownTrayAndShortcut(): void {
  if (tooltipTimer) { clearInterval(tooltipTimer); tooltipTimer = undefined }
  globalShortcut.unregister('Ctrl+Alt+B')
  tray?.destroy()
  tray = null
  quitting = false
  balloonShown = false
}

/** 测试口：读取退出标记。 */
export function isTrayQuitting(): boolean {
  return quitting
}
