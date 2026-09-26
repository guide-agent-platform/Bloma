import { app, BrowserWindow, dialog, ipcMain, Notification, session, type MessageBoxOptions, type WebContents } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerIpcHandlers } from './ipc'
import { setSnapshotCaptureProvider } from './delivery/snapshots'
import { reconcileInterruptedProjects } from './project/recovery-service'
import { reconcileAllRunningDelegations } from './agent/delegation/delegation-persistence'
import { migrateLegacySessionsIndexOnce } from './platform/sessions/session-service'
import {
  setFocusWindowAction,
  setNotificationBackend,
  setWindowFocusedHook,
  startPendingDecisionReminderLoop,
} from './platform/shell/notifications'
import { MAIN_FRAME_CSP, shouldInjectMainFrameCsp } from './csp'
import { createCrashGuard } from './platform/shell/renderer-crash-guard'
// PR4 后续：平台件决策 sink 接线（runtime-fallback 不再反向依赖 domain 决策日志）
import { setDecisionSink } from './platform/llm/runtime-fallback'
import { setProjectTouchHandler } from './platform/sessions/session-service'
import { setNotificationProjectHooks } from './platform/shell/notifications'
import { recordDecision } from './project/decision-log'
import { findProject, listProjects, updateProject } from './project/project-service'

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
  configureMediaPermissions()
  // 渠道切换/类别路由决策落档 sink 接线（entry 层 composition；未接线时静默）
  setDecisionSink((input) => {
    try {
      recordDecision(input as unknown as Parameters<typeof recordDecision>[0])
    } catch {
      /* 项目/会话缺席：静默，等价旧直连容错路径 */
    }
  })
  // 会话创建后的项目 last_session_id 触碰接线（包装内吞 PROJECT_NOT_FOUND，等价旧容错）
  setProjectTouchHandler((projectId, patch) => {
    try {
      updateProject(projectId, patch)
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('PROJECT_NOT_FOUND')) throw error
    }
  })
  // 通知链路的项目信息/阻塞清单接线（未接或缺席=不弹/兑底文案，等价旧容错）
  setNotificationProjectHooks({
    projectInfo: (projectId) => {
      try {
        const project = findProject(projectId)
        return { stage: project.current_stage, name: project.name }
      } catch {
        return null
      }
    },
    blockedProjects: () => listProjects('active'),
  })
  // 会话索引独立化迁移（2026-09-04）：旧共用 agent-sessions.json 里的 Bloma 条目
  // 搬进专属 bloma-agent-sessions.json（幂等，只读旧写新不动 Proma 文件）；失败不阻断
  try {
    const migrated = migrateLegacySessionsIndexOnce()
    if (migrated.migrated > 0) console.log(`[sessions] 存量索引迁移完成：${migrated.migrated} 条 Bloma 会话 → bloma-agent-sessions.json`)
  } catch (error) {
    console.error('[sessions] 存量索引迁移失败（不阻断启动）:', error)
  }
  // 开窗前完成对账（恢复是纯本地文件 IO，通常毫秒级；阶段收敛先于渲染端读取，
  // 避免渲染端拿到中间态阶段又滞后于磁盘）
  await reconcileInterruptedProjectsAtStartup()
  // 2026-09-26 运行审计 P1-09：委派账本启动对账——重启时仍在跑的子委派统一标记
  // 「应用重启中断」并落 settle 行（此前只有定义无生产接线，running 账本悬置）；
  // fail-open 不阻断启动。
  try {
    const reconciledDelegations = reconcileAllRunningDelegations()
    if (reconciledDelegations > 0) console.log(`[delegation] 启动对账：${reconciledDelegations} 个重启中断的委派已标记 cancelled`)
  } catch (error) {
    console.error('[delegation] 启动对账失败（不阻断启动）:', error)
  }
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

/**
 * 授予产物沙箱 iframe 的麦克风（media/audio 采集）权限——「语顺精灵球」等录音产物需要 getUserMedia。
 *
 * Electron 对未处理的权限请求默认拒绝；产物预览跑在 localhost 沙箱 iframe 里，必须显式放行。
 * 判断用 requestingUrl / requestingOrigin（发起请求的 iframe 来源），不能用 webContents.getURL()——
 * 后者返回顶层主窗 URL（file:// 或 dev server），拿不到实际发起权限请求的 iframe 来源。
 * 仅对 http://localhost / http://127.0.0.1 授予 media 权限，避免把麦克风权限扩大到整个应用面。
 */
function configureMediaPermissions(): void {
  const isLocalPreview = (url: string): boolean => {
    try {
      const u = new URL(url)
      return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
    } catch {
      return false
    }
  }
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(permission === 'media' && isLocalPreview(details.requestingUrl))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return permission === 'media' && isLocalPreview(requestingOrigin)
  })
}
