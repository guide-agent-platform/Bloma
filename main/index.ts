import { app, BrowserWindow, dialog, ipcMain, Notification, session, type MessageBoxOptions, type WebContents } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerIpcHandlers } from './ipc'
import { setSnapshotCaptureProvider } from './platform-services'
import { reconcileInterruptedProjects } from './recovery-service'
import {
  setFocusWindowAction,
  setNotificationBackend,
  setWindowFocusedHook,
  startPendingDecisionReminderLoop,
} from './notifications'
import { MAIN_FRAME_CSP, shouldInjectMainFrameCsp } from './csp'
import { createCrashGuard } from './renderer-crash-guard'

const __dirname = dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | undefined

async function createMainWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 720,
    title: 'Bloma',
    webPreferences: {
      preload: resolvePreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  })

  configureContentSecurity(mainWindow)
  configureOutboundAllowlist()
  configureWebContents(mainWindow.webContents)
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL()
    if (current && new URL(url).origin !== new URL(current).origin) event.preventDefault()
  })
  // Renderer-Crash-Guard v2（v7 Top3，2026-08-29）：渲染进程崩溃不再死路——
  // reason 白名单（crashed/oom/abnormal-exit）→ 30s 窗口限流 2 次自动 reload → 超限弹框；
  // 500ms 风暴去重入日志；reload/弹框/日志写全防护（状态机见 renderer-crash-guard.ts，单测 S4-AGENT-075~082）。
  // 日志落 userData（Electron 惯例，与渠道/会话存储同区）。
  const crashGuard = createCrashGuard(join(app.getPath('userData'), 'renderer-crash-log.jsonl'))
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    crashGuard.onGone('main', Date.now(), details.reason, details.exitCode, {
      reload: () => mainWindow?.webContents.reload(),
      showErrorBox: () => dialog.showErrorBox('预览加载失败', '渲染进程已停止，请重新打开应用。'),
    })
  })

  setSnapshotCaptureProvider(async () => {
    if (!mainWindow) return undefined
    const image = await mainWindow.webContents.capturePage()
    return { buffer: image.toPNG(), extension: 'png' }
  })
  registerIpcHandlers(ipcMain, mainWindow)
  // T6 后台执行通知：注入 Electron 系统通知后端 + 焦点钩子，并启动待决策持续提醒轮询。
  // 点击通知聚焦回主窗；关闭（dismiss）通知记为该项目的显式忽略，停止反复提醒。
  setNotificationBackend({
    show: (notification, hooks) => {
      if (!Notification.isSupported()) return
      const instance = new Notification({ title: notification.title, body: notification.body })
      let clicked = false
      if (hooks?.onClick) {
        instance.on('click', () => {
          clicked = true
          hooks.onClick?.()
        })
      }
      if (hooks?.onDismiss) {
        // Windows/多数桌面：点击会先于 close 触发；clicked 标记避免「点完又被记成忽略」
        instance.on('close', () => {
          if (!clicked) hooks.onDismiss?.()
        })
      }
      instance.show()
    },
    isSupported: () => Notification.isSupported(),
  })
  setWindowFocusedHook(() => mainWindow?.isFocused() ?? false)
  setFocusWindowAction(() => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
  startPendingDecisionReminderLoop()

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    await mainWindow.loadFile(join(app.getAppPath(), 'dist', 'index.html'))
  }
}

function resolvePreloadPath(): string {
  const compiled = join(__dirname, '..', 'preload', 'bridge.cjs')
  if (existsSync(compiled)) return compiled
  return join(app.getAppPath(), 'dist-main', 'preload', 'bridge.cjs')
}

/**
 * 启动孤儿阶段对账（长期型改造 T1）：崩溃/强杀后项目可能残留 generating_mvp /
 * testing / judge_review / repairing / iterating 等中间态。开窗前按磁盘证据把
 * 这些项目收敛到 ready / sketch_ready / clarifying 并在会话里落如实说明——
 * 只认磁盘产物与健康快照，不推断进度。失败不阻断启动。
 */
async function reconcileInterruptedProjectsAtStartup(): Promise<void> {
  try {
    const outcomes = await reconcileInterruptedProjects()
    if (outcomes.length > 0) {
      console.log(
        `[reconcile] 启动对账完成：${outcomes.length} 个中断项目已收敛 ` +
          outcomes.map((item) => `${item.project_id.slice(0, 8)} ${item.from_stage}→${item.to_stage}`).join(', '),
      )
    }
  } catch (error) {
    console.error('[reconcile] 启动对账失败（不阻断启动）:', error)
  }
}

app.whenReady().then(async () => {
  // 开窗前完成对账（恢复是纯本地文件 IO，通常毫秒级；阶段收敛先于渲染端读取，
  // 避免渲染端拿到中间态阶段又滞后于磁盘）
  await reconcileInterruptedProjectsAtStartup()
  await createMainWindow()
})

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() === 'webview') configureWebContents(contents)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createMainWindow()
})

/**
 * 为 renderer 主窗口注入 CSP。
 *
 * 重要：必须按 resourceType === 'mainFrame' 收窄——onHeadersReceived 会拦截
 * session 内所有请求，若不收窄，CSP 会一并注入沙箱 iframe 的 index.html 响应：
 * 主窗 CSP 的 `script-src 'self'`（无 unsafe-inline）会与沙箱自身 CSP 取交集，
 * 把生成页的内联 <script>（用于给 .screen 加 .active）整段屏蔽，导致
 * 「沙箱里渲染不出应有的 UI」。iframe 子帧受沙箱静态服务器自己的 CSP 约束，
 * 主窗 CSP 不得覆盖它。
 *
 * frame-src 允许主窗 iframe 加载沙箱预览（localhost），否则 default-src 'none'
 * 会把 iframe 一并禁掉。
 */
function configureContentSecurity(_window: BrowserWindow): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!shouldInjectMainFrameCsp(details.resourceType)) {
      // iframe 子帧 / 脚本 / 样式等：不动响应头，交给各响应自身的 CSP
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [MAIN_FRAME_CSP],
      },
    })
  })
}

/** 拦截非白名单主机的出站请求，防止生成代码外泄数据或 SSRF。 */
const ALLOWED_OUTBOUND_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  'api.anthropic.com',
])

function configureOutboundAllowlist(): void {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    // dev 模式下跳过拦截（Vite HMR websocket 等）
    if (!app.isPackaged) return callback({ cancel: false })
    try {
      const { hostname } = new URL(details.url)
      callback({ cancel: !ALLOWED_OUTBOUND_HOSTS.has(hostname) })
    } catch {
      // 无法解析的 URL 放行（可能是 file:// 或自定义协议）
      callback({ cancel: false })
    }
  })
}

function configureWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12' && !app.isPackaged) contents.openDevTools({ mode: 'detach' })
  })
  const dialogAwareContents = contents as WebContents & {
    on(
      event: 'javascript-dialog-opening',
      listener: (
        event: { preventDefault(): void },
        details: { type: 'alert' | 'confirm' | 'prompt'; message: string },
      ) => void,
    ): WebContents
  }
  dialogAwareContents.on('javascript-dialog-opening', (event, details) => {
    event.preventDefault()
    const parent = BrowserWindow.fromWebContents(contents) ?? mainWindow
    const options: MessageBoxOptions = {
      type: details.type === 'alert' ? 'info' : 'question',
      title: '页面提示',
      message: details.message || '预览页面请求显示一条消息。',
      buttons: ['知道了'],
      noLink: true,
    }
    if (parent) void dialog.showMessageBox(parent, options)
    else void dialog.showMessageBox(options)
  })
}
