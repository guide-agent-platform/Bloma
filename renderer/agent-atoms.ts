import { atom, type WritableAtom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { AgentEvent, AgentMessage, ElectronAPI, PermissionRequest } from '../shared/types'

declare global {
  interface Window {
    electronAPI?: ElectronAPI
    __jotai_store__?: {
      set: <Value, Args extends unknown[], Result>(
        atom: WritableAtom<Value, Args, Result>,
        ...args: Args
      ) => Result
    }
  }
}

export interface AgentSessionMeta {
  session_id: string
  project_id: string
  title: string
  created_at: string
}

export interface AgentStreamState {
  running: boolean
  events: AgentEvent[]
  content: string
  last_error?: string
}

export const agentSessionsAtom = atom<AgentSessionMeta[]>([])
export const activeAgentSessionIdAtom = atom<string | null>(null)

export const agentStreamStateFamily = atomFamily((sessionId: string) =>
  atom<AgentStreamState>({
    running: false,
    events: [],
    content: '',
  })
)

export const agentMessagesFamily = atomFamily((_sessionId: string) =>
  atom<AgentMessage[]>([])
)

export const pendingPermissionRequestsAtom = atom<Map<string, PermissionRequest[]>>(new Map())

export const currentSessionPermissionCountAtom = atom((get) => {
  const activeId = get(activeAgentSessionIdAtom)
  if (!activeId) return 0
  return get(pendingPermissionRequestsAtom).get(activeId)?.length ?? 0
})

export function setupGlobalAgentListeners(): () => void {
  const api = window.electronAPI?.agent
  const store = window.__jotai_store__
  if (!api || !store) return () => undefined

  return api.onStreamEvent((event) => {
    const streamAtom = agentStreamStateFamily(event.session_id)
    store.set(streamAtom, (previous: AgentStreamState) => {
      const permissionRequest = event.type === 'permission_requested'
        ? (event.payload.request as PermissionRequest | undefined)
        : undefined

      if (permissionRequest) {
        store.set(pendingPermissionRequestsAtom, (current) => {
          const next = new Map(current)
          const existing = next.get(permissionRequest.session_id) ?? []
          next.set(permissionRequest.session_id, [...existing, permissionRequest])
          return next
        })
      }

      const text = typeof event.payload.text === 'string' ? event.payload.text : ''
      return {
        running: event.type !== 'completed' && event.type !== 'error',
        events: [...previous.events, event],
        content: previous.content + text,
        last_error: event.type === 'error' ? String(event.payload.code ?? 'AGENT_SDK_ERROR') : previous.last_error,
      }
    })
  })
}
