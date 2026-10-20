/**
 * 提示词族：prompt list/read/save/reset（PR4d 自 ipc.ts 拆出；纯机械搬移，行为零变化）。
 */
/**
 * 提示词族：prompt list/read/save/reset（PR4d 自 ipc.ts 拆出；纯机械搬移，行为零变化）。
 */




import type { BrowserWindow, IpcMain } from 'electron'
import type { PromptReadInput, PromptResetInput, PromptSaveInput, RequestEnvelope } from '../../shared/types';
import { IPC_CHANNELS } from '../../shared/types'
















import { listPromptSlots, readPromptSlot, resetPromptSlot, savePromptSlot } from '../agent/prompting/prompt-service'









import { safeInvoke, extractRequestId, requireFields } from './shared';

export function registerPromptsIpc(ipcMain: IpcMain, mainWindow: BrowserWindow): void {
  void mainWindow
  ipcMain.handle(IPC_CHANNELS.PROMPT_LIST, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      requireFields<RequestEnvelope>(payload, [])
      return listPromptSlots()
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROMPT_READ, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<PromptReadInput>(payload, ['prompt_id'])
      return readPromptSlot(input.prompt_id)
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROMPT_SAVE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<PromptSaveInput>(payload, ['prompt_id', 'content'])
      return savePromptSlot(input.prompt_id, input.content)
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROMPT_RESET, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<PromptResetInput>(payload, ['prompt_id'])
      return resetPromptSlot(input.prompt_id)
    })
  })
}
