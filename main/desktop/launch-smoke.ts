/**
 * launch-smoke — quick 直通道「启动冒烟 + UI 截图」（2026-10-04 呈现层收口批）。
 *
 * 事故背书（10-04 凌晨狗粮 f896b314）：交付物 calculator.py 无头自测全对，但 GUI
 * 启动即崩（tkinter Frame pady 元组）——quick 豁免了驱动/截图，没有任何环节真正
 * 启动过程序；用户视角「沙箱空的、连 UI 确认都没有」。
 *
 * 机制（声明制，与契约同哲学）：
 * - 子会话按任务书写 LAUNCH.json 到项目根（schema_version/command/window_title）；
 * - 宿主在 quick 直落 delivered 前真实 spawn 一次：宽限期内退出（任意码）= 冒烟失败
 *   （stdout/stderr 尾部回传给修复轮——昨晚的 TclError 会被这关当场截获）；存活 =
 *   截取窗口图（window_title 匹配，desktopCapturer）落 00_VERIFY/screenshots/LAUNCH.png
 *   （刀3 白名单路径，delivered 卡与产物条自动呈现）→ kill 收尾；
 * - 命令过 contract-schema 黑名单（纵深防御，安全门已扫产物仍复检入口）。
 *
 * 依赖注入：spawn/capture/grace 均可注入（单测零 electron 依赖，陷阱 35）。
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { violatesCommandBlacklist } from './contract-schema'

/** 入口声明文件（项目根相对）。 */
export const LAUNCH_RELATIVE_PATH = 'LAUNCH.json'

/** 冒烟截图落点（刀3 产物白名单目录，png 直显）。 */
export const SMOKE_SCREENSHOT_RELATIVE_PATH = '00_VERIFY/screenshots/LAUNCH.png'

export interface LaunchDeclaration {
  command: string[]
  /** GUI 窗口标题提示（截图窗口匹配；缺省跳过截图只做存活判定） */
  window_title?: string
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
  if (obj.schema_version !== 1) {
    return { ok: false, error: `LAUNCH.json schema_version 须为数字 1（收到 ${JSON.stringify(obj.schema_version)}）` }
  }
  const command = obj.command
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== 'string' || part.length === 0)) {
    return { ok: false, error: 'LAUNCH.json command 须为非空字符串数组（如 ["python","calculator.py"]）' }
  }
  const windowTitle = obj.window_title
  if (windowTitle !== undefined && typeof windowTitle !== 'string') {
    return { ok: false, error: 'LAUNCH.json window_title 须为字符串（窗口标题提示，可省略）' }
  }
  return { ok: true, launch: { command, ...(windowTitle !== undefined ? { window_title: windowTitle } : {}) } }
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

export interface LaunchSmokeResult {
  passed: boolean
  /** 人话摘要（人话卡与决策日志用） */
  detail: string
  /** 失败时的 stderr/stdout 尾部（修复轮靶子） */
  outputExcerpt?: string
  /** 截图落点（passed 且截图成功时） */
  screenshotRel?: string
}

export interface LaunchSmokeDeps {
  /** 注入 spawn（缺省 nodeSpawn 包装）；测试用 */
  spawnImpl?: (command: string[], cwd: string) => ChildProcess
  /** 注入窗口截图（缺省 desktopCapturer 懒加载实现）；返回 png Buffer 或 null（无匹配窗口） */
  captureWindow?: (titleHint: string | undefined) => Promise<Buffer | null>
  /** 存活宽限毫秒（缺省 4000） */
  graceMs?: number
}

interface SpawnedChild {
  child: ChildProcess
  stdout: string
  stderr: string
}

function defaultSpawn(command: string[], cwd: string): ChildProcess {
  // windowsHide 隐藏控制台宿主；GUI 窗口（tkinter 等）不受影响照常弹出
  return nodeSpawn(command[0]!, command.slice(1), { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
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

/**
 * 执行启动冒烟。入口声明缺失/不合法/黑名单命中/宽限期内退出 → 不通过；
 * 存活 → 截图（可跳过）→ kill → 通过。
 */
export async function runLaunchSmoke(rootPath: string, deps: LaunchSmokeDeps = {}): Promise<LaunchSmokeResult> {
  const declaration = readLaunchDeclaration(rootPath)
  if (declaration === null) {
    return { passed: false, detail: `启动冒烟无法执行：项目根缺少 ${LAUNCH_RELATIVE_PATH}（入口声明，任务书要求产出）` }
  }
  if (!declaration.ok) {
    return { passed: false, detail: `启动冒烟无法执行：${declaration.error}` }
  }
  const blacklistHit = violatesCommandBlacklist(declaration.launch.command)
  if (blacklistHit) {
    return { passed: false, detail: `启动冒烟安全拦截：${blacklistHit}` }
  }

  const spawnImpl = deps.spawnImpl ?? defaultSpawn
  const captureWindow = deps.captureWindow ?? defaultCaptureWindow
  const graceMs = deps.graceMs ?? 4000

  let spawned: SpawnedChild
  try {
    spawned = spawnCollecting(spawnImpl, declaration.launch.command, rootPath)
  } catch (error) {
    return { passed: false, detail: `启动冒烟 spawn 失败：${error instanceof Error ? error.message : String(error)}` }
  }

  // spawn 异步错误（ENOENT 等）与退出码统一收敛：任一时刻退出/出错即失败（桌面 GUI 程序应持续存活）
  const outcome = await new Promise<{ kind: 'alive' } | { kind: 'exit'; code: number } | { kind: 'error'; message: string }>((resolve) => {
    let settled = false
    const settle = (value: { kind: 'alive' } | { kind: 'exit'; code: number } | { kind: 'error'; message: string }): void => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    spawned.child.once('exit', (code) => settle({ kind: 'exit', code: code ?? -1 }))
    spawned.child.once('error', (error) => settle({ kind: 'error', message: error instanceof Error ? error.message : String(error) }))
    setTimeout(() => settle({ kind: 'alive' }), graceMs)
  })
  if (outcome.kind === 'error') {
    return { passed: false, detail: `启动冒烟 spawn 失败：${outcome.message}` }
  }
  if (outcome.kind === 'exit') {
    const output = [spawned.stderr, spawned.stdout].filter(Boolean).join('\n').trim()
    return {
      passed: false,
      detail: `启动冒烟未通过：程序启动后 ${outcome.code === 0 ? '立即正常退出（桌面 GUI 程序应保持运行）' : `异常退出（退出码 ${outcome.code}）`}`,
      outputExcerpt: output ? tail(output) : undefined,
    }
  }

  // 存活 → 截图 → kill → 通过
  let screenshotRel: string | undefined
  try {
    const png = await captureWindow(declaration.launch.window_title)
    if (png && png.length > 0) {
      const abs = join(rootPath, SMOKE_SCREENSHOT_RELATIVE_PATH)
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, png)
      screenshotRel = SMOKE_SCREENSHOT_RELATIVE_PATH
    }
  } catch {
    // 截图失败不阻塞冒烟结论（截图是呈现层证据不是可用性门——同任务书截图约定）
  }
  try {
    spawned.child.kill()
  } catch {
    // kill 失败（进程已自行退出等）不影响结论
  }
  return {
    passed: true,
    detail: screenshotRel
      ? `启动冒烟通过：程序存活，窗口截图已存 ${screenshotRel}`
      : '启动冒烟通过：程序存活（未匹配到可截窗口，跳过截图）',
    ...(screenshotRel ? { screenshotRel } : {}),
  }
}
