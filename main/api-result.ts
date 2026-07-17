import type { ApiError, ApiResult, ErrorCode } from '../shared/types'

export function ok<T>(requestId: string, data: T): ApiResult<T> {
  return { ok: true, request_id: requestId, data }
}

export function fail<T>(
  requestId: string,
  code: ErrorCode,
  message: string,
  retryable = false,
  details?: Record<string, unknown>,
): ApiResult<T> {
  const error: ApiError = {
    code,
    message,
    retryable,
    details,
    user_visible_message: userVisibleMessage(code),
  }
  return { ok: false, request_id: requestId, error }
}

function userVisibleMessage(code: ErrorCode): string {
  switch (code) {
    case 'AGENT_SESSION_BUSY':
      return '我还在处理上一条内容，请稍等一下。'
    case 'PERMISSION_DENIED':
      return '这个操作已取消，当前内容不会被改动。'
    case 'CHANNEL_NOT_FOUND':
      return '当前还没有可用的模型配置。'
    case 'LOCAL_STORE_WRITE_FAILED':
      return '本地保存失败，请检查磁盘空间后再试。'
    default:
      return '这次操作没有完成，请再试一次。'
  }
}
