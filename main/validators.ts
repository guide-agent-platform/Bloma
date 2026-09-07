import type { RequestEnvelope } from '../shared/types'

export function hasRequestId(value: unknown): value is RequestEnvelope {
  return isRecord(value) && typeof value.request_id === 'string' && value.request_id.length > 0
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function requireValue(value: Record<string, unknown>, key: string): void {
  if (value[key] === undefined || value[key] === null || value[key] === '') {
    throw new Error(`Missing required field: ${key}`)
  }
}
