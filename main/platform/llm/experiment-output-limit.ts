/** A host ceiling at the SDK boundary also covers auxiliary callers with legacy defaults. */
export function experimentOutputTokens(requested = 640000): number {
  if (!['1', 'true', 'on'].includes(process.env.BLOMA_DISPATCH_EXPERIMENT ?? '')) return requested
  const cap = Number(process.env.BLOMA_EXPERIMENT_MAX_OUTPUT_TOKENS ?? '8192')
  if (!Number.isSafeInteger(cap) || cap < 1024 || cap > 65536) {
    throw new Error('EXPERIMENT_INVALID_OUTPUT_CEILING')
  }
  if (!Number.isSafeInteger(requested) || requested < 1) throw new Error('EXPERIMENT_INVALID_REQUEST_OUTPUT')
  return Math.min(requested, cap)
}
