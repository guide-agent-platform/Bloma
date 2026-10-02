/**
 * 桌面线产物预览 IPC 族（刀3 呈现层最小版，2026-10-02 确认协议与呈现层战役）。
 *
 * 三通道（四层强类型链路 Layer 2）：
 *   DESKTOP_ARTIFACT_SUBSCRIBE（invoke）：订阅项目产物变更（单订阅模型）+ 返回清单快照；
 *   DESKTOP_ARTIFACT_IMAGE（invoke）：png 截图 → base64 data URL（白名单 fail-closed）；
 *   DESKTOP_ARTIFACT_EVENT（main→renderer 推送）：去抖变更信号——渲染端重拉清单。
 *
 * 监听/清单/读取的实现在 main/desktop/artifact-watch.ts（domain 逻辑与 IPC 装配分离）。
 */
import type { BrowserWindow, IpcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/types'
import { extractRequestId, requireFields, safeInvoke } from './shared'
import type {
  DesktopArtifactImageInput,
  DesktopArtifactSubscribeInput,
} from '../../shared/types'
import { findProject } from '../project/project-service'
import {
  listDesktopArtifacts,
  readDesktopArtifactImage,
  subscribeDesktopArtifacts,
} from '../desktop/artifact-watch'

export function registerDesktopArtifactsIpc(ipcMain: IpcMain, mainWindow: BrowserWindow): void {
  ipcMain.handle(IPC_CHANNELS.DESKTOP_ARTIFACT_SUBSCRIBE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<DesktopArtifactSubscribeInput>(payload, ['project_id'])
      const project = findProject(input.project_id) // 缺项目自抛 PROJECT_NOT_FOUND
      subscribeDesktopArtifacts(input.project_id, project.root_path, (projectId) => {
        mainWindow.webContents.send(IPC_CHANNELS.DESKTOP_ARTIFACT_EVENT, { project_id: projectId })
      })
      return { items: listDesktopArtifacts(project.root_path) }
    })
  })

  ipcMain.handle(IPC_CHANNELS.DESKTOP_ARTIFACT_IMAGE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<DesktopArtifactImageInput>(payload, ['project_id', 'path'])
      const project = findProject(input.project_id)
      return readDesktopArtifactImage(project.root_path, String(input.path))
    })
  })
}
