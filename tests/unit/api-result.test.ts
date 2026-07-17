import { describe, expect, it } from 'vitest'
import { userVisibleMessage } from '../../main/api-result'
import type { ErrorCode } from '../../shared/types'

describe('ApiResult user-visible messages', () => {
  it('covers api-spec user visible error messages', () => {
    const cases: Array<[ErrorCode, string]> = [
      ['VALIDATION_ERROR', '这次操作缺少必要信息，请再试一次。'],
      ['AGENT_SESSION_BUSY', '我还在处理上一条内容，请稍等一下。'],
      ['AGENT_SDK_ERROR', '刚才处理时遇到问题，我会换个方式继续。'],
      ['AGENT_SDK_TIMEOUT', '这一步等得有点久，我会重新尝试。'],
      ['CHANNEL_NOT_FOUND', '当前还没有可用的模型配置。'],
      ['API_KEY_DECRYPT_FAILED', '模型配置需要重新验证。'],
      ['PERMISSION_DENIED', '这个操作已取消，当前内容不会被改动。'],
      ['SANDBOX_RUN_FAILED', '预览暂时没有启动成功，我正在修复。'],
      ['ROLLBACK_FAILED', '回到旧版本时遇到问题，我会保留当前内容并继续处理。'],
      ['LOCAL_STORE_WRITE_FAILED', '本地保存失败，请检查磁盘空间后再试。'],
    ]

    for (const [code, message] of cases) {
      expect(userVisibleMessage(code)).toBe(message)
    }
  })
})
