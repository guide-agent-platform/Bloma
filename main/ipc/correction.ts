/**
 * 点选纠错 IPC（批11 MVP-E，2026-10-08）。
 *
 * 三通道（四层强类型链路）：
 *   CORRECTION_START（invoke）：启动修改预览实例（correction-session 编排——数据快照
 *     隔离 + 可见纠错实例 + DRIVE_SERVER 就绪等待；旧骨架产物返回 unsupported 如实呈现）；
 *   CORRECTION_PICKS（invoke）：选区轮询（picks.jsonl 文件交接——产物桥落盘、平台读取）；
 *   CORRECTION_FINISH（invoke）：收口 kill 进程树。
 *
 * 反馈回炉不经本族：渲染端收口时把 buildCorrectionFeedback 文本作为普通用户消息发送
 * （AGENT_SEND_MESSAGE），走 delivered 反馈回炉链（desktop-route）——纠错的持久化落在
 * 意图层（背板约束），不落文件补丁（实施底稿两层拆分）。
 */
import type { IpcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/types'
import type { CorrectionFinishInput, CorrectionPicksInput, CorrectionStartInput } from '../../shared/types'
import { extractRequestId, requireFields, safeInvoke } from './shared'
import { startCorrectionSession, readCorrectionPicks, finishCorrectionSession, settleCorrectionTeardown } from '../desktop/correction-session'

export function registerCorrectionIpc(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_CHANNELS.CORRECTION_START, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<CorrectionStartInput>(payload, ['project_id'])
      return startCorrectionSession({ projectId: input.project_id })
    })
  })

  ipcMain.handle(IPC_CHANNELS.CORRECTION_PICKS, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<CorrectionPicksInput>(payload, ['project_id'])
      return readCorrectionPicks({ projectId: input.project_id })
    })
  })

  ipcMain.handle(IPC_CHANNELS.CORRECTION_FINISH, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<CorrectionFinishInput>(payload, ['project_id'])
      if ((input.recover !== undefined && typeof input.recover !== 'boolean') || (input.discard !== undefined && typeof input.discard !== 'boolean')
        || (input.acknowledge !== undefined && typeof input.acknowledge !== 'string')) throw new Error('CORRECTION_FINISH_INVALID')
      const result = finishCorrectionSession({ projectId: input.project_id, recover: input.recover, discard: input.discard, acknowledge: input.acknowledge })
      await settleCorrectionTeardown(input.project_id)
      return result
    })
  })
}
