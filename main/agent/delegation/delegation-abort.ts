import { appendDelegationSettle } from './delegation-persistence'
import type { DelegationRecord } from './agent-collaboration'

export const ABORT_SETTLE_TIMEOUT_MS = 5000

/** An unresponsive invocation may settle late; its timer never owns a later run. */
export function installAbortSettlement(record: DelegationRecord, onCancelled: () => void): void {
  const ownedAbort = record.abort
  ownedAbort.signal.addEventListener('abort', () => {
    setTimeout(() => {
      if (record.abort !== ownedAbort || record.status !== 'running') return
      record.status = 'cancelled'
      record.error = '已由主 agent 停止（abort），子循环未响应，超时强制收尾'
      try { appendDelegationSettle(record.childSessionId, 'cancelled', { error: record.error }) }
      catch (error) { console.warn('[delegation-persistence] abort 强制收尾落盘失败:', error) }
      record.resolveCompletion()
      onCancelled()
    }, ABORT_SETTLE_TIMEOUT_MS).unref?.()
  }, { once: true })
}
