import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { checkApiContract, routeErrorFeedbackEnabled } from '../../../main/coding/api-contract'

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

describe('B1 挂载错误回流（BLOMA_ROUTE_ERROR_FEEDBACK）', () => {
  let server: Server | undefined
  const previousEnv = process.env.BLOMA_ROUTE_ERROR_FEEDBACK

  /** 同构健康端点测试服务器：/_bloma/routes 返回挂载失败清单 + mounted 清单（模拟 ESM 路由 require 报错 / 挂错位置两口径） */
  async function startHealthServer(
    errors: Array<{ file: string; message: string }>,
    mounted: Array<{ method: string; path: string }> = [],
  ): Promise<string> {
    server = createServer((req, res) => {
      if (req.url === '/_bloma/routes') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ mounted, errors }))
        return
      }
      res.writeHead(404)
      res.end('Not found')
    })
    return new Promise((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as { port: number }).port}`))
    })
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = undefined
    if (previousEnv === undefined) delete process.env.BLOMA_ROUTE_ERROR_FEEDBACK
    else process.env.BLOMA_ROUTE_ERROR_FEEDBACK = previousEnv
  })

  it('开关缺省 off：reason 字节级现状（不取健康端点）', async () => {
    delete process.env.BLOMA_ROUTE_ERROR_FEEDBACK
    expect(routeErrorFeedbackEnabled()).toBe(false)
    let healthProbed = false
    server = createServer((req, res) => {
      if (req.url === '/_bloma/routes') {
        healthProbed = true
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ mounted: [], errors: [{ file: 'records.js', message: 'Cannot use import statement outside a module' }] }))
        return
      }
      res.writeHead(404)
      res.end('Not found')
    })
    const baseUrl = await new Promise<string>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as { port: number }).port}`))
    })
    const failures = await checkApiContract(baseUrl, [{ endpoint: '/api/records', method: 'GET' }])
    expect(failures).toHaveLength(1)
    expect(failures[0].reason).toBe('契约端点失活（HTTP 404，路由未实现或挂载失败）')
    expect(healthProbed).toBe(false)
  })

  it('开关 on：资源段精确匹配挂载失败文件 → 真实 require 报错进 reason', async () => {
    process.env.BLOMA_ROUTE_ERROR_FEEDBACK = '1'
    const baseUrl = await startHealthServer([{ file: 'records.js', message: 'Cannot use import statement outside a module' }])
    const failures = await checkApiContract(baseUrl, [{ endpoint: '/api/records', method: 'GET' }])
    expect(failures).toHaveLength(1)
    expect(failures[0].reason).toBe(
      '契约端点失活（HTTP 404，路由未实现或挂载失败）；路由文件 records.js 挂载失败：Cannot use import statement outside a module',
    )
  })

  it('开关 on：资源段不匹配时附挂载失败摘要；健康端点缺席/无错误时维持现状措辞', async () => {
    process.env.BLOMA_ROUTE_ERROR_FEEDBACK = '1'
    const baseUrl = await startHealthServer([{ file: 'notes.js', message: 'Unexpected token export' }])
    const failures = await checkApiContract(baseUrl, [{ endpoint: '/api/records', method: 'GET' }])
    expect(failures[0].reason).toBe('契约端点失活（HTTP 404，路由未实现或挂载失败）；挂载失败文件：notes.js（Unexpected token export）')

    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    const bareUrl = await startHealthServer([])
    const failures2 = await checkApiContract(bareUrl, [{ endpoint: '/api/records', method: 'GET' }])
    expect(failures2[0].reason).toBe('契约端点失活（HTTP 404，路由未实现或挂载失败）')
  })

  it('开关 on（P0-3 本月流水账案）：无挂载报错但有 mounted 清单 → 附实际挂载路由与全路径提示', async () => {
    process.env.BLOMA_ROUTE_ERROR_FEEDBACK = '1'
    const baseUrl = await startHealthServer([], [
      { method: 'GET', path: '/api/records/api/records' },
      { method: 'POST', path: '/api/records/api/records' },
    ])
    const failures = await checkApiContract(baseUrl, [{ endpoint: '/api/records', method: 'GET' }])
    expect(failures).toHaveLength(1)
    expect(failures[0].reason).toBe(
      '契约端点失活（HTTP 404，路由未实现或挂载失败）；服务器实际挂载的路由：GET /api/records/api/records、POST /api/records/api/records——目标端点不在其中时，多为路由键写了全路径（键应写文件名前缀之后的相对路径，如 \'GET /\'，文件名已是 /api/ 前缀）',
    )
  })
})
