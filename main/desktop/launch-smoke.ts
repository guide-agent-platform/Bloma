/**
 * launch-smoke — 「启动冒烟 + 联合判定 + UI 截图」（2026-10-04 呈现层收口批；批1 2026-10-06 升级）。
 *
 * 事故背书（10-04 凌晨狗粮 f896b314）：交付物 calculator.py 无头自测全对，但 GUI
 * 启动即崩（tkinter Frame pady 元组）——quick 豁免了驱动/截图，没有任何环节真正
 * 启动过程序；用户视角「沙箱空的、连 UI 确认都没有」。
 *
 * 机制（声明制，与契约同哲学）：
 * - 子会话按任务书写 LAUNCH.json 到项目根（schema_version/command/window_title）；
 * - 宿主在交付前真实 spawn 一次：宽限期内退出（任意码）= 冒烟失败（stdout/stderr
 *   尾部回传给修复轮——昨晚的 TclError 会被这关当场截获）；
 * - 联合判定档（LAUNCH 带 window_title，批1 2026-10-06）：进程存活 ≠ 应用可用——
 *   平台探针（系统 python + ctypes）按「窗口可见 + 消息循环响应 + 稳定期 + 优雅关闭
 *   + 错误对话框检测」联合判定（弹幕单 5cb5e941 实证：进程活着但主循环冻结、窗口
 *   挂死，纯存活判定测不出）；截图由探针在稳定期后、关闭前句柄级捕获；
 * - 纯存活档（无 window_title，如无窗口/托盘类）：存活即过，截图可跳过（旧行为）；
 * - 探针自身不可用（python 缺失/超时/输出损坏）：降级纯存活档并如实标注（不误杀，
 *   也不把「未检查」伪装成「检查通过」）；
 * - 命令过 contract-schema 黑名单（纵深防御，安全门已扫产物仍复检入口）。
 *
 * 依赖注入：spawn/capture/probe/超时均注入（单测零 electron/零真 GUI，陷阱 35）。
 */
import { execFile, spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { violatesCommandBlacklist } from './contract-schema'
import { buildDriverEnv, resolveDriverVenvCommand } from './process-driver'
import { loopbackUrl } from '../software/process-manager'
import { validateSoftwareCommand, resolveSoftwareCommand, softwareEnvironment } from '../software/command-runtime'

/** 入口声明文件（项目根相对）。 */
export const LAUNCH_RELATIVE_PATH = 'LAUNCH.json'

/** 冒烟截图落点（刀3 产物白名单目录，png 直显）。 */
export const SMOKE_SCREENSHOT_RELATIVE_PATH = '00_VERIFY/screenshots/LAUNCH.png'

export interface LaunchDeclaration {
  schema_version?: 2
  url?: string
  artifact?: string
  mode?: 'command' | 'resident'
  command: string[]
  /** GUI 窗口标题提示（联合判定档触发条件 + 截图窗口匹配；缺省走纯存活档） */
  window_title?: string
  /** UI 技术栈声明（批8 下半）："webview" = pywebview 骨架 v2 产物（探索桥路由用；缺省由 requirements 探测） */
  ui?: 'webview' | 'electron' | 'browser'
}

export type LaunchDeclarationParse =
  | { ok: true; launch: LaunchDeclaration }
  | { ok: false; error: string }

/** 解析 LAUNCH.json（纯函数）：schema_version=1 / command 非空字符串数组 / window_title 可选。 */
export function parseLaunchDeclaration(raw: string): LaunchDeclarationParse {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'LAUNCH.json 不是合法 JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'LAUNCH.json 须为对象' }
  }
  const obj = parsed as Record<string, unknown>
  if (obj.schema_version !== 1 && obj.schema_version !== 2) {
    return { ok: false, error: `LAUNCH.json schema_version 须为数字 1（收到 ${JSON.stringify(obj.schema_version)}）` }
  }
  const command = obj.command
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== 'string' || part.length === 0)) {
    return { ok: false, error: 'LAUNCH.json command 须为非空字符串数组（如 ["python","calculator.py"]）' }
  }
  const windowTitle = obj.window_title
  if (obj.mode !== undefined && !['command', 'resident'].includes(String(obj.mode))) return { ok: false, error: 'LAUNCH.json mode 须为command或resident' }
  if (obj.mode === 'command' && windowTitle !== undefined) return { ok: false, error: '一次性命令不能同时声明桌面窗口' }
  if (windowTitle !== undefined && typeof windowTitle !== 'string') {
    return { ok: false, error: 'LAUNCH.json window_title 须为字符串（窗口标题提示，可省略）' }
  }
  // 批8 下半：ui 声明只认 'webview'（探索桥路由）；其他值按非法拒绝（fail-closed 同风格）
  if (obj.ui !== undefined && !(obj.schema_version === 2 ? ['webview', 'electron', 'browser'].includes(String(obj.ui)) : obj.ui === 'webview')) {
    return { ok: false, error: `LAUNCH.json ui 目前只支持 "webview"（收到 ${JSON.stringify(obj.ui)}，可省略）` }
  }
  let url: string | undefined
  if (obj.schema_version === 2) {
    try {
      validateSoftwareCommand(command)
      if (obj.ui === 'browser') {
        if (typeof obj.url !== 'string') throw new Error('浏览器程序须声明本机url')
        url = loopbackUrl(obj.url)
      } else if (obj.url !== undefined) throw new Error('只有浏览器入口可声明url')
      if (obj.ui === 'electron' && !(typeof windowTitle === 'string' && windowTitle.trim())) throw new Error('桌面程序须声明实际window_title')
      if (obj.mode === 'command' && obj.ui) throw new Error('一次性命令不能声明GUI')
      if (obj.artifact !== undefined && (typeof obj.artifact !== 'string' || !obj.artifact.trim() || /^(?:[A-Za-z]:|[\\/])/.test(obj.artifact) || obj.artifact.split(/[\\/]/).includes('..'))) throw new Error('artifact须位于项目内')
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }
  return {
    ok: true,
    launch: {
      command,
      ...(obj.schema_version === 2 ? { schema_version: 2 as const, ...(url ? { url } : {}), ...(typeof obj.artifact === 'string' ? { artifact: obj.artifact } : {}) } : {}),
      ...(obj.mode !== undefined ? { mode: obj.mode as 'command' | 'resident' } : {}),
      ...(windowTitle !== undefined ? { window_title: windowTitle } : {}),
      ...(obj.ui !== undefined ? { ui: obj.ui as LaunchDeclaration['ui'] } : {}),
    },
  }
}

/** 读项目根的入口声明（文件缺失/不可读返回 null——调用方决定语义）。 */
export function readLaunchDeclaration(rootPath: string): LaunchDeclarationParse | null {
  let raw: string
  try {
    raw = readFileSync(join(rootPath, LAUNCH_RELATIVE_PATH), 'utf8')
  } catch {
    return null
  }
  return parseLaunchDeclaration(raw)
}

/**
 * 联合判定判据（探针回传）。全部布尔为真才通过；fail_code 是探针侧已定位的
 * 失败判据（no_window/unresponsive/crash_dialog/unstable/wont_close）。
 */
export interface LaunchProbeCriteria {
  window_found: boolean
  responsive: boolean
  stable: boolean
  closed_gracefully: boolean
  /** 启动期错误/崩溃对话框标题（空数组=无） */
  crash_dialog: string[]
  /** 探针是否成功句柄级截图（证据不是门） */
  screenshot: boolean
  fail_code?: string
  detail?: string
  /** 探针不可用降级标记：true = 未执行联合判定（仅存活验证） */
  degraded?: boolean
}

/** 探针运行入参（超时预算由宿主统一编排）。 */
export interface ProbeRunInput {
  signal?: AbortSignal
  pid: number
  title: string
  outPng: string
  readyMs: number
  stableMs: number
  closeMs: number
  watchdogMs: number
}

export type ProbeRun = { json: LaunchProbeCriteria | null; error?: string }

export interface LaunchSmokeResult {
  http_ready?: boolean
  passed: boolean
  /** 人话摘要（人话卡与决策日志用） */
  detail: string
  /** 失败时的 stderr/stdout 尾部或探针细节（修复轮靶子） */
  outputExcerpt?: string
  /** 截图落点（截图成功时） */
  screenshotRel?: string
  /** 联合判定判据（联合档时携带；degraded=true 表示探针不可用仅存活验证） */
  criteria?: LaunchProbeCriteria
}

export interface LaunchSmokeDeps {
  /** Only the lean non-UI route can authorize a declared one-shot command. */
  allowCleanExit?: boolean
  signal?: AbortSignal
  /** 注入 spawn（缺省 nodeSpawn 包装）；测试用 */
  spawnImpl?: (command: string[], cwd: string, env?: Record<string, string>) => ChildProcess
  /** 注入窗口截图（纯存活档/降级档用）；返回 png Buffer 或 null（无匹配窗口） */
  captureWindow?: (titleHint: string | undefined) => Promise<Buffer | null>
  /** 注入联合判定探针（联合档用）；测试用 */
  probeImpl?: (input: ProbeRunInput) => Promise<ProbeRun>
  /** 存活宽限毫秒（缺省 4000） */
  graceMs?: number
  /** 联合档：探针找主窗口预算（缺省 11000，与宽限合计约 15s ready 窗口） */
  probeReadyMs?: number
  /** 联合档：窗口稳定观察期（缺省 3000） */
  probeStableMs?: number
  /** 联合档：优雅关闭等待（缺省 5000） */
  probeCloseMs?: number
  /** 联合档：探针整体看门狗（缺省 ready+stable+close+8000） */
  probeWatchdogMs?: number
}

interface SpawnedChild {
  child: ChildProcess
  stdout: string
  stderr: string
}

function defaultSpawn(command: string[], cwd: string, env?: Record<string, string>): ChildProcess {
  // windowsHide 隐藏控制台宿主；GUI 窗口（tkinter 等）不受影响照常弹出
  return nodeSpawn(command[0]!, command.slice(1), { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
}

async function defaultCaptureWindow(titleHint: string | undefined): Promise<Buffer | null> {
  if (titleHint) {
    // 首选 PrintWindow 句柄捕获（2026-10-05 根治：按窗口句柄拷贝内容，被遮挡也能截到
    // 自己的画面——desktopCapturer 缩略图在窗口被覆盖/最小化时会截到遮挡物或黑帧，
    // 「上面覆盖的程序被截进来」的狗粮实证）。助手脚本临时落盘，系统 python + PIL 执行；
    // 失败回退 desktopCapturer。
    try {
      const png = await printWindowCapture(titleHint)
      if (png && png.length > 0) return png
    } catch {
      // 回退链继续
    }
  }
  // 回退：desktopCapturer 按标题匹配（旧行为；thumbnailSize 大盒拿物理分辨率）
  try {
    const require = createRequire(import.meta.url)
    const { desktopCapturer } = require('electron') as typeof import('electron')
    // thumbnailSize 是「适配盒」不是目标尺寸：给大盒子（3840×2400）拿窗口物理原分辨率，
    // 小窗口不会被放大；旧值 1280×800 在高分屏（本机 2560×1600 物理 @150%）上把截图
    // 下采样到一半分辨率——「截图发糊」的根因，与 Python/tkinter 无关。
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 3840, height: 2400 } })
    if (titleHint) {
      const hit = sources.find((source) => source.name.includes(titleHint))
      if (hit) return hit.thumbnail.toPNG()
    }
    return null
  } catch {
    return null
  }
}

/** PrintWindow 助手脚本：句柄级窗口捕获（DPI 感知 + PW_RENDERFULLCONTENT + GetDIBits→PIL）。 */
const PRINT_WINDOW_HELPER = `import ctypes, sys
from ctypes import wintypes

def main() -> int:
    title, out_path = sys.argv[1], sys.argv[2]
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass
    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32
    hwnd = user32.FindWindowW(None, title)
    if not hwnd:
        return 3
    rect = wintypes.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return 4
    w, h = rect.right - rect.left, rect.bottom - rect.top
    if w <= 0 or h <= 0 or w > 8192 or h > 8192:
        return 5
    hdc = user32.GetWindowDC(hwnd)
    memdc = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    gdi32.SelectObject(memdc, bmp)
    ok = user32.PrintWindow(hwnd, memdc, 2) or user32.PrintWindow(hwnd, memdc, 0)
    if not ok:
        gdi32.DeleteObject(bmp); gdi32.DeleteDC(memdc); user32.ReleaseDC(hwnd, hdc)
        return 6
    class BMIH(ctypes.Structure):
        _fields_ = [('biSize', wintypes.DWORD), ('biWidth', wintypes.LONG), ('biHeight', wintypes.LONG),
                    ('biPlanes', wintypes.WORD), ('biBitCount', wintypes.WORD), ('biCompression', wintypes.DWORD),
                    ('biSizeImage', wintypes.DWORD), ('biXPelsPerMeter', wintypes.LONG), ('biYPelsPerMeter', wintypes.LONG),
                    ('biClrUsed', wintypes.DWORD), ('biClrImportant', wintypes.DWORD)]
    bmi = BMIH()
    bmi.biSize = ctypes.sizeof(BMIH); bmi.biWidth = w; bmi.biHeight = -h
    bmi.biPlanes = 1; bmi.biBitCount = 32; bmi.biCompression = 0
    buf = ctypes.create_string_buffer(w * h * 4)
    if not gdi32.GetDIBits(memdc, bmp, 0, h, buf, ctypes.byref(bmi), 0):
        return 7
    from PIL import Image
    img = Image.frombuffer('RGBA', (w, h), buf, 'raw', 'BGRA', 0, 1)
    img.convert('RGB').save(out_path, 'PNG')
    gdi32.DeleteObject(bmp); gdi32.DeleteDC(memdc); user32.ReleaseDC(hwnd, hdc)
    return 0

sys.exit(main())
`

/**
 * 联合判定探针（批1 2026-10-06）：系统 python + ctypes，对目标进程做
 * 窗口发现 → 消息循环响应 → 错误对话框检测 → 稳定期 → 句柄截图 → WM_CLOSE 优雅退出，
 * JSON 判据回传 stdout。宿主侧助手（与 PRINT_WINDOW_HELPER 同惯例：运行时落盘 tmpdir，
 * 零构建管线改动）；判据设计对应讨论定的联合标准：
 *   进程启动 + 可见主窗口 + 未卡死 + 稳定存活 + 可正常关闭 + 无崩溃对话框。
 */
const LAUNCH_PROBE_HELPER = `import ctypes, json, sys, time
from ctypes import wintypes

sys.stdout.reconfigure(encoding='utf-8')

def main() -> int:
    pid, title, out_png = int(sys.argv[1]), sys.argv[2], sys.argv[3]
    ready_ms, stable_ms, close_ms = int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6])
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    result = {'pid': pid}
    # Win64 handles/results are pointer-sized. ctypes defaults truncate them;
    # DWORD_PTR is not defined by ctypes.wintypes (including Python 3.13).
    user32.IsWindow.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.SendMessageTimeoutW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
                                         wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_size_t)]
    user32.SendMessageTimeoutW.restype = ctypes.c_ssize_t
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

    class PROCESSENTRY32(ctypes.Structure):
        _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD), ('th32ProcessID', wintypes.DWORD),
                    ('th32DefaultHeapID', ctypes.c_size_t), ('th32ModuleID', wintypes.DWORD), ('cntThreads', wintypes.DWORD),
                    ('th32ParentProcessID', wintypes.DWORD), ('pcPriClassBase', wintypes.LONG), ('dwFlags', wintypes.DWORD),
                    ('szExeFile', wintypes.WCHAR * 260)]
    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32)]
    kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32)]

    def owned_pids():
        owned, rows = {pid}, []
        snapshot = kernel32.CreateToolhelp32Snapshot(2, 0)
        if snapshot == ctypes.c_void_p(-1).value:
            return owned
        try:
            row = PROCESSENTRY32(); row.dwSize = ctypes.sizeof(row)
            more = kernel32.Process32FirstW(snapshot, ctypes.byref(row))
            while more:
                rows.append((row.th32ProcessID, row.th32ParentProcessID))
                more = kernel32.Process32NextW(snapshot, ctypes.byref(row))
            while True:
                children = {child for child, parent in rows if parent in owned}
                if children <= owned:
                    return owned
                owned.update(children)
        finally:
            kernel32.CloseHandle(snapshot)

    def enum_hwnds():
        found = []
        @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
        def cb(hwnd, _l):
            found.append(hwnd)
            return True
        user32.EnumWindows(cb, 0)
        return found

    def win_pid(hwnd):
        v = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(v))
        return v.value

    def win_text(hwnd):
        n = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(n + 2)
        user32.GetWindowTextW(hwnd, buf, n + 2)
        return buf.value

    def win_class(hwnd):
        buf = ctypes.create_unicode_buffer(64)
        user32.GetClassNameW(hwnd, buf, 64)
        return buf.value

    def visible_nonzero(hwnd):
        if not user32.IsWindowVisible(hwnd):
            return False
        r = wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
            return False
        return (r.right - r.left) >= 40 and (r.bottom - r.top) >= 40

    ERROR_HINTS = ('错误', 'error', '异常', 'exception', 'traceback', '已停止工作', 'crash', 'python')

    def error_dialogs(pid_val):
        out = []
        for hwnd in enum_hwnds():
            if win_pid(hwnd) in pid_val and win_class(hwnd) == '#32770' and user32.IsWindowVisible(hwnd):
                text = win_text(hwnd) or '(无标题)'
                low = text.lower()
                if any(hint in low or hint in text for hint in ERROR_HINTS):
                    out.append(text)
        return out

    def bail(**kw):
        result.update(kw)
        print(json.dumps(result, ensure_ascii=False))
        return 0

    # 1) Only this launch's process tree; titles must never select a user's
    # unrelated running window. Windows venv launchers may own a child Python.
    main_hwnd = 0
    deadline = time.monotonic() + ready_ms / 1000.0
    while time.monotonic() < deadline and not main_hwnd:
        owned = owned_pids()
        for hwnd in enum_hwnds():
            if user32.IsWindow(hwnd) and win_pid(hwnd) in owned and visible_nonzero(hwnd) and (not title or title in win_text(hwnd)):
                main_hwnd = hwnd
                break
        if not main_hwnd:
            time.sleep(0.25)
    if not main_hwnd:
        return bail(window_found=False, responsive=False, stable=False, closed_gracefully=False,
                    crash_dialog=[], screenshot=False, fail_code='no_window',
                    detail='%dms 内未找到属于进程 %d 的可见主窗口' % (ready_ms, pid))

    # 2) 消息循环响应探测（挂起窗口 SendMessageTimeout 超时——冻结循环在此现形）
    res = ctypes.c_size_t(0)
    ok = user32.SendMessageTimeoutW(main_hwnd, 0x0000, 0, 0, 0x0001 | 0x0002, 1000, ctypes.byref(res))
    if not ok:
        return bail(window_found=True, responsive=False, stable=False, closed_gracefully=False,
                    crash_dialog=[], screenshot=False, fail_code='unresponsive',
                    detail='主窗口消息循环无响应（SendMessageTimeout 1s 超时，疑似启动路径卡死）')

    # 3) 启动期错误/崩溃对话框（标题特征过滤防误报：正常模态弹窗不算）
    dlgs = error_dialogs(owned_pids())
    if dlgs:
        return bail(window_found=True, responsive=True, stable=False, closed_gracefully=False,
                    crash_dialog=dlgs, screenshot=False, fail_code='crash_dialog',
                    detail='启动过程弹出错误对话框：' + '；'.join(dlgs))

    # 4) 稳定观察期（窗口稳定存活，不闪退不消失）
    time.sleep(stable_ms / 1000.0)
    if not (user32.IsWindow(main_hwnd) and user32.IsWindowVisible(main_hwnd)):
        return bail(window_found=True, responsive=True, stable=False, closed_gracefully=False,
                    crash_dialog=[], screenshot=False, fail_code='unstable',
                    detail='主窗口在稳定观察期内消失或隐藏')

    # 5) 句柄截图（证据不是门；失败不阻塞判定）
    screenshot = False
    try:
        gdi32 = ctypes.windll.gdi32
        user32.GetWindowDC.argtypes = [wintypes.HWND]
        user32.GetWindowDC.restype = wintypes.HANDLE
        user32.PrintWindow.argtypes = [wintypes.HWND, wintypes.HANDLE, wintypes.UINT]
        user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HANDLE]
        gdi32.CreateCompatibleDC.argtypes = [wintypes.HANDLE]
        gdi32.CreateCompatibleDC.restype = wintypes.HANDLE
        gdi32.CreateCompatibleBitmap.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_int]
        gdi32.CreateCompatibleBitmap.restype = wintypes.HANDLE
        gdi32.SelectObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        gdi32.SelectObject.restype = wintypes.HANDLE
        gdi32.GetDIBits.argtypes = [wintypes.HANDLE, wintypes.HANDLE, wintypes.UINT, wintypes.UINT, ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT]
        gdi32.DeleteObject.argtypes = [wintypes.HANDLE]
        gdi32.DeleteDC.argtypes = [wintypes.HANDLE]
        r = wintypes.RECT()
        user32.GetWindowRect(main_hwnd, ctypes.byref(r))
        w, h = r.right - r.left, r.bottom - r.top
        if 0 < w <= 8192 and 0 < h <= 8192:
            hdc = user32.GetWindowDC(main_hwnd)
            memdc = gdi32.CreateCompatibleDC(hdc)
            bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
            gdi32.SelectObject(memdc, bmp)
            if user32.PrintWindow(main_hwnd, memdc, 2) or user32.PrintWindow(main_hwnd, memdc, 0):
                class BMIH(ctypes.Structure):
                    _fields_ = [('biSize', wintypes.DWORD), ('biWidth', wintypes.LONG), ('biHeight', wintypes.LONG),
                                ('biPlanes', wintypes.WORD), ('biBitCount', wintypes.WORD), ('biCompression', wintypes.DWORD),
                                ('biSizeImage', wintypes.DWORD), ('biXPelsPerMeter', wintypes.LONG), ('biYPelsPerMeter', wintypes.LONG),
                                ('biClrUsed', wintypes.DWORD), ('biClrImportant', wintypes.DWORD)]
                bmi = BMIH()
                bmi.biSize = ctypes.sizeof(BMIH); bmi.biWidth = w; bmi.biHeight = -h
                bmi.biPlanes = 1; bmi.biBitCount = 32; bmi.biCompression = 0
                buf = ctypes.create_string_buffer(w * h * 4)
                if gdi32.GetDIBits(memdc, bmp, 0, h, buf, ctypes.byref(bmi), 0):
                    from PIL import Image
                    img = Image.frombuffer('RGBA', (w, h), buf, 'raw', 'BGRA', 0, 1)
                    img.convert('RGB').save(out_png, 'PNG')
                    screenshot = True
            gdi32.DeleteObject(bmp); gdi32.DeleteDC(memdc); user32.ReleaseDC(main_hwnd, hdc)
    except Exception:
        screenshot = False

    # 6) 优雅关闭（WM_CLOSE → 等进程退出；关不掉= wont_close，宿主兜底 kill）
    user32.PostMessageW(main_hwnd, 0x0010, 0, 0)
    exited = False
    h = kernel32.OpenProcess(0x00100000, False, pid)
    if h:
        exited = kernel32.WaitForSingleObject(h, close_ms) == 0
        kernel32.CloseHandle(h)
    else:
        exited = kernel32.GetLastError() == 87  # already gone, not access denied
    if not exited:
        return bail(window_found=True, responsive=True, stable=True, closed_gracefully=False,
                    crash_dialog=[], screenshot=screenshot, fail_code='wont_close',
                    detail='WM_CLOSE 后 %dms 进程仍未退出（无法优雅关闭）' % close_ms)
    return bail(window_found=True, responsive=True, stable=True, closed_gracefully=True,
                crash_dialog=[], screenshot=screenshot)

sys.exit(main())
`

let helperPathWritten: string | undefined
async function printWindowCapture(title: string): Promise<Buffer | null> {
  const { tmpdir } = await import('node:os')
  const { randomUUID } = await import('node:crypto')
  const { existsSync, readFileSync, rmSync, unlinkSync } = await import('node:fs')
  if (!helperPathWritten) {
    helperPathWritten = join(tmpdir(), 'bloma-printwindow-capture.py')
    writeFileSync(helperPathWritten, PRINT_WINDOW_HELPER, 'utf8')
  }
  const outPng = join(tmpdir(), `bloma-launch-${randomUUID()}.png`)
  const result = await new Promise<{ code: number | null }>((resolve) => {
    const child: import('node:child_process').ChildProcess = nodeSpawn('python', [helperPathWritten as string, title, outPng], { windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill()
      resolve({ code: null })
    }, 15_000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? null })
    })
    child.once('error', () => {
      clearTimeout(timer)
      resolve({ code: null })
    })
  })
  if (result.code === 0 && existsSync(outPng)) {
    const buffer = readFileSync(outPng)
    try {
      unlinkSync(outPng)
    } catch {
      // 临时文件清理失败无害
    }
    return buffer
  }
  try {
    if (existsSync(outPng)) rmSync(outPng)
  } catch {
    // 同上
  }
  return null
}

/** 探针 stdout 解析（最后一行合法 JSON 判据；解析失败返回 null → 降级档）。 */
export function parseProbeJson(stdout: string): LaunchProbeCriteria | null {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]!) as Record<string, unknown>
      if (
        typeof obj.window_found === 'boolean' &&
        typeof obj.responsive === 'boolean' &&
        typeof obj.stable === 'boolean' &&
        typeof obj.closed_gracefully === 'boolean' &&
        Array.isArray(obj.crash_dialog)
      ) {
        return {
          window_found: obj.window_found,
          responsive: obj.responsive,
          stable: obj.stable,
          closed_gracefully: obj.closed_gracefully,
          crash_dialog: (obj.crash_dialog as unknown[]).filter((t): t is string => typeof t === 'string'),
          screenshot: obj.screenshot === true,
          ...(typeof obj.fail_code === 'string' ? { fail_code: obj.fail_code } : {}),
          ...(typeof obj.detail === 'string' ? { detail: obj.detail } : {}),
        }
      }
    } catch {
      // 尝试上一行
    }
  }
  return null
}

let probeHelperPath: string | undefined

/** 缺省探针实现：临时落盘助手脚本，系统 python 执行，看门狗兜底。 */
async function defaultRunProbe(input: ProbeRunInput): Promise<ProbeRun> {
  const { tmpdir } = await import('node:os')
  const { writeFileSync } = await import('node:fs')
  if (!probeHelperPath) {
    probeHelperPath = join(tmpdir(), 'bloma-launch-probe.py')
    writeFileSync(probeHelperPath, LAUNCH_PROBE_HELPER, 'utf8')
  }
  return await new Promise<ProbeRun>((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = nodeSpawn('python', [
      probeHelperPath as string,
      String(input.pid),
      input.title,
      input.outPng,
      String(input.readyMs),
      String(input.stableMs),
      String(input.closeMs),
    ], { windowsHide: true, signal: input.signal, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill()
      resolve({ json: null, error: `探针超时（${input.watchdogMs}ms 看门狗）` })
    }, input.watchdogMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 32_768) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 2048) stderr += chunk.toString('utf8') })
    child.once('exit', () => {
      clearTimeout(timer)
      const json = parseProbeJson(stdout)
      resolve(json !== null ? { json } : { json: null, error: stderr.trim() ? tail(stderr.trim()) : stdout.trim() ? '探针输出无法解析为判据' : '探针无输出' })
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ json: null, error: error instanceof Error ? error.message : String(error) })
    })
  })
}

function spawnCollecting(spawnImpl: (command: string[], cwd: string) => ChildProcess, command: string[], cwd: string): SpawnedChild {
  const child = spawnImpl(command, cwd)
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    if (stdout.length < 16_384) stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 16_384) stderr += chunk.toString('utf8')
  })
  return { child, get stdout() { return stdout }, get stderr() { return stderr } }
}

const tail = (text: string, max = 600): string => (text.length > max ? `…${text.slice(-max)}` : text)

/** Stop waiting as soon as the owning run ends. Late capture/probe results must
 * never save a screenshot or turn cancellation into a delivery pass. */
async function launchStep<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  signal.throwIfAborted()
  let abort!: () => void
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason ?? new Error('LAUNCH_CANCELLED'))
      signal.addEventListener('abort', abort, { once: true })
    })])
  } finally { signal.removeEventListener('abort', abort) }
}

/** 联合判定失败 → 人话 + 修复靶子。 */
function probeFailResult(criteria: LaunchProbeCriteria): LaunchSmokeResult {
  const human: Record<string, string> = {
    no_window: '启动冒烟未通过：宽限期内未出现属于该进程的可见主窗口（联合判定）',
    unresponsive: '启动冒烟未通过：主窗口消息循环无响应（窗口挂起/疑似启动路径卡死）',
    crash_dialog: `启动冒烟未通过：启动过程弹出错误对话框（${criteria.crash_dialog.join('、')}）`,
    unstable: '启动冒烟未通过：主窗口在稳定观察期内消失或隐藏',
    wont_close: '启动冒烟未通过：正常关闭指令后进程未退出（无法优雅关闭）',
  }
  const code = criteria.fail_code ?? 'unknown'
  const base = human[code] ?? `启动冒烟未通过：联合判定 ${code} 判据未满足`
  const detail = criteria.detail && !base.includes(criteria.detail) ? `${base}——${criteria.detail}` : base
  return { passed: false, detail, outputExcerpt: criteria.detail, criteria }
}

/**
 * 执行启动冒烟。
 * - 声明缺失/不合法/黑名单命中/宽限期内退出 → 不通过；
 * - 联合档（有 window_title）：探针判据全绿 → 通过（截图由探针捕获）；任一判据失败 → 不通过；
 *   探针不可用 → 降级纯存活档通过并如实标注；
 * - 纯存活档（无 window_title）：存活 → 截图（可跳过）→ kill → 通过。
 */
export async function runLaunchSmoke(rootPath: string, deps: LaunchSmokeDeps = {}): Promise<LaunchSmokeResult> {
  deps.signal?.throwIfAborted()
  const declared = readLaunchDeclaration(rootPath)
  if (declared?.ok && declared.launch.schema_version === 2 && declared.launch.ui === 'browser') {
    const { runBrowserStartup } = await import('../software/startup')
    return runBrowserStartup(rootPath, declared.launch, deps.signal)
  }
  const dataRoot = mkdtempSync(join(tmpdir(), 'bloma-launch-data-'))
  const probeController = new AbortController()
  const signal = deps.signal ? AbortSignal.any([deps.signal, probeController.signal]) : probeController.signal
  const env: Record<string, string> = { ...(declared?.ok && declared.launch.schema_version === 2 ? softwareEnvironment('launch-smoke', join(dataRoot, 'data'))
    : buildDriverEnv({ env_whitelist: ['BLOMA_SPEECH_MODEL_DIR', 'BLOMA_SPEECH_OFFLINE'] } as never, process.env)),
    APP_DATA_DIR: join(dataRoot, 'data'), PYTHONDONTWRITEBYTECODE: '1' }
  if (declared?.ok && declared.launch.schema_version === 2) {
    env.APPDATA = join(dataRoot, 'appdata'); env.LOCALAPPDATA = join(dataRoot, 'localappdata'); env.HOME = join(dataRoot, 'home'); env.USERPROFILE = env.HOME
    for (const directory of [env.APPDATA, env.LOCALAPPDATA, env.HOME]) mkdirSync(directory, { recursive: true })
  }
  let child: ChildProcess | undefined, stopping: Promise<void> | undefined
  const stop = (): Promise<void> => {
    if (stopping) return stopping
    if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve()
    const owned = child
    // Injected spawns own their process implementation; production only targets
    // the actual PID returned by our nodeSpawn call, never an enumerated process.
    stopping = process.platform === 'win32' && !deps.spawnImpl && owned.pid
      ? new Promise<void>(resolve => execFile('taskkill', ['/PID', String(owned.pid), '/T', '/F'],
        { windowsHide: true, timeout: 5000 }, () => { try { owned.kill() } catch { /* exited */ } resolve() }))
      : Promise.resolve().then(() => { try { owned.kill() } catch { /* exited */ } })
    return stopping
  }
  const abort = () => { void stop() }
  deps.signal?.addEventListener('abort', abort, { once: true })
  try {
    const result = await runOwnedLaunchSmoke(rootPath, { ...deps, signal,
      spawnImpl: (command, cwd) => {
        signal.throwIfAborted()
        const declaration = readLaunchDeclaration(rootPath)
        const resolved = declaration?.ok && declaration.launch.schema_version === 2 ? resolveSoftwareCommand(rootPath, command, env) : { command, env }
        child = (deps.spawnImpl ?? defaultSpawn)(resolved.command, cwd, resolved.env)
        return child
      } })
    deps.signal?.throwIfAborted()
    return result
  } finally {
    deps.signal?.removeEventListener('abort', abort)
    probeController.abort()
    await stop()
    try { rmSync(dataRoot, { recursive: true, force: true }) } catch { /* owned temporary data only */ }
  }
}

async function runOwnedLaunchSmoke(rootPath: string, deps: LaunchSmokeDeps): Promise<LaunchSmokeResult> {
  const declaration = readLaunchDeclaration(rootPath)
  if (declaration === null) {
    return { passed: false, detail: `启动冒烟无法执行：项目根缺少 ${LAUNCH_RELATIVE_PATH}（入口声明，任务书要求产出）` }
  }
  if (!declaration.ok) {
    return { passed: false, detail: `启动冒烟无法执行：${declaration.error}` }
  }
  let blacklistHit: string | null = null
  try { if (declaration.launch.schema_version === 2) validateSoftwareCommand(declaration.launch.command); else blacklistHit = violatesCommandBlacklist(declaration.launch.command) }
  catch (error) { blacklistHit = String(error) }
  if (blacklistHit) {
    return { passed: false, detail: `启动冒烟安全拦截：${blacklistHit}` }
  }

  const spawnImpl = deps.spawnImpl ?? defaultSpawn
  const captureWindow = deps.captureWindow ?? defaultCaptureWindow
  const graceMs = deps.graceMs ?? 4000

  let spawned: SpawnedChild
  try {
    spawned = spawnCollecting(spawnImpl, resolveDriverVenvCommand(declaration.launch.command, rootPath), rootPath)
  } catch (error) {
    if (deps.signal?.aborted) throw error
    return { passed: false, detail: `启动冒烟 spawn 失败：${error instanceof Error ? error.message : String(error)}` }
  }

  // spawn 异步错误（ENOENT 等）与退出码统一收敛：任一时刻退出/出错即失败（桌面 GUI 程序应持续存活）
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  const outcome = await launchStep(new Promise<{ kind: 'alive' } | { kind: 'exit'; code: number } | { kind: 'error'; message: string }>((resolve) => {
    let settled = false
    const settle = (value: { kind: 'alive' } | { kind: 'exit'; code: number } | { kind: 'error'; message: string }): void => {
      if (!settled) {
        settled = true
        clearTimeout(graceTimer)
        resolve(value)
      }
    }
    spawned.child.once('exit', (code) => settle({ kind: 'exit', code: code ?? -1 }))
    spawned.child.once('error', (error) => settle({ kind: 'error', message: error instanceof Error ? error.message : String(error) }))
    graceTimer = setTimeout(() => settle({ kind: 'alive' }), graceMs)
  }), deps.signal).finally(() => clearTimeout(graceTimer))
  if (outcome.kind === 'error') {
    return { passed: false, detail: `启动冒烟 spawn 失败：${outcome.message}` }
  }
  if (outcome.kind === 'exit') {
    const output = [spawned.stderr, spawned.stdout].filter(Boolean).join('\n').trim()
    if (deps.allowCleanExit && declaration.launch.mode === 'command' && outcome.code === 0) return {
      passed: true, detail: '一次性命令从正常入口执行并以0退出', outputExcerpt: output ? tail(output) : undefined,
    }
    return {
      passed: false,
      detail: `启动冒烟未通过：程序启动后 ${outcome.code === 0 ? '立即正常退出（桌面 GUI 程序应保持运行）' : `异常退出（退出码 ${outcome.code}）`}`,
      outputExcerpt: output ? tail(output) : undefined,
    }
  }

  // ══ 联合判定档（批1 2026-10-06）：有 window_title → 探针五判据 ══
  if (declaration.launch.window_title !== undefined) {
    const readyMs = deps.probeReadyMs ?? 11_000
    const stableMs = deps.probeStableMs ?? 3_000
    const closeMs = deps.probeCloseMs ?? 5_000
    const watchdogMs = deps.probeWatchdogMs ?? readyMs + stableMs + closeMs + 8_000
    const { tmpdir } = await import('node:os')
    const { randomUUID } = await import('node:crypto')
    const { existsSync, readFileSync, rmSync } = await import('node:fs')
    const outPng = join(tmpdir(), `bloma-launch-probe-${randomUUID()}.png`)

    const runProbe = deps.probeImpl ?? defaultRunProbe
    // 探针观察期内进程退出（宽限期后崩溃）→ 直接失败，输出尾部即修复靶子
    const exitDuringProbe = new Promise<number>((resolve) => {
      spawned.child.once('exit', (code) => resolve(code ?? -1))
    })
    let watchdog: ReturnType<typeof setTimeout> | undefined
    let winner: { kind: 'probe'; r: ProbeRun } | { kind: 'exit'; code: number }
    try {
      const probing = Promise.race([
        runProbe({ pid: spawned.child.pid ?? -1, title: declaration.launch.window_title, outPng, readyMs, stableMs, closeMs, watchdogMs, signal: deps.signal }),
        new Promise<ProbeRun>(resolve => { watchdog = setTimeout(() => resolve({ json: null, error: '启动探针宿主等待超时' }), watchdogMs) }),
      ])
      winner = await launchStep(Promise.race([
        probing.then((r): { kind: 'probe'; r: ProbeRun } => ({ kind: 'probe', r })),
        exitDuringProbe.then((code): { kind: 'exit'; code: number } => ({ kind: 'exit', code })),
      ]), deps.signal)
      // WM_CLOSE intentionally exits the product before the observer prints its
      // final report. Only a successful closing observation may explain exit 0.
      if (winner.kind === 'exit' && winner.code === 0) {
        const observation = await launchStep(probing, deps.signal)
        if (observation.json?.closed_gracefully) winner = { kind: 'probe', r: observation }
      }
    } finally { clearTimeout(watchdog) }

    if (winner.kind === 'exit') {
      const output = [spawned.stderr, spawned.stdout].filter(Boolean).join('\n').trim()
      return {
        passed: false,
        detail: `启动冒烟未通过：程序在联合判定观察期内退出（退出码 ${winner.code}）`,
        outputExcerpt: output ? tail(output) : undefined,
      }
    }

    const persistProbeScreenshot = (): string | undefined => {
      try {
        if (winner.r.json?.screenshot && existsSync(outPng)) {
          const abs = join(rootPath, SMOKE_SCREENSHOT_RELATIVE_PATH)
          mkdirSync(join(abs, '..'), { recursive: true })
          writeFileSync(abs, readFileSync(outPng))
          try { rmSync(outPng) } catch { /* 临时文件清理失败无害 */ }
          return SMOKE_SCREENSHOT_RELATIVE_PATH
        }
      } catch {
        // 截图失败不阻塞冒烟结论（截图是呈现层证据不是可用性门——同任务书截图约定）
      }
      return undefined
    }

    if (winner.r.json === null) {
      // 探针不可用 → 降级纯存活档：如实标注「未执行联合判定」（不误杀，不伪装成已检查）
      let degradedShot: string | undefined
      try {
        const png = await launchStep(captureWindow(declaration.launch.window_title), deps.signal)
        if (png && png.length > 0) {
          const abs = join(rootPath, SMOKE_SCREENSHOT_RELATIVE_PATH)
          mkdirSync(join(abs, '..'), { recursive: true })
          writeFileSync(abs, png)
          degradedShot = SMOKE_SCREENSHOT_RELATIVE_PATH
        }
      } catch {
        deps.signal?.throwIfAborted()
        // 截图失败无害
      }
      return {
        passed: true,
        detail: `启动冒烟通过（降级判定：联合探针不可用——${winner.r.error ?? '未知原因'}，仅验证进程存活${degradedShot ? `，截图已存 ${degradedShot}` : ''}；窗口可用性未验证）`,
        criteria: {
          window_found: false, responsive: false, stable: false, closed_gracefully: false,
          crash_dialog: [], screenshot: degradedShot !== undefined,
          degraded: true, detail: `探针不可用：${winner.r.error ?? '未知原因'}`,
        },
        ...(degradedShot ? { screenshotRel: degradedShot } : {}),
      }
    }

    const criteria = winner.r.json
    if (criteria.fail_code !== undefined || !criteria.window_found || !criteria.responsive || !criteria.stable || !criteria.closed_gracefully || criteria.crash_dialog.length > 0) {
      if (criteria.fail_code === undefined) {
        // 探针未给 fail_code 但判据不全绿（防御：按缺失面定位）
        const missing: string[] = []
        if (!criteria.window_found) missing.push('window_found')
        if (!criteria.responsive) missing.push('responsive')
        if (!criteria.stable) missing.push('stable')
        if (!criteria.closed_gracefully) missing.push('closed_gracefully')
        if (criteria.crash_dialog.length > 0) missing.push(`crash_dialog(${criteria.crash_dialog.join('、')})`)
        criteria.fail_code = missing[0] === 'crash_dialog' ? 'crash_dialog' : (missing[0] ?? 'unknown')
      }
      return probeFailResult(criteria)
    }

    // 全判据通过：探针截图（稳定期后、关闭前捕获）落 00_VERIFY
    const screenshotRel = persistProbeScreenshot()
    return {
      passed: true,
      detail: `启动冒烟通过（联合判定）：窗口可见、消息循环响应、稳定 ${Math.round(stableMs / 1000)}s、可正常关闭${screenshotRel ? `；截图已存 ${screenshotRel}` : ''}`,
      criteria,
      ...(screenshotRel ? { screenshotRel } : {}),
    }
  }

  // ══ 纯存活档（无 window_title，旧行为）：存活 → 截图（可跳过）→ kill → 通过 ══
  let screenshotRel: string | undefined
  try {
    const png = await launchStep(captureWindow(declaration.launch.window_title), deps.signal)
    if (png && png.length > 0) {
      const abs = join(rootPath, SMOKE_SCREENSHOT_RELATIVE_PATH)
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, png)
      screenshotRel = SMOKE_SCREENSHOT_RELATIVE_PATH
    }
  } catch {
    deps.signal?.throwIfAborted()
    // 截图失败不阻塞冒烟结论（截图是呈现层证据不是可用性门——同任务书截图约定）
  }
  return {
    passed: true,
    detail: screenshotRel
      ? `启动冒烟通过：程序存活，窗口截图已存 ${screenshotRel}`
      : '启动冒烟通过：程序存活（未匹配到可截窗口，跳过截图）',
    ...(screenshotRel ? { screenshotRel } : {}),
  }
}
