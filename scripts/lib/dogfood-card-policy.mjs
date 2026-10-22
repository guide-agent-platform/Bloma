/** Select only an offered, enabled delegation. An exhausted review must remain blocked. */
export function selectReviewDelegation(options) {
  return (Array.isArray(options) ? options : []).find(option =>
    option?.kind === 'review' && option.disabled !== true && option.id === 'prd_review_delegate_all')
}

/** Backend pilots use the same card payload as the renderer. Never guess on an unknown card. */
export function selectPipelineConfirmation(payload, { allowDesktopConversion = false } = {}) {
  if (!payload || typeof payload !== 'object') return { kind: 'stop', reason: 'no_card' }
  if (payload.kind === 'requirement_confirm') return { kind: 'requirement_confirm' }
  const known = { prd_confirm: 'prd_confirm_confirm', ux_confirm: 'ux_confirm_go', mvp_confirm: 'mvp_confirm_go' }
  if (Object.hasOwn(known, payload.kind)) return { kind: 'option', id: known[payload.kind] }
  if (payload.kind === 'prd_review') {
    const offered = selectReviewDelegation((Array.isArray(payload.global_options) ? payload.global_options : [])
      .map(option => ({ ...option, kind: 'review' })))
    return offered ? { kind: 'option', id: offered.id } : { kind: 'stop', reason: 'prd_review_unresolved' }
  }
  if (payload.kind === 'web_line_retired' && allowDesktopConversion
    && Array.isArray(payload.questions) && payload.questions.some(option => option?.id === 'web_to_desktop' && option.disabled !== true)) {
    return { kind: 'option', id: 'web_to_desktop' }
  }
  return { kind: 'stop', reason: 'unsupported_card' }
}
