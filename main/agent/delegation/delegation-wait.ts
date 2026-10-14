interface WaitSignals {
  status: string
  completion: Promise<unknown>
  askSignal: { promise: Promise<unknown> }
}

/** Wait mechanics only: state ownership and summaries stay in agent-collaboration. */
export async function awaitDelegationState(records: readonly WaitSignals[], signal: AbortSignal,
  strategy: 'all' | 'any' | undefined, timeoutMs: number): Promise<void> {
  signal.throwIfAborted()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(resolve, timeoutMs)
    timer.unref?.()
  })
  let onAbort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('DELEGATION_WAIT_CANCELLED'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  // Terminal records may retain resolved ask signals; those must not wake a wait.
  const questionSignals = records.filter(record => record.status === 'running').map(record => record.askSignal.promise)
  const questionRace = questionSignals.length ? Promise.any(questionSignals) : new Promise(() => {})
  try {
    const completion = strategy === 'any'
      ? Promise.any(records.map(record => record.completion))
      : Promise.all(records.map(record => record.completion))
    await Promise.race([completion, questionRace, timeout, aborted])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}
