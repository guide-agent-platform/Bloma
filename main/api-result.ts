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

export function userVisibleMessage(code: ErrorCode): string {
  switch (code) {
    case 'VALIDATION_ERROR':
      return '这次操作缺少必要信息，请再试一次。'
    case 'AGENT_SESSION_BUSY':
      return '我还在处理上一条内容，请稍等一下。'
    case 'AGENT_PROJECT_BUSY':
      return '这个项目正在处理另一项任务，请先等待它完成或点击停止。'
    case 'AGENT_SDK_ERROR':
      return '刚才处理时遇到问题，我会换个方式继续。'
    case 'AGENT_SDK_TIMEOUT':
      return '这一步等得有点久，我会重新尝试。'
    case 'CHANNEL_NOT_FOUND':
      return '当前还没有可用的模型配置。'
    case 'API_KEY_DECRYPT_FAILED':
      return '模型配置需要重新验证。'
    case 'PERMISSION_DENIED':
      return '这个操作已取消，当前内容不会被改动。'
    case 'SANDBOX_RUN_FAILED':
      return '预览暂时没有启动成功，我正在修复。'
    case 'ROLLBACK_FAILED':
      return '回到旧版本时遇到问题，我会保留当前内容并继续处理。'
    case 'LOCAL_STORE_WRITE_FAILED':
      return '本地保存失败，请检查磁盘空间后再试。'
    default:
      return '出了点小问题，我会处理好。'
  }
}
