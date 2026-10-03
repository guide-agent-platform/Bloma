import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { MiniMcpClient } from '../../main/platform/mcp/mcp-client'

/**
 * MCP stdio 客户端（mcp-support-port r70 转正，原型 8/8 + 三陷阱文档化）：
 * 真实子进程全生命周期——id 关联的请求/响应、L-DJSON 解析（容忍非 JSON 行）、
 * initialize 握手、tools/list、tools/call 内容提取+isError、stderr 分流、超时兜底、dispose 杀进程。
 *
 * 三陷阱（原型实证，变异验证锁定）：
 * ① 通知判定按「无 id」而非「有 method」——请求也带 method，判错则所有请求被当通知吞掉
 * ② L-DJSON 必须跳过非 JSON 行——server 横幅/日志混在 stdout 会污染协议流
 * ③ Windows kill() 后 exit code=null + signal=SIGTERM——清理断言不能要求 code 非 null
 */

const FAKE_SERVER = fileURLToPath(new URL('../support/fake-mcp-server.mjs', import.meta.url))

const clients: MiniMcpClient[] = []
function makeClient(timeoutMs = 5000, serverPath = FAKE_SERVER): MiniMcpClient {
  const c = new MiniMcpClient(serverPath, timeoutMs)
  clients.push(c)
  return c
}

afterEach(async () => {
  for (const c of clients.splice(0)) {
    await c.dispose().catch(() => undefined)
  }
})

// 【挂账 2026-10-03 删留执行】MiniMcpClient 自 2026-08-29 r70 转正评审后零生产接线
// （skill-loader 未接入）。协议面质量高，接入或裁撤裁决前保留休眠。

describe('MiniMcpClient 真实子进程生命周期（S4-MCP-001~008）', () => {
  it('[S4-MCP-001] initialize 真实握手 + 垃圾行跳过（陷阱②：server ready 横幅不污染协议流）', async () => {
    const client = makeClient()
    const init = await client.initialize()
    expect(init.serverInfo.name).toBe('fake-mcp')
    expect(init.protocolVersion).toBe('2025-06-18')
  })

  it('[S4-MCP-002] tools/list 发现 2 工具（echo/fail）', async () => {
    const client = makeClient()
    await client.initialize()
    const tools = await client.listTools()
    expect(tools.tools).toHaveLength(2)
    expect(tools.tools.map((t) => t.name)).toEqual(['echo', 'fail'])
  })

  it('[S4-MCP-003] tools/call echo：内容提取 + 真实延迟（≥50ms 时序，非 fake 立即 resolve）', async () => {
    const client = makeClient()
    await client.initialize()
    const t0 = Date.now()
    const echo = await client.callTool('echo', { text: 'hello' })
    expect(echo.text).toBe('echo: hello')
    expect(echo.isError).toBe(false)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50)
  })

  it('[S4-MCP-004] isError 语义透传（fail 工具：isError=true + text=boom）', async () => {
    const client = makeClient()
    await client.initialize()
    const boom = await client.callTool('fail', {})
    expect(boom.isError).toBe(true)
    expect(boom.text).toBe('boom')
  })

  it('[S4-MCP-005] 未知工具 → RPC 错误抛出（-32601 透传为 reject）', async () => {
    const client = makeClient()
    await client.initialize()
    await expect(client.callTool('nope', {})).rejects.toThrow(/unknown tool/)
  })

  it('[S4-MCP-006] stderr 分流：不进响应流（initialized 回执在 stderr 可观测）', async () => {
    const client = makeClient()
    await client.initialize()
    // notifications/initialized 回执走 stderr（fake server 行为），响应流不被污染
    await new Promise((r) => setTimeout(r, 120))
    expect(client.stderrSoFar()).toContain('initialized')
    const tools = await client.listTools() // 协议流仍健康
    expect(tools.tools).toHaveLength(2)
  })

  it('[S4-MCP-007] 故障注入：超时兜底（极小 timeoutMs 下慢工具 reject 而非永久挂起）', async () => {
    const client = makeClient(20) // fake echo 延迟 60ms > 20ms 超时
    await expect(client.callTool('echo', { text: 'x' })).rejects.toThrow(/超时/)
    // 超时后 pending 清理、进程随 dispose 回收
    await client.dispose()
  })

  it('[S4-MCP-008] dispose 杀掉子进程（陷阱③：Windows 下 code=null + signal=SIGTERM 也算成功）', async () => {
    const client = makeClient()
    await client.initialize()
    const exit = await client.dispose()
    expect(exit.code !== null || exit.signal !== null).toBe(true)
    // 二次 dispose 安全（幂等）
    await expect(client.dispose()).resolves.toBeTruthy()
  })
})

describe('id 关联并发不变量（属性式，S4-MCP-009）', () => {
  it('[S4-MCP-009] 并发 8 个 callTool：响应按 id 正确配对（乱序到达不串台）', async () => {
    const client = makeClient()
    await client.initialize()
    const texts = await Promise.all(
      Array.from({ length: 8 }, (_, i) => client.callTool('echo', { text: `msg-${i}` }).then((r) => r.text)),
    )
    for (let i = 0; i < 8; i++) {
      expect(texts).toContain(`echo: msg-${i}`)
    }
    expect(new Set(texts).size).toBe(8) // 无串台（8 个不同响应）
  })
})

describe('fuzz：恶意 server 输出（S4-MCP-010）', () => {
  it('[S4-MCP-010] 垃圾洪流（超长行/嵌套 JSON 无 id/二进制片段）不崩、真实响应仍可配对', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-fuzz-'))
    const evil = join(dir, 'evil-server.mjs')
    // 恶意 server：横幅+超长行+带 method 无 id 的伪通知洪流+真实响应混杂
    writeFileSync(
      evil,
      [
        `import { createInterface } from 'node:readline'`,
        `process.stdout.write('x'.repeat(200000) + '\\n')`,
        `process.stdout.write(JSON.stringify({ method: 'evil-notify', params: { a: 1 } }) + '\\n')`,
        `process.stdout.write('\\x00\\x01\\x02 binary-ish \\n')`,
        `const rl = createInterface({ input: process.stdin })`,
        `rl.on('line', (line) => {`,
        `  let msg; try { msg = JSON.parse(line) } catch { return }`,
        `  if (msg.id === undefined) return`,
        `  // 非标形态：响应携带 method 字段（陷阱①的有效变异前提——按 method 判通知会吞掉它）`,
        `  // 每个真实响应前先吐 5 条垃圾（压力下协议流仍可解析）`,
        `  for (let i = 0; i < 5; i++) process.stdout.write('garbage line ' + i + '\\n')`,
        `  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, method: 'resp', result: { serverInfo: { name: 'evil-ok' } } }) + '\\n')`,
        `})`,
      ].join('\n'),
    )
    const client = makeClient(5000, evil)
    const init = await client.initialize()
    expect(init.serverInfo.name).toBe('evil-ok') // 垃圾洪流中真实响应仍被 id 配对
  })
})

describe('审查加固（R1 deepseek P2：buffer 无上限）', () => {
  it('[S4-MCP-011] 恶意 server 永不换行洪流（2MB）→ 截断保护不 OOM，后续正常响应仍可配对', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-flood-'))
    const flood = join(dir, 'flood-server.mjs')
    writeFileSync(
      flood,
      [
        `process.stdout.write('y'.repeat(2 * 1024 * 1024)) // 永不换行的 2MB 洪流`,
        `import { createInterface } from 'node:readline'`,
        `const rl = createInterface({ input: process.stdin })`,
        `rl.on('line', (line) => {`,
        `  let msg; try { msg = JSON.parse(line) } catch { return }`,
        `  if (msg.id === undefined) return`,
        `  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'flood-ok' } } }) + '\\n')`,
        `})`,
      ].join('\n'),
    )
    const client = makeClient(5000, flood)
    const init = await client.initialize()
    expect(init.serverInfo.name).toBe('flood-ok') // 洪流后协议仍可解析（尾部保留语义）
  })
})
