import { registerIpcHandlers } from '../../../main/ipc'
import type { AgentEvent } from '../../../shared/types'

type IpcHandler = (_event: unknown, payload: unknown) => unknown

export interface IpcHarness {
  events: AgentEvent[]
  channels: string[]
  invoke(channel: string, payload: unknown): Promise<unknown>
}

export function createIpcHarness(): IpcHarness {
  const handlers = new Map<string, IpcHandler>()
  const events: AgentEvent[] = []
  const ipcMain = {
    handle(channel: string, handler: IpcHandler) {
      handlers.set(channel, handler)
    },
  }
  const mainWindow = {
    webContents: {
      send(_channel: string, event: AgentEvent) {
        events.push(event)
      },
    },
  }

  registerIpcHandlers(ipcMain as never, mainWindow as never)

  return {
    events,
    channels: [...handlers.keys()],
    async invoke(channel: string, payload: unknown) {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`Missing IPC handler: ${channel}`)
      return handler({}, payload)
    },
  }
}
