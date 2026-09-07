import { describe, expect, it } from 'vitest'
import {
  classifyHttpStatus,
  extractErrorMessage,
  normalizeHttpResponse,
  normalizeRequestError,
  summarizeDetail,
} from '../../main/channel-test-error'

/**
 * 渠道连接测试错误归一化纯函数测试（S2-AGENT）。
 * 覆盖 HTTP 状态码分类、错误响应体解析、请求异常分类和凭证脱敏。
 */
describe('classifyHttpStatus — 按状态码分类', () => {
  it('5xx 归类为 server', () => {
    expect(classifyHttpStatus(500)).toBe('server')
    expect(classifyHttpStatus(502)).toBe('server')
    expect(classifyHttpStatus(529)).toBe('server')
  })

  it('401 → auth，402 → quota', () => {
    expect(classifyHttpStatus(401)).toBe('auth')
    expect(classifyHttpStatus(402)).toBe('quota')
  })

  it('403 带 invalid api key 文本 → auth，否则 permission', () => {
    expect(classifyHttpStatus(403, '{"error":{"message":"invalid api key"}}')).toBe('auth')
    expect(classifyHttpStatus(403, '{"error":{"message":"forbidden"}}')).toBe('permission')
    expect(classifyHttpStatus(403)).toBe('permission')
  })

  it('404 → not_found，408 → timeout', () => {
    expect(classifyHttpStatus(404)).toBe('not_found')
    expect(classifyHttpStatus(408)).toBe('timeout')
  })

  it('429 带 insufficient_quota 文本 → quota，否则 rate_limit', () => {
    expect(classifyHttpStatus(429, '{"error":{"code":"insufficient_quota"}}')).toBe('quota')
    expect(classifyHttpStatus(429, '{"error":{"message":"too many requests"}}')).toBe('rate_limit')
    expect(classifyHttpStatus(429)).toBe('rate_limit')
  })

  it('400 带 api key not valid 文本 → auth，否则 bad_request', () => {
    expect(classifyHttpStatus(400, '{"error":{"message":"API key not valid"}}')).toBe('auth')
    expect(classifyHttpStatus(400, '{"error":{"message":"bad json"}}')).toBe('bad_request')
  })
})

describe('extractErrorMessage — 提取可读错误消息', () => {
  it('兼容 { error: { message } } 结构', () => {
    expect(extractErrorMessage('{"error":{"message":"余额不足"}}')).toBe('余额不足')
  })

  it('兼容顶层 { message } 结构', () => {
    expect(extractErrorMessage('{"message":"oops"}')).toBe('oops')
  })

  it('非 JSON 原样返回', () => {
    expect(extractErrorMessage('<html>Gateway Timeout</html>')).toBe('<html>Gateway Timeout</html>')
  })
})

describe('summarizeDetail — 脱敏与截断', () => {
  it('脱敏 Bearer token 与 sk- key', () => {
    const redacted = summarizeDetail('unauthorized for Bearer abc123 sk-verysecretkey1234')
    expect(redacted).not.toContain('abc123')
    expect(redacted).not.toContain('verysecretkey')
    expect(redacted).toContain('[REDACTED]')
  })
})

describe('normalizeHttpResponse — HTTP 响应归一化', () => {
  it('2xx 视为连接成功', async () => {
    const res = await normalizeHttpResponse(new Response('{}', { status: 200 }))
    expect(res.ok).toBe(true)
    expect(res.message).toBe('连接成功')
  })

  it('401 返回 auth 分类与脱敏摘要', async () => {
    const res = await normalizeHttpResponse(
      new Response('{"error":{"message":"unauthorized Bearer secrettoken123"}}', { status: 401 }),
    )
    expect(res.ok).toBe(false)
    expect(res.errorType).toBe('auth')
    expect(res.statusCode).toBe(401)
    expect(res.message).toContain('认证失败')
    expect(res.detail).not.toContain('secrettoken123')
  })
})

describe('normalizeRequestError — 请求异常分类', () => {
  it('DOMException TimeoutError → timeout', () => {
    const res = normalizeRequestError(new DOMException('timeout exceeded', 'TimeoutError'))
    expect(res.ok).toBe(false)
    expect(res.errorType).toBe('timeout')
  })

  it('非法 URL → bad_request', () => {
    const res = normalizeRequestError(new TypeError('Invalid URL: http://x y'))
    expect(res.errorType).toBe('bad_request')
  })

  it('一般网络错误 → network', () => {
    const res = normalizeRequestError(new Error('fetch failed: ECONNREFUSED'))
    expect(res.errorType).toBe('network')
  })
})
