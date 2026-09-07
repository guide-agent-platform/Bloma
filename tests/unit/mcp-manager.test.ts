import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpServerManager, validateMcpCommand, type McpManagerOptions } from '../../main/mcp-manager'

/**
 * MCP server 生命周期管理器（mcp-support-port 第二步，r71）：
 * Proma 式 validator——spawn 前命令存在性检查，坏配置不炸运行时；
 * 生命周期——启动（initialize+listTools 健康）→ 进程崩溃自动重启 1 次 → 二次崩溃 degraded
 * （标记 + onDegraded 钩子，agent loop 不中断）。callTool 委托 healthy server；degraded 拒绝。
 */

const FAKE_SERVER = fileURLToPath(new URL('../support/fake-mcp-server.mjs', import.meta.url))

const managers: McpServerManager[] = []
function makeManager(opts?: McpManagerOptions) {
  const m = new McpServerManager(opts)
  managers.push(m)
  return m
}

afterEach(async () => {
  for (const m of managers.splice(0)) {
    await m.disposeAll().catch(() => undefined)
  }
})

describe('validateMcpCommand（Proma 式 validator）', () => {
  it('[S4-MCP-012] 脚本存在性：node 脚本（.mjs/.js/.cjs）存在 OK；不存在/非脚本扩展/相对路径拒绝', () => {
    expect(validateMcpCommand({ serverId: 'a', command: FAKE_SERVER, args: [] }).ok).toBe(true)
    const noFile = validateMcpCommand({ serverId: 'a', command: join(tmpdir(), 'no-such.mjs'), args: [] })
    expect(noFile.ok).toBe(false)
    expect(noFile.reason).toContain('不存在')
    const badExt = validateMcpCommand({ serverId: 'a', command: 'C:/no/such/server.exe', args: [] })
    expect(badExt.ok).toBe(false)
    const rel = validateMcpCommand({ serverId: 'a', command: 'some-rel-command.mjs', args: [] })
    expect(rel.ok).toBe(false)
  })
})

describe('McpServerManager 生命周期（真实子进程）', () => {
  it('[S4-MCP-013] startServer：健康启动（initialize+listTools）→ healthy + 工具名清单', async () => {
    const m = makeManager({ timeoutMs: 5000 })
    const st = await m.startServer({ serverId: 's1', command: FAKE_SERVER, args: [] })
    expect(st.state).toBe('healthy')
    expect(st.toolNames).toEqual(['echo', 'fail'])
    expect(st.restarts).toBe(0)
  })

  it('[S4-MCP-014] 故障注入：命令不存在 → degraded（不抛、onDegraded 回调、reason=validate）', async () => {
    const onDegraded = vi.fn()
    const m = makeManager({ timeoutMs: 5000, onDegraded })
    const st = await m.startServer({ serverId: 'bad', command: join(tmpdir(), 'no-such-server.mjs'), args: [] })
    expect(st.state).toBe('degraded')
    expect(onDegraded).toHaveBeenCalledTimes(1)
    expect(onDegraded.mock.calls[0][1]).toContain('validate')
  })

  it('[S4-MCP-015] 崩溃重启：运行中被 kill → 自动重启 1 次 → healthy（restarts=1）', async () => {
    const m = makeManager({ timeoutMs: 5000 })
    await m.startServer({ serverId: 's2', command: FAKE_SERVER, args: [] })
    m.crashForTests('s2') // 测试钩子：模拟 server 进程被外部 kill
    // 重启窗口内（restarting 态）：callTool 被健康门拒绝（非 healthy 不可用，M5 变异杀死点）
    let gateRejected = false
    const deadline0 = Date.now() + 2000
    while (Date.now() < deadline0) {
      const st = m.getStatus('s2')
      if (st?.state === 'restarting') {
        await expect(m.callTool('s2', 'echo', {})).rejects.toThrow(/不可用/)
        gateRejected = true
        break
      }
      if (st?.state === 'healthy') break // 极快环境下窗口已过
      await new Promise((r) => setTimeout(r, 50))
    }
    void gateRejected
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const st = m.getStatus('s2')
      if (st?.state === 'healthy' && st.restarts === 1) break
      await new Promise((r) => setTimeout(r, 100))
    }
    const st = m.getStatus('s2')
    expect(st?.state).toBe('healthy')
    expect(st?.restarts).toBe(1)
    // 重启后工具仍可用
    const r = await m.callTool('s2', 'echo', { text: 'after-restart' })
    expect(r.text).toBe('echo: after-restart')
  })

  it('[S4-MCP-016] 二次崩溃 → degraded（重启上限 1 次，onDegraded reason=crash）', async () => {
    const onDegraded = vi.fn()
    const m = makeManager({ timeoutMs: 5000, onDegraded })
    await m.startServer({ serverId: 's3', command: FAKE_SERVER, args: [] })
    m.crashForTests('s3')
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const st = m.getStatus('s3')
      if ((st?.restarts ?? 0) >= 1 && st?.state === 'healthy') break
      await new Promise((r) => setTimeout(r, 100))
    }
    m.crashForTests('s3') // 重启后再次崩溃
    const deadline2 = Date.now() + 8000
    while (Date.now() < deadline2) {
      const st = m.getStatus('s3')
      if (st?.state === 'degraded') break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(m.getStatus('s3')?.state).toBe('degraded')
    expect(onDegraded).toHaveBeenCalledWith('s3', expect.stringContaining('crash'))
    // degraded 后 callTool 拒绝（行为回归保护：降级语义不静默放行）
    await expect(m.callTool('s3', 'echo', {})).rejects.toThrow(/不可用/)
  })

  it('[S4-MCP-017] callTool 委托 healthy server；degraded server 拒绝（错误可捕获不炸调用方）', async () => {
    const m = makeManager({ timeoutMs: 5000 })
    await m.startServer({ serverId: 's4', command: FAKE_SERVER, args: [] })
    const r = await m.callTool('s4', 'echo', { text: 'hi' })
    expect(r.text).toBe('echo: hi')
    // 未注册的 serverId → 拒绝
    await expect(m.callTool('nope', 'echo', {})).rejects.toThrow(/degraded|未注册|不可用/)
  })
})

describe('审查收敛修复（R1 P1 竞态，r71）', () => {
  it('[S4-MCP-018] stopServer 后 exit 事件迟到 → 不误触发重启（停止意图优先，P1 竞态修复）', async () => {
    const onDegraded = vi.fn()
    const m = makeManager({ timeoutMs: 5000, onDegraded })
    await m.startServer({ serverId: 's5', command: FAKE_SERVER, args: [] })
    await m.stopServer('s5') // 用户显式停止：删除 states/clients 并 dispose（dispose 触发 exit）
    await new Promise((r) => setTimeout(r, 600)) // 迟到 exit 事件窗口（含重启 delay 300ms）
    // 停止后：无重启副作用（server 不复活）、无 degraded 误报（stop 非崩溃）
    expect(m.getStatus('s5')).toBeUndefined()
    expect(onDegraded).not.toHaveBeenCalled()
  })

  it('[S4-MCP-019] 启动失败（握手挂起 server 超时）→ 半开进程被回收、无 crash 重启副作用（P1 孤儿修复）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-hang-'))
    const hang = join(dir, 'hang-server.mjs')
    // 挂起 server：从不响应 initialize（健康检查必超时失败）
    writeFileSync(hang, `import { createInterface } from 'node:readline'\nconst rl = createInterface({ input: process.stdin })\nrl.on('line', () => {})`)
    const onDegraded = vi.fn()
    const m = makeManager({ timeoutMs: 300, onDegraded })
    const st = await m.startServer({ serverId: 's6', command: hang, args: [] })
    expect(st.state).toBe('degraded')
    // 孤儿修复：spawnAndProbe 失败的半开进程被 dispose 回收——其迟到 exit 不触发 handleExit 重启/degraded
    await new Promise((r) => setTimeout(r, 700))
    const reasons = onDegraded.mock.calls.map((c) => String(c[1]))
    expect(reasons.some((r) => r.includes('crash'))).toBe(false) // 无 crash 类降级（孤儿 exit 被抑制）
    expect(reasons.some((r) => r.includes('spawn'))).toBe(true) // 且 spawn 失败降级恰一次语义
  })
})

describe('审查收敛修复（R2 aliyun 残余：stopped 残留，r71）', () => {
  it('[S4-MCP-020] stopServer 后重新 startServer 同一 serverId → 停止抑制解除（崩溃重启恢复可用）', async () => {
    const m = makeManager({ timeoutMs: 5000 })
    await m.startServer({ serverId: 's7', command: FAKE_SERVER, args: [] })
    await m.stopServer('s7') // 停止（置位抑制）
    // 重新启用同一 serverId
    const st = await m.startServer({ serverId: 's7', command: FAKE_SERVER, args: [] })
    expect(st.state).toBe('healthy')
    // 抑制已解除：崩溃后仍能自动重启（未残留永久抑制）
    m.crashForTests('s7')
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const cur = m.getStatus('s7')
      if (cur?.state === 'healthy' && cur.restarts >= 1) break
      await new Promise((r) => setTimeout(r, 100))
    }
    const cur = m.getStatus('s7')
    expect(cur?.state).toBe('healthy')
    expect(cur?.restarts).toBe(1)
  })
})
