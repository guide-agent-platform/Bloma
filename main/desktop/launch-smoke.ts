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
  // 懒加载 electron（陷阱 35：被单测 import 的模块勿静态依赖 electron）；局部 require 遮蔽
  // + createRequire（同 safe-storage 先例）——esbuild 不重写局部 require，运行期原生解析
  // thumbnailSize 是「适配盒」不是目标尺寸：给大盒子（3840×2400）拿窗口物理原分辨率，
  // 小窗口不会被放大；旧值 1280×800 在高分屏（本机 2560×1600 物理 @150%）上把截图
  // 下采样到一半分辨率——「截图发糊」的根因，与 Python/tkinter 无关。
  try {
    const require = createRequire(import.meta.url)
    const { desktopCapturer } = require('electron') as typeof import('electron')
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
