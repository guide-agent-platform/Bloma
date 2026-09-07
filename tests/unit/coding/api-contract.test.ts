import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { checkApiContract } from '../../../main/coding/api-contract'

/**
 * API 契约存活检查（完整程序阶段 2）：interface_spec 无参 GET 端点探测——
 * 404/5xx = 契约失活；带参/非 GET 跳过；连接失败进 catch 分支。
 */
describe('checkApiContract', () => {
  let server: Server | undefined
  let baseUrl = ''

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = undefined
  })

  it('404/5xx 记为契约失活，2xx 通过；非 GET 与带参端点跳过', async () => {
    server = createServer((req, res) => {
      if (req.url === '/api/ok') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
        return
      }
      if (req.url === '/api/no-method') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
        return
      }
      if (req.url === '/api/missing') {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      if (req.url === '/api/boom') {
        res.writeHead(500)
        res.end('boom')
        return
      }
      res.writeHead(404)
      res.end('Not found')
    })
    baseUrl = await new Promise((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as { port: number }).port}`))
    })

    const failures = await checkApiContract(baseUrl, [
      { endpoint: '/api/ok', method: 'GET' },
      { endpoint: '/api/missing', method: 'GET' },
      { endpoint: '/api/boom', method: 'GET' },
      { endpoint: '/api/submit', method: 'POST' }, // 写类端点跳过
      { endpoint: '/api/records/:id', method: 'GET' }, // 带参端点跳过
      { endpoint: '/api/no-method' }, // 缺省 GET
    ])
    expect(failures).toHaveLength(2)
    expect(failures[0].scenario).toBe('API 契约端点：GET /api/missing')
    expect(failures[0].reason).toContain('HTTP 404')
    expect(failures[1].scenario).toBe('API 契约端点：GET /api/boom')
    expect(failures[1].reason).toContain('HTTP 500')
  })

  it('previewUrl 尾斜杠与端点拼接不失真', async () => {
    server = createServer((req, res) => {
      res.writeHead(404)
      res.end('Not found')
    })
    baseUrl = await new Promise((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as { port: number }).port}`))
    })
    // 服务器可达（返回 404）→ 真实契约失活
    const failures = await checkApiContract(`${baseUrl}/`, [{ endpoint: '/api/anything', method: 'GET' }])
    expect(failures).toHaveLength(1)
    expect(failures[0].reason).toContain('HTTP 404')
  })

  it('服务器不可达（连接拒绝）→ 跳过契约检查，不产生失败（测试环境/沙箱未入口径）', async () => {
    const failures = await checkApiContract('http://127.0.0.1:1', [{ endpoint: '/api/anything', method: 'GET' }])
    expect(failures).toEqual([])
  })

  it('空端点清单零探测零失败', async () => {
    const failures = await checkApiContract('http://127.0.0.1:1', [])
    expect(failures).toEqual([])
  })
})
