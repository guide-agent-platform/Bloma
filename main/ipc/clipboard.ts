import { clipboard, type IpcMain } from 'electron'
import { IPC_CHANNELS, type RequestEnvelope } from '../../shared/types'
import { extractRequestId, requireFields, safeInvoke } from './shared'

export function registerClipboardIpc(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_CHANNELS.CLIPBOARD_WRITE_TEXT, (_event, payload: unknown) => safeInvoke(extractRequestId(payload), () => {
    const input = requireFields<RequestEnvelope & { text: string }>(payload, ['text'])
    if (typeof input.text !== 'string' || input.text.length > 1_000_000) throw new Error('VALIDATION_ERROR: 复制内容必须是文本且不超过100万字符')
    clipboard.writeText(input.text)
    return { copied: true as const }
  }))
}
