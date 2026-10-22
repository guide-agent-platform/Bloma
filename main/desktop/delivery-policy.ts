/** One mode/protocol matrix. Evidence execution stays with its owning gate. */
export function desktopDeliveryPolicy(mode: string | undefined, experiment?: { production_protocol?: string; models?: unknown }) {
  const quick = mode === 'quick'
  const independentReview = quick && experiment?.production_protocol === 'v2' && Boolean(experiment.models)
  return { quick, mvpConfirmation: mode === 'longterm', independentReview,
    gates: ['core', 'security', 'launch', ...(independentReview ? ['independent_review'] : []),
      ...(mode === 'longterm' ? ['mvp_confirmation'] : []), 'version'] as readonly string[] }
}
