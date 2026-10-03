import { describe, expect, it } from 'vitest'
import { userVisibleMessage } from '../../shared/api-result'
import type { ErrorCode } from '../../shared/types'

/**
 * userVisibleMessage 不变量锁（2026-10-03 删留执行改写：原用例把 switch 的 10 条
 * 文案逐字复制进断言——零独立信息量且漏 AGENT_PROJECT_BUSY 与 default 分支。改锁
 * 不变量：全码表非空、不含错误码/技术词（用户可见文案底线）、default 兜底非空。
 */

const ALL_CODES = [
  'VALIDATION_ERROR',
  'IPC_CHANNEL_NOT_FOUND',
  'AGENT_SESSION_BUSY',
  'AGENT_PROJECT_BUSY',
  'AGENT_SDK_ERROR',
  'AGENT_SDK_TIMEOUT',
  'AGENT_CANCELLED',
  'CHANNEL_NOT_FOUND',
  'SESSION_NOT_FOUND',
  'SESSION_FORK_ENTRY_NOT_FOUND',
  'API_KEY_DECRYPT_FAILED',
  'PERMISSION_REQUEST_NOT_FOUND',
  'PERMISSION_DENIED',
  'PROJECT_NOT_FOUND',
  'SANDBOX_CREATE_FAILED',
  'SANDBOX_RUN_FAILED',
  'SANDBOX_PERMISSION_DENIED',
  'SNAPSHOT_CREATE_FAILED',
  'SNAPSHOT_NOT_FOUND',
  'ROLLBACK_FAILED',
  'DOCUMENT_SYNC_FAILED',
  'ANALYTICS_WRITE_FAILED',
  'LOCAL_STORE_WRITE_FAILED',
] as const satisfies readonly ErrorCode[]

describe('ApiResult user-visible messages（不变量）', () => {
  it('全码表：非空中文话术，不含错误码与技术词（3+ 连续 ASCII 字母）', () => {
    for (const code of ALL_CODES) {
      const message = userVisibleMessage(code)
      expect(message.length, `${code} 话术非空`).toBeGreaterThan(4)
      expect(message, `${code} 话术不得回显错误码`).not.toContain(code)
      expect(message, `${code} 话术不得含技术词`).not.toMatch(/[A-Za-z]{3,}/)
    }
  })

  it('未知/未列举码 → default 兜底非空（新增码未接线也有用户话术）', () => {
    const fallback = userVisibleMessage('SOME_FUTURE_CODE' as ErrorCode)
    expect(fallback.length).toBeGreaterThan(4)
    expect(fallback).not.toMatch(/[A-Za-z]{3,}/)
  })
})
