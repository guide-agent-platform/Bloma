import { app, BrowserWindow, dialog, ipcMain, session, type MessageBoxOptions, type WebContents } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerIpcHandlers } from './ipc'
import { setSnapshotCaptureProvider } from './platform-services'

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
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    dialog.showErrorBox('预览加载失败', '渲染进程已停止，请重新打开应用。')
  })

  setSnapshotCaptureProvider(async () => {
    if (!mainWindow) return undefined
    const image = await mainWindow.webContents.capturePage()
    return { buffer: image.toPNG(), extension: 'png' }
  })
  registerIpcHandlers(ipcMain, mainWindow)

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

app.whenReady().then(createMainWindow)

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
    if (details.resourceType !== 'mainFrame') {
      // iframe 子帧 / 脚本 / 样式等：不动响应头，交给各响应自身的 CSP
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'none'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self'",
            "connect-src 'self' http://localhost:* https://api.anthropic.com",
            "frame-src 'self' http://localhost:* http://127.0.0.1:*",
          ].join('; '),
        ],
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
