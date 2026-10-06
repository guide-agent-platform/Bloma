/**
 * drive_project_app webview 腿（批8 下半，2026-10-06）——骨架 v2 产物的探索驱动通道。
 *
 * 协议（骨架 app.py --drive-port 已内置，spike 七项实测背书
 * 《Bloma-pywebview渲染层spike-20261006.md》）：
 *   spawn `<venv-python> app.py --drive-port <N>` → stdout 出现 `DRIVE_SERVER 127.0.0.1:N`
 *   → POST /call {"op","args"} 直调 Api 桥（逻辑层状态观察）
 *   → POST /eval {"js"} 同步 DOM JS（act 模拟 click/输入、read DOM 序列化）
 *   → close = taskkill 进程树（WebView2 子进程随树终止）。
 *
 * 关键实测口径（进协议设计，勿凭直觉改）：
 * - evaluate_js 不 await Promise——/eval 只收同步表达式；异步桥调用（App.call）必须走 /call；
 * - pywebview api 调用到达非主线程、UI 线程被模态阻塞时 evaluate_js 挂死——
 *   工具侧动词超时即杀会话（现象=高价值发现，与 tkinter 腿同语义）；
 * - 窗口 hidden 驻留（骨架行为），DOM/桥照常（spike 项④）。
 */
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'

export const WEBVIEW_LOG_TAIL_CHARS = 2_000
const MAX_READ_FILE_BYTES = 64_000
const MAX_LIST_ENTRIES = 500
const MAX_LIST_DEPTH = 3
const SKIP_DIRS = new Set(['.venv', '__pycache__', '.git', 'node_modules', 'archive', '00_VERIFY'])

/** 预留一个本机空闲端口（listen(0) 取号即释放；与骨架 spawn 之间有极小竞窗，调用方可重试）。 */
export function reserveDrivePort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer()
    server.unref()
    server.on('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => (port > 0 ? resolvePromise(port) : rejectPromise(new Error('未能取得空闲端口'))))
    })
  })
}

/** POST JSON 到骨架控制服务器；超时/网络错误 reject（调用方决定杀会话）。 */
export function webviewPost(port: number, path: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          try {
            resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
          } catch {
            rejectPromise(new Error('控制服务器响应不是合法 JSON（协议行损坏）'))
          }
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error(`控制服务器 ${path} 超时（>${Math.round(timeoutMs / 1000)}s）——UI 线程可能被模态阻塞或死循环`)))
    req.on('error', (error: Error) => rejectPromise(error))
    req.end(payload)
  })
}

/** 从 stdout 行识别 DRIVE_SERVER 就绪行；非就绪行原文返回给调用方归档。 */
export function matchDriveServerLine(line: string): { port: number } | null {
  const match = /^DRIVE_SERVER\s+127\.0\.0\.1:(\d+)\s*$/.exec(line.trim())
  return match ? { port: Number(match[1]) } : null
}

// ── DOM JS 构造（全部同步表达式——evaluate_js 不 await Promise）──────────────

/** click（按元素 id）：找不到元素返回 {found:false}（工具侧如实上抛探索者）。 */
export function webviewClickJs(elementId: string): string {
  return (
    `(function(){var el=document.getElementById(${JSON.stringify(elementId)});` +
    'if(!el){return{found:false};}el.click();return{found:true};})()'
  )
}

/** set_text（按元素 id）：赋值并派发 input/change 事件（框架与原生监听都触发）。 */
export function webviewSetTextJs(elementId: string, value: string): string {
  return (
    `(function(){var el=document.getElementById(${JSON.stringify(elementId)});` +
    `if(!el){return{found:false};}el.value=${JSON.stringify(value)};` +
    'el.dispatchEvent(new Event("input",{bubbles:true}));' +
    'el.dispatchEvent(new Event("change",{bubbles:true}));return{found:true};})()'
  )
}

/**
 * read 缺省 DOM 快照（同步；体积有界）：标题/桥就绪/状态条/输入组/按钮/列表行/
 * 气泡尾 8 条/徽章/内容区文本摘要——覆盖骨架组件库全部呈现面（探索体验核对的读源）。
 */
export const WEBVIEW_DOM_SNAPSHOT_JS =
  '(function(){var out={title:document.title,bridge_ready:!!(window.pywebview&&pywebview.api)};' +
  'var b=document.querySelector(".w-banner");' +
  'out.banner=b?{state:b.getAttribute("data-state")||null,text:String(b.innerText||"").slice(0,120)}:null;' +
  'out.inputs=Array.prototype.slice.call(document.querySelectorAll("input,textarea,select")).map(function(el){' +
  'return{id:el.id||null,value:String(el.value||"").slice(0,80),disabled:el.disabled}});' +
  'out.buttons=Array.prototype.slice.call(document.querySelectorAll("button")).map(function(el){' +
  'return{id:el.id||null,text:String(el.innerText||"").slice(0,40),disabled:el.disabled}});' +
  'out.rows=Array.prototype.slice.call(document.querySelectorAll(".w-row")).map(function(r){' +
  'return{id:r.getAttribute("data-id"),text:String(r.innerText||"").slice(0,60)}});' +
  'out.bubbles=Array.prototype.slice.call(document.querySelectorAll(".w-bubble")).slice(-8).map(function(x){' +
  'return{side:x.getAttribute("data-side"),text:String(x.innerText||"").slice(0,80)}});' +
  'out.content_text=String((document.getElementById("content")||document.body).innerText||"").replace(/\\s+/g," ").slice(0,400);' +
  'return out;})()'

// ── 文件读动词（webview 腿无 harness 进程内实现——工具侧直读项目根，与 tk 腿同界）──

export function webviewListFiles(projectRoot: string): { files: Array<{ path: string; size: number; mtime: number }>; truncated: boolean } {
  const rootDir = realpathSync(projectRoot)
  const entries: Array<{ path: string; size: number; mtime: number }> = []
  const visit = (directory: string, depth: number): void => {
    if (depth > MAX_LIST_DEPTH || entries.length >= MAX_LIST_ENTRIES) return
    let names: string[]
    try {
      names = readdirSync(directory).sort()
    } catch {
      return
    }
    for (const name of names) {
      if (entries.length >= MAX_LIST_ENTRIES) return
      const full = join(directory, name)
      const rel = full.slice(rootDir.length + 1).replace(/\\/g, '/')
      let info
      try {
        info = statSync(full)
      } catch {
        continue
      }
      entries.push({ path: rel, size: info.size, mtime: Math.trunc(info.mtimeMs) })
      if (info.isDirectory() && !SKIP_DIRS.has(name)) visit(full, depth + 1)
    }
  }
  visit(rootDir, 0)
  return { files: entries, truncated: entries.length >= MAX_LIST_ENTRIES }
}

export function webviewReadFile(projectRoot: string, relPath: string): { path: string; content: string; truncated: boolean } | { error: string } {
  const rootDir = realpathSync(projectRoot)
  let target: string
  try {
    target = realpathSync(join(rootDir, relPath))
  } catch {
    return { error: `读取失败 ${relPath}：文件不存在` }
  }
  if (!target.startsWith(rootDir + '\\') && !target.startsWith(rootDir + '/')) {
    return { error: `read_file 只开放项目根内相对路径（收到 ${relPath}）` }
  }
  try {
    const content = readFileSync(target, 'utf8').slice(0, MAX_READ_FILE_BYTES)
    return { path: relPath, content, truncated: content.length >= MAX_READ_FILE_BYTES }
  } catch (error) {
    return { error: `读取失败 ${relPath}：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 终止进程树（Windows：taskkill /T 连带 WebView2 子进程；失败回退 kill 由调用方兜底）。 */
export function killWebviewProcessTree(pid: number | undefined, fallbackKill: () => void): void {
  if (pid && process.platform === 'win32') {
    try {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {
        /* 树内进程已尽力终止；残余由 exit 监听兜底 */
      })
      setTimeout(fallbackKill, 150)
      return
    } catch {
      // 落 fallback
    }
  }
  fallbackKill()
}
