/**
 * 渠道故障侦测与人话卡测试（刀5，2026-10-02 确认协议与呈现层战役最小版）。
 *
 * 覆盖：错误签名归类（限流/鉴权/其他）、阈值推进（1 次静默 2 次出卡，出卡一次
 * 防刷屏）、窗口与签名重置、人话卡文案（渠道名/建议/继续放行闭环）。
 */
import { describe, expect, it } from 'vitest'
import {
  CHANNEL_FAILURE_NOTIFY_THRESHOLD,
  buildChannelFailureCard,
  classifyChannelFailure,
  createChannelFailureTracker,
  observeChannelFailure,
  localExecutionStopNotice,
} from '../../../main/desktop/channel-failure-watch'

describe('classifyChannelFailure 签名归类', () => {
  it('限流族：429 / rate limit / quota / too many requests', () => {
    for (const text of ['HTTP 429 Too Many Requests', 'rate limit exceeded', 'Quota exceeded', 'x429y 配额']) {
      expect(classifyChannelFailure(text)).toBe('rate-limited')
    }
  })

  it('鉴权族：401 / 403 / unauthorized / invalid api key', () => {
    for (const text of ['HTTP 401 Unauthorized', '403 Forbidden', 'invalid_api_key', 'Invalid API key provided', 'authentication failed']) {
      expect(classifyChannelFailure(text)).toBe('auth-failed')
    }
  })

  it('其他：连接类/未知错误', () => {
    for (const text of ['ECONNREFUSED', 'fetch failed', '']) {
      expect(classifyChannelFailure(text)).toBe('other')
    }
  })

  it('数字边界：1499/20401 不误判为 429/401（非数字边界保护）', () => {
    expect(classifyChannelFailure('id=1499')).toBe('other')
    expect(classifyChannelFailure('id=20401')).toBe('other')
  })
})

describe('observeChannelFailure 阈值推进', () => {
  it.each(['REQUEST_BUDGET_EXHAUSTED', 'MONETARY_OPERATION_EXHAUSTED', 'MONETARY_POLICY_UNAVAILABLE', 'EXPERIMENT_REQUEST_BUDGET_EXHAUSTED'])(
    'does not attribute local %s admission failures to the channel', error => {
      const tracker = createChannelFailureTracker()
      observeChannelFailure(tracker, { error: 'ECONNRESET', at: 1000 })
      for (let i = 0; i < 3; i++) expect(observeChannelFailure(tracker, { error, at: 2000 + i }).notify).toBe(false)
      expect(tracker.consecutive).toBe(0)
      expect(localExecutionStopNotice(error)).toContain('保留')
      expect(localExecutionStopNotice(error)).not.toContain('API Key')
      expect(observeChannelFailure(tracker, { error: 'ECONNRESET', at: 3000 }).notify).toBe(false)
      expect(observeChannelFailure(tracker, { error: 'ECONNRESET', at: 4000 }).notify).toBe(true)
    })

  it('第 1 次静默；同签名第 2 次出卡；之后不再重复出卡（防刷屏）', () => {
    const tracker = createChannelFailureTracker()
    const first = observeChannelFailure(tracker, { error: 'HTTP 429 rate limited', channel: 'kimi', at: 1000 })
    expect(first.notify).toBe(false)
    const second = observeChannelFailure(tracker, { error: 'HTTP 429 rate limited', channel: 'kimi', at: 2000 })
    expect(second.notify).toBe(true)
    expect(second.card).toContain('kimi')
    expect(second.card).toContain('限流')
    const third = observeChannelFailure(tracker, { error: 'HTTP 429 again', channel: 'kimi', at: 3000 })
    expect(third.notify).toBe(false) // 已出卡不重复
  })

  it('换签名重置计数（限流→鉴权另算）', () => {
    const tracker = createChannelFailureTracker()
    expect(observeChannelFailure(tracker, { error: '429', at: 1000 }).notify).toBe(false)
    expect(observeChannelFailure(tracker, { error: '401 unauthorized', at: 2000 }).notify).toBe(false) // 换签名重置后第 1 次
    expect(observeChannelFailure(tracker, { error: '401 unauthorized', at: 3000 }).notify).toBe(true)
  })

  it('窗口外（>10 分钟）重置：旧计数不累积', () => {
    const tracker = createChannelFailureTracker()
    observeChannelFailure(tracker, { error: '429', at: 1000 })
    const late = observeChannelFailure(tracker, { error: '429', at: 1000 + 11 * 60 * 1000 })
    expect(late.notify).toBe(false) // 窗口重置后算第 1 次
    expect(observeChannelFailure(tracker, { error: '429', at: 1000 + 11 * 60 * 1000 + 1000 }).notify).toBe(true)
  })

  it('无 error 的失败不推进（缺归因数据静默跳过——调用方同判）', () => {
    const tracker = createChannelFailureTracker()
    expect(observeChannelFailure(tracker, { at: 1000 }).notify).toBe(false)
    expect(tracker.consecutive).toBe(1) // other 签名推进但不影响阈值语义
    expect(CHANNEL_FAILURE_NOTIFY_THRESHOLD).toBe(2)
  })
})

describe('buildChannelFailureCard 人话卡文案', () => {
  it('带渠道名：故障归类 + 错误摘要 + 设置出口 + 继续放行', () => {
    const card = buildChannelFailureCard({ kind: 'auth-failed', channel: 'glm', count: 2, error: 'HTTP 401 Unauthorized: invalid api key' })
    expect(card).toContain('【渠道疑似故障】')
    expect(card).toContain('「glm」渠道')
    expect(card).toContain('鉴权失败')
    expect(card).toContain('HTTP 401')
    expect(card).toContain('设置 → 模型渠道')
    expect(card).toContain('回复「继续」')
  })

  it('无渠道名降级为「当前模型渠道」', () => {
    const card = buildChannelFailureCard({ kind: 'rate-limited', count: 2 })
    expect(card).toContain('当前模型渠道')
    expect(card).toContain('限流')
  })
})
