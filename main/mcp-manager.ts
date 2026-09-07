// MCP server 生命周期管理器（mcp-support-port 第二步，2026-08-29 r71）
// 信源：mcp-support-port.md §三.2（Proma mcp-validator 蓝本）+ MiniMcpClient（r70 转正）。
//
// 职责：
// 1. validateMcpCommand：spawn 前命令存在性检查（Proma 式 validator——坏配置不炸运行时；
//    教学向约定=绝对路径或 node 自身，相对 PATH 命令不在 Bloma 威胁模型内，直接拒绝）
// 2. McpServerManager：启动（initialize+listTools 健康）→ 进程崩溃自动重启 1 次 →
//    二次崩溃 degraded（标记+onDegraded 钩子，agent loop 不中断）；callTool 委托/degraded 拒绝
//
// 范围声明（r71 收窄）：桥接 agent-tools 与 IPC 设置面下轮；http/sse 传输 P2。

import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { MiniMcpClient } from './mcp-client'

export interface McpServerConfig {
  serverId: string
  command: string
  args: string[]
}

export interface McpManagerOptions {
  timeoutMs?: number
  /** server 降级（validator 拒绝/重启上限耗尽）钩子：reason 含 validate|crash|spawn */
  onDegraded?: (serverId: string, reason: string) => void
}

export type McpServerState = 'starting' | 'healthy' | 'restarting' | 'degraded'

export interface McpServerStatus {
  serverId: string
  state: McpServerState
  toolNames: string[]
  restarts: number
}

/** 崩溃重启上限：1 次（二次崩溃=持续性故障，重启无意义，转 degraded） */
const MAX_RESTARTS = 1
/** 重启间隔：给端口释放/资源回收留出时间 */
const RESTART_DELAY_MS = 300

/**
 * Proma 式 validator：P1 命令语义 = node 脚本绝对路径（.mjs/.js/.cjs，教学向精选目录约定）。
 * 返回 {ok, reason}——拒绝理由面向日志与 onDegraded，不抛错（坏配置是常态输入）。
 */
export function validateMcpCommand(config: McpServerConfig): { ok: boolean; reason?: string } {
  const { command } = config
  if (!isAbsolute(command)) return { ok: false, reason: `validate: 相对路径 ${command} 不允许（须绝对路径）` }
  if (!/\.(mjs|js|cjs)$/i.test(command)) return { ok: false, reason: `validate: 仅支持 node 脚本（.mjs/.js/.cjs），收到 ${command}` }
  if (!existsSync(command)) return { ok: false, reason: `validate: 脚本不存在 ${command}` }
  return { ok: true }
}

export class McpServerManager {
  private readonly clients = new Map<string, MiniMcpClient>()
  private readonly toolNames = new Map<string, string[]>()
  private readonly states = new Map<string, McpServerState>()
  private readonly restarts = new Map<string, number>()
  /** 停止抑制（R1 P1 竞态修复）：用户显式 stop 后，迟到 exit 事件不得触发重启 */
  private readonly stopped = new Set<string>()
  /** 已知失败待回收的半开 client（R1 P1 孤儿修复）：其 exit 事件不触发 handleExit */
  private readonly suppressExit = new Set<MiniMcpClient>()
  private readonly opts: Required<Pick<McpManagerOptions, 'timeoutMs'>> & McpManagerOptions

  constructor(options: McpManagerOptions = {}) {
    this.opts = { timeoutMs: 3000, ...options }
  }

  getStatus(serverId: string): McpServerStatus | undefined {
    const state = this.states.get(serverId)
    if (!state) return undefined
    return { serverId, state, toolNames: this.toolNames.get(serverId) ?? [], restarts: this.restarts.get(serverId) ?? 0 }
  }

  /** 启动 server：validator → spawn+健康（initialize+listTools）→ 失败重试 1 次 → degraded */
  async startServer(config: McpServerConfig): Promise<McpServerStatus> {
    const { serverId } = config
    this.stopped.delete(serverId) // 重新启用同一 serverId：清除历史停止抑制（R2 aliyun 残余）
    this.states.set(serverId, 'starting')
    const validation = validateMcpCommand(config)
    if (!validation.ok) {
      this.markDegraded(serverId, validation.reason!)
      return this.getStatus(serverId)!
    }
    const ok = await this.spawnAndProbe(config)
    if (ok) {
      this.states.set(serverId, 'healthy')
      return this.getStatus(serverId)!
    }
    // 首次启动失败：重试 1 次（瞬时资源竞争容错），仍失败 degraded
    await delay(RESTART_DELAY_MS)
    const retry = await this.spawnAndProbe(config)
    if (retry) {
      this.states.set(serverId, 'healthy')
      return this.getStatus(serverId)!
    }
    this.markDegraded(serverId, 'spawn: 启动与健康检查两次失败')
    return this.getStatus(serverId)!
  }

  /** 委托 healthy server 调用工具；degraded/未注册拒绝（错误可捕获，调用方不炸） */
  async callTool(serverId: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const client = this.clients.get(serverId)
    if (!client || this.states.get(serverId) !== 'healthy') {
      throw new Error(`[mcp-manager] server ${serverId} 不可用（degraded 或未注册）`)
    }
    return client.callTool(name, args)
  }

  async stopServer(serverId: string): Promise<void> {
    this.stopped.add(serverId) // 停止意图优先：迟到 exit 不重启（S4-MCP-018）
    const client = this.clients.get(serverId)
    this.clients.delete(serverId)
    this.states.delete(serverId)
    if (client) await client.dispose().catch(() => undefined)
  }

  async disposeAll(): Promise<void> {
    for (const id of [...this.clients.keys()]) {
      await this.stopServer(id).catch(() => undefined)
    }
  }

  /**
   * 测试钩子：模拟 server 进程被外部 kill（不走 dispose 语义），
   * 触发与真实崩溃一致的退出→重启/degraded 路径。
   */
  crashForTests(serverId: string): void {
    this.clients.get(serverId)?.simulateExitForTests()
  }

  private markDegraded(serverId: string, reason: string): void {
    this.states.set(serverId, 'degraded')
    this.opts.onDegraded?.(serverId, reason)
  }

  private async spawnAndProbe(config: McpServerConfig): Promise<boolean> {
    const { serverId, command } = config
    let client: MiniMcpClient | undefined
    try {
      client = new MiniMcpClient(command, this.opts.timeoutMs)
      client.onExit(() => {
        // 孤儿回收抑制（R1 P1）：已知失败的半开 client 被 dispose 时，其 exit 不触发 handleExit
        if (this.suppressExit.has(client!)) return
        void this.handleExit(serverId, config)
      })
      this.clients.set(serverId, client)
      await client.initialize()
      const tools = await client.listTools()
      this.toolNames.set(serverId, tools.tools.map((t) => t.name))
      return true
    } catch (err) {
      // 健康检查失败：半开 client 回收（dispose），抑制其 exit 叠加重启（R1 P1 孤儿修复）
      this.clients.delete(serverId)
      if (client) {
        this.suppressExit.add(client)
        void client.dispose().catch(() => undefined)
      }
      console.warn(`[mcp-manager] server ${serverId} 健康检查失败:`, err instanceof Error ? err.message : String(err))
      return false
    }
  }

  private async handleExit(serverId: string, config: McpServerConfig): Promise<void> {
    if (this.stopped.has(serverId)) return // 停止意图优先：迟到 exit 不重启（S4-MCP-018）
    if (this.states.get(serverId) === 'degraded') return
    this.clients.delete(serverId)
    const count = (this.restarts.get(serverId) ?? 0) + 1
    if (count > MAX_RESTARTS) {
      this.markDegraded(serverId, `crash: 重启 ${MAX_RESTARTS} 次后再次退出，转降级`)
      return
    }
    this.restarts.set(serverId, count)
    this.states.set(serverId, 'restarting')
    await delay(RESTART_DELAY_MS)
    const ok = await this.spawnAndProbe(config)
    if (ok) {
      this.states.set(serverId, 'healthy')
    } else {
      this.markDegraded(serverId, `crash: 重启后健康检查失败（第 ${count} 次）`)
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
