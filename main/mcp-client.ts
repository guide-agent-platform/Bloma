// MCP stdio 客户端（mcp-support-port r70 转正）——真实子进程全生命周期。
// 信源：enhancements/prototype/mcp-stdio-prototype.ts（8/8）+ Proma agent-queue/validator 蓝本。
//
// 核心语义：id 关联的请求/响应、L-DJSON 解析（容忍非 JSON 行）、initialize 握手、
// tools/list、tools/call 内容提取+isError、stderr 分流、超时兜底、dispose 杀子进程。
//
// 三陷阱（原型实证，测试 S4-MCP-001/010/008 + 变异锁定）：
// ① 通知判定按「无 id」而非「有 method」——请求也带 method，判错则所有请求被当通知吞掉
// ② L-DJSON 必须跳过非 JSON 行——server 横幅/日志混在 stdout 会污染协议流
// ③ Windows kill() 后 exit code=null + signal=SIGTERM——清理语义是「code 或 signal 任一」

import { spawn, type ChildProcess } from 'node:child_process'

type JsonRpcId = number | string

interface PendingEntry {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: string
}

export interface McpToolInfo {
  name: string
  description: string
}

export interface McpToolCallResult {
  text: string
  isError: boolean
}

export class MiniMcpClient {
  private proc: ChildProcess
  private nextId = 1
  private readonly pending = new Map<JsonRpcId, PendingEntry>()
  private readonly stderrBuf: string[] = []
  private buffer = ''
  private disposed = false

  private readonly timeoutMs: number

  constructor(serverPath: string, timeoutMs = 3000) {
    this.timeoutMs = timeoutMs
    this.proc = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdout?.setEncoding('utf8')
    this.proc.stdout?.on('data', (chunk: string) => this.onStdout(chunk))
    this.proc.stderr?.setEncoding('utf8')
    this.proc.stderr?.on('data', (c: string) => this.stderrBuf.push(c))
    // server 提前退出：所有在途请求立即失败（不留悬挂 promise）
    this.proc.once('exit', () => {
      for (const [, e] of this.pending) {
        clearTimeout(e.timer)
        e.reject(new Error(`[${e.method}] server 进程已退出`))
      }
      this.pending.clear()
    })
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      let msg: { id?: JsonRpcId; result?: unknown; error?: { message: string } }
      try {
        msg = JSON.parse(line)
      } catch {
        continue // 陷阱②：垃圾行跳过（server 横幅/日志），不污染协议流
      }
      // 陷阱①：通知判定按「无 id」——请求也带 method，按 method 判会把所有请求当通知吞掉
      if (msg.id === undefined) continue
      const entry = this.pending.get(msg.id)
      if (!entry) continue
      clearTimeout(entry.timer)
      this.pending.delete(msg.id)
      if (msg.error) entry.reject(new Error(`[${entry.method}] ${msg.error.message}`))
      else entry.resolve(msg.result)
    }
    // 防御（R1 deepseek P2，R2 aliyun 细化采纳）：完整行已全部解析消费后才检查残余——
    // 残余无换行超限必为垃圾洪流（合法 JSON-RPC 行不会 >1MB），整段丢弃；
    // 若先检查后解析会误丢「合法行+未完成尾部」混合场景
    if (this.buffer.length > 1_000_000) {
      console.warn('[mcp-client] stdout 残余 buffer 超限（>1MB 无换行），整段丢弃')
      this.buffer = ''
    }
  }

  private request<T>(method: string, params?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`[${method}] 超时 ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method })
      this.proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  private notify(method: string): void {
    this.proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n')
  }

  async initialize(): Promise<{ protocolVersion: string; serverInfo: { name: string; version?: string } }> {
    const res = await this.request<{ protocolVersion: string; serverInfo: { name: string; version?: string } }>('initialize', {
      protocolVersion: '2025-06-18',
      clientInfo: { name: 'bloma-mini-mcp', version: '0.1' },
      capabilities: {},
    })
    this.notify('notifications/initialized')
    return res
  }

  listTools(): Promise<{ tools: McpToolInfo[] }> {
    return this.request('tools/list')
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const res = await this.request<{ content?: { type: string; text: string }[]; isError?: boolean }>('tools/call', {
      name,
      arguments: args,
    })
    return { text: res.content?.map((c) => c.text).join('') ?? '', isError: res.isError === true }
  }

  stderrSoFar(): string {
    return this.stderrBuf.join('')
  }

  /** 杀掉子进程并拒绝所有在途请求。幂等（二次调用安全）。 */
  dispose(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.disposed) return Promise.resolve({ code: null, signal: null })
    this.disposed = true
    for (const [, e] of this.pending) {
      clearTimeout(e.timer)
      e.reject(new Error('客户端已关闭'))
    }
    this.pending.clear()
    return new Promise((resolve) => {
      const done = (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal })
      if (this.proc.exitCode !== null || this.proc.signalCode) {
        done(this.proc.exitCode, this.proc.signalCode as NodeJS.Signals | null)
        return
      }
      this.proc.once('exit', done)
      this.proc.kill()
    })
  }
}
