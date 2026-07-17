import { randomUUID } from 'node:crypto'
import type {
  AnalyticsTrackInput,
  AnalyticsTrackResult,
  DocumentRef,
  DocumentSyncInput,
  DocumentSyncResult,
  RollbackResult,
  SandboxRunInput,
  SandboxRunResult,
  SandboxStopInput,
  SandboxStopResult,
  Snapshot,
  SnapshotCreateInput,
  SnapshotRollbackInput,
} from '../shared/types'
import { getAnalyticsPath, getDocumentsDir, getSnapshotsDir } from '../storage/config-paths'
import { appendJsonLine, writeJsonFile } from '../storage/json-store'
import { findProject } from './project-service'

export function runSandbox(input: SandboxRunInput): SandboxRunResult {
  const project = findProject(input.project_id)
  return {
    status: 'running',
    preview_url: `file://${project.root_path.replace(/\\/g, '/')}/index.html`,
  }
}

export function stopSandbox(_input: SandboxStopInput): SandboxStopResult {
  return { stopped: true }
}

export function createSnapshot(input: SnapshotCreateInput): Snapshot {
  const project = findProject(input.project_id)
  const snapshotId = randomUUID()
  const snapshotDir = getSnapshotsDir(project.workspace_slug, project.project_id)
  const snapshot: Snapshot = {
    snapshot_id: snapshotId,
    project_id: project.project_id,
    kind: input.kind,
    name: `${input.kind}-${snapshotId.slice(0, 8)}`,
    summary: input.summary,
    files_archive_path: `${snapshotDir}/${snapshotId}/files`,
    documents_archive_path: input.include_documents ? `${snapshotDir}/${snapshotId}/documents` : undefined,
    health_status: input.health_status,
    created_at: new Date().toISOString(),
  }
  writeJsonFile(`${snapshotDir}/${snapshotId}.json`, snapshot)
  return snapshot
}

export function rollbackSnapshot(input: SnapshotRollbackInput): RollbackResult {
  const project = findProject(input.project_id)
  const guard = createSnapshot({
    request_id: input.request_id,
    project_id: input.project_id,
    kind: 'rollback_guard',
    summary: `回滚前保护快照：${input.reason}`,
    include_documents: true,
    health_status: 'healthy',
  })
  return {
    rolled_back: true,
    project_id: project.project_id,
    current_snapshot_id: input.snapshot_id,
    guard_snapshot_id: guard.snapshot_id,
  }
}

export function syncDocuments(input: DocumentSyncInput): DocumentSyncResult {
  const project = findProject(input.project_id)
  const dir = getDocumentsDir(project.workspace_slug, project.project_id)
  const doc: DocumentRef = {
    document_id: randomUUID(),
    type: input.checkpoint === 'mvp_tested' ? 'test_report' : 'prd',
    path: `${dir}/${input.checkpoint}.md`,
    status: 'synced',
  }
  writeJsonFile(doc.path, { checkpoint: input.checkpoint, changed_files: input.changed_files ?? [] })
  return { documents: [doc], stale_documents: [] }
}

export function trackAnalytics(input: AnalyticsTrackInput): AnalyticsTrackResult {
  const workspaceSlug = input.event.project_id ? findProject(input.event.project_id).workspace_slug : 'default-software-builder'
  const eventId = randomUUID()
  appendJsonLine(getAnalyticsPath(workspaceSlug), {
    event_id: eventId,
    ...input.event,
    created_at: new Date().toISOString(),
  })
  return { recorded: true, event_id: eventId }
}
