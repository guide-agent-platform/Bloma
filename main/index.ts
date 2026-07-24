import { app, BrowserWindow, dialog, ipcMain, type MessageBoxOptions, type WebContents } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerIpcHandlers } from './ipc'

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
      webviewTag: true,
    },
  })

  configureWebContents(mainWindow.webContents)
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL()
    if (current && new URL(url).origin !== new URL(current).origin) event.preventDefault()
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    dialog.showErrorBox('预览加载失败', '渲染进程已停止，请重新打开应用。')
  })

  registerIpcHandlers(ipcMain, mainWindow)

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    await mainWindow.loadFile(join(app.getAppPath(), 'dist', 'index.html'))
  }
}

function resolvePreloadPath(): string {
  const compiled = join(__dirname, '..', 'preload', 'bridge.js')
  if (existsSync(compiled)) return compiled
  return join(app.getAppPath(), 'preload', 'bridge.js')
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

function configureWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12') contents.openDevTools({ mode: 'detach' })
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
