/**
 * 项目族：create/list/archive×2/delete/export×2/rename/abandon/reopen/confirm-sketch/submit-correction/dom×2/upgrade/finalize + APP_SWITCH_STATE（PR4d 自 ipc.ts 拆出；纯机械搬移，行为零变化）。
 */
/**
 * 项目族：create/list/archive×2/delete/export×2/rename/abandon/reopen/confirm-sketch/submit-correction/dom×2/upgrade/finalize + APP_SWITCH_STATE（PR4d 自 ipc.ts 拆出；纯机械搬移，行为零变化）。
 */



import { dialog } from 'electron'
import type { BrowserWindow, IpcMain } from 'electron'
import type { ProjectAbandonInput, ProjectArchiveInput, ProjectDeleteInput, ProjectExportInput, ProjectUpgradeExportInput, AppSwitchStateResult, ProjectFinalizeInput, ProjectListInput, ProjectReopenInput, ProjectRenameInput, ProjectUnarchiveInput, ProjectUpgradeInput } from '../../shared/types';
import { IPC_CHANNELS } from '../../shared/types'

import { cancelAgent } from '../orchestration/orchestrator';


import { clearPendingReviewAction } from "../iteration/pending";


import { abandonProject, archiveProject, createProject, deleteProject, finalizeProject, findProject, getProjectProgressSummary, listProjects, renameProject, reopenProject, unarchiveProject, upgradeProject } from '../project/project-service';

import { exportProjectHandoff } from '../delivery/project-export'
import { upgradeExport } from '../coding/export-manifest'
import { readExperimentSwitches } from '../platform/shell/experiment-switches'
import { isLeanProject } from '../desktop/workflow-policy'
import { isLongtermSoftware, readLongtermState, saveLongtermState } from '../software/longterm-state'
import { dirname } from 'node:path'




import { syncDocuments, renamePrdProject } from '../project/document-engine';

import { stopSandbox } from '../delivery/sandbox';
import { createSnapshot } from '../delivery/snapshots';
import { trackAnalytics } from '../delivery/track-analytics'




import { safeInvoke, extractRequestId, requireFields, validateProjectCreate } from './shared';
import { importSoftwareProject } from '../software/import-project'

export function registerProjectsIpc(ipcMain: IpcMain, mainWindow: BrowserWindow): void {
  void mainWindow
  ipcMain.handle(IPC_CHANNELS.PROJECT_IMPORT, async (_event, payload: unknown) => safeInvoke(extractRequestId(payload), async () => {
    const input = requireFields<import('../../shared/types').ProjectImportInput>(payload, ['mode'])
    if (!['quick', 'longterm'].includes(input.mode)) throw Error('IMPORT_MODE_INVALID')
    const selected = await dialog.showOpenDialog(mainWindow, { title: '打开已有工程（创建独立工作副本）', properties: ['openDirectory'] })
    if (selected.canceled || !selected.filePaths[0]) return { canceled: true }
    return { canceled: false, project: await importSoftwareProject(selected.filePaths[0], input.mode) }
  }))
  ipcMain.handle(IPC_CHANNELS.PROJECT_CREATE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = validateProjectCreate(payload)
      const project = createProject(input, { workflowVersion: 'software-v1' })
      trackAnalytics({
        request_id: input.request_id,
        event: {
          event_type: 'project_created',
          project_id: project.project_id,
          // Phase 7 U5 J5（project_started 口径扩）：首句长度/是否带句读——北极星分母
          // （开始首个有效项目的用户）与首句信息量分层的数据基础；不记原文（脱敏）。
          payload: {
            mode: project.mode,
            initial_message_chars: (input.initial_message ?? '').trim().length,
            has_punctuation: /[。，？！,.!?]/.test(input.initial_message ?? ''),
          },
          privacy_level: 'research_safe',
        },
      })
      return project
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_LIST, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectListInput>(payload, [])
      // U16：为每个项目附带最近进展摘要，列表卡片纯展示用。
      return listProjects(input.scope ?? 'active').map((project) => ({
        ...project,
        progress_summary: getProjectProgressSummary(project.project_id),
      }))
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_ARCHIVE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectArchiveInput>(payload, ['project_id'])
      return archiveProject(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_UNARCHIVE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectUnarchiveInput>(payload, ['project_id'])
      const project=unarchiveProject(input)
      if(isLongtermSoftware(input.project_id)){
        const state=readLongtermState(input.project_id)
        if(state?.archived_at){state.archived_at=undefined;saveLongtermState(state);return findProject(input.project_id)}
      }
      return project
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_DELETE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectDeleteInput>(payload, ['project_id'])
      // 先批停该项目全部活跃运行（全链路审查 P1-2 修复，2026-10-01）：删除≠停止——旧逻辑
      // 不停 run，活跃 loop 会对着已删目录继续烧渠道额度，且后续 appendSessionMessage 会把
      // 被删的 JSONL 与索引条目重新写回（幽灵会话复活，需手动 SESSION_CLEAN_ORPHANS 才清）。
      // cancelAgent 按 project_id 扫 activeSessions + backgroundRuns，abort 后各 run 的
      // finally 自行收尾；不 await 具体收尾（取消是异步竞速，删除目录时容忍残余写入已无落点）。
      // 不 await 具体收尾细节（取消是异步竞速，删除目录时容忍残余写入已无落点），
      // 但吞掉取消链自身异常，避免 unhandled rejection。
      try {
        await cancelAgent({ request_id: input.request_id, session_id: input.project_id, project_id: input.project_id, reason: 'shutdown' })
      } catch (error) {
        console.warn('[project:delete] 批停活跃运行失败（继续删除）：', error)
      }
      // 先停该项目沙箱，避免 Windows 文件句柄占用导致 rmSync EPERM（复用回滚的"先停后删"模式）
      stopSandbox({ request_id: input.request_id, project_id: input.project_id })
      return deleteProject(input)
    })
  })

  // U10：手动导出项目——弹系统目录选择框，把生成的项目代码复制到用户选定目录。
  // 取消导出不是错误，返回 { canceled: true } 让前端静默处理，不落 error 事件。
  ipcMain.handle(IPC_CHANNELS.PROJECT_EXPORT, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectExportInput>(payload, ['project_id'])
      // F-A 修复：导出动作说明已离开补充流，清残留标记
      clearPendingReviewAction(input.project_id)
      const project = findProject(input.project_id)
      const result = await dialog.showOpenDialog(mainWindow, {
        title: `导出「${project.name}」`,
        buttonLabel: '导出到这里',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true }
      }
      return exportProjectHandoff(input, result.filePaths[0])
    })
  })

  // Phase 10 落地旅程（2026-09-16）：升级导出——系统目录选择器选旧导出包，平台产
  // 「新代码+携带旧数据（pre-upgrade 备份）+真实迁移+upgrade-report+新 manifest」
  // 的升级包（与导出同款交互形态；失败明细在升级包内 upgrade-report.json）。
  ipcMain.handle(IPC_CHANNELS.PROJECT_UPGRADE_EXPORT, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectUpgradeExportInput>(payload, ['project_id'])
      const project = findProject(input.project_id)
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: `升级「${project.name}」——选择旧导出包目录`,
        buttonLabel: '从这个版本升级',
        properties: ['openDirectory'],
      })
      if (picked.canceled || picked.filePaths.length === 0) {
        return { canceled: true }
      }
      const landedRoot = picked.filePaths[0]
      const result = await upgradeExport({
        projectRoot: project.root_path,
        landedRoot,
        destination: dirname(landedRoot),
        projectName: project.name,
      })
      return {
        canceled: false,
        target: result.target,
        migration: result.migration,
        summary: result.summary,
        drift: {
          clean: result.drift.clean,
          changed: result.drift.changed.length,
          missing: result.drift.missing.length,
          extra: result.drift.extra.length,
        },
      }
    })
  })

  // Phase 10：实验开关注读面板（白名单实况；I5 两口径文案等渲染端消费）。
  ipcMain.handle(IPC_CHANNELS.APP_SWITCH_STATE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const result: AppSwitchStateResult = { switches: readExperimentSwitches() }
      return result
    })
  })

  // U13：项目重命名——清洗由 renameProject 完成，空名回抛 VALIDATION_ERROR。
  ipcMain.handle(IPC_CHANNELS.PROJECT_RENAME, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectRenameInput>(payload, ['project_id', 'name'])
      const project = renameProject(input)
      renamePrdProject(project.project_id, project.name)
      return project
    })
  })

  // U15：状态流转——标记为「已放弃」/「恢复进行」（active ↔ abandoned）。
  ipcMain.handle(IPC_CHANNELS.PROJECT_ABANDON, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectAbandonInput>(payload, ['project_id'])
      return abandonProject(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_REOPEN, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectReopenInput>(payload, ['project_id'])
      return reopenProject(input)
    })
  })



  ipcMain.handle(IPC_CHANNELS.PROJECT_UPGRADE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectUpgradeInput>(payload, ['project_id', 'session_id'])
      // 切换模式前先创建 upgrade 快照，保留升级前的可回滚状态
      const snapshot = await createSnapshot({
        request_id: input.request_id,
        project_id: input.project_id,
        kind: 'upgrade',
        summary: '升级为长期迭代模式前的快照',
        include_documents: true,
        health_status: 'healthy',
      })
      // research-plan §5：mode_upgraded 埋点（from_mode → to_mode + 快照 id）。
      trackAnalytics({
        request_id: input.request_id,
        event: {
          event_type: 'mode_upgraded',
          project_id: input.project_id,
          session_id: input.session_id,
          payload: { from_mode: 'quick', to_mode: 'longterm', snapshot_id: snapshot.snapshot_id },
          privacy_level: 'research_safe',
        },
      })
      const project = upgradeProject(input)
      // P2-12（2026-09-04）：升级后补 longterm 附加文档（plantuml/sprint）——此前升级只切
      // mode/stage 不触发 syncDocuments，导致升级项目的 plantuml/sprint 缺失（老项目 64747c51
      // 有、后升级项目缺，升级路径未补）。upgradeProject 已把 mode 置 longterm，此处 syncDocuments
      // 的 longterm 分支会补产出 plantuml/architecture.puml + sprint/sprint-plan.md。
      if (!isLeanProject(input.project_id)) syncDocuments({ request_id: input.request_id, session_id: input.session_id, project_id: input.project_id, checkpoint: 'mode_upgraded' })
      return project
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_FINALIZE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectFinalizeInput>(payload, ['project_id', 'session_id'])
      if(isLongtermSoftware(input.project_id)){
        const state=readLongtermState(input.project_id),current=state?.milestones.find(item=>item.id===state.current_id)
        if(current?.status!=='delivered'||findProject(input.project_id).status==='archived')throw Error('LONGTERM_MILESTONE_CONFIRMATION_REQUIRED')
      }
      // U6：满意度埋点 + 项目收口。product_finalized 走研究安全级，不含具体对话内容。
      trackAnalytics({
        request_id: input.request_id,
        event: {
          event_type: 'satisfaction_marked',
          project_id: input.project_id,
          session_id: input.session_id,
          payload: { stage: 'ready' },
          privacy_level: 'research_safe',
        },
      })
      trackAnalytics({
        request_id: input.request_id,
        event: {
          event_type: 'project_finalized',
          project_id: input.project_id,
          session_id: input.session_id,
          payload: {},
          privacy_level: 'research_safe',
        },
      })
      return finalizeProject(input)
    })
  })

}
