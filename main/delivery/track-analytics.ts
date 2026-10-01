// 交付埋点汇（PR3a 自 platform-services 拆出）：analytics.jsonl 追加；项目缺失兜底默认工作区。
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createServer } from 'node:net'
import type {
  AnalyticsTrackInput,
  AnalyticsTrackResult,
  RollbackResult,
  SandboxRunInput,
  SandboxRunResult,
  SandboxStopInput,
  SandboxStopResult,
  Snapshot,
  SnapshotCreateInput,
  SnapshotDocumentEntry,
  SnapshotDocumentListResult,
  SnapshotRollbackInput,
} from '../../shared/types'
import { getAnalyticsPath, getDocumentsDir, getSnapshotsDir } from '../../storage/config-paths'
import { appendJsonLine, readJsonFile, writeJsonFile } from '../../storage/json-store'
import { readDocumentsManifest } from '../project/document-engine'
import { findProject, updateProject } from '../project/project-service'
import { PRODUCT_CSP } from '../coding/product-csp'

export function trackAnalytics(input: AnalyticsTrackInput): AnalyticsTrackResult {
  const workspaceSlug = resolveAnalyticsWorkspace(input.event.project_id)
  const eventId = randomUUID()
  appendJsonLine(getAnalyticsPath(workspaceSlug), {
    event_id: eventId,
    ...input.event,
    created_at: new Date().toISOString(),
  })
  return { recorded: true, event_id: eventId }
}

/** 项目缺失（已归档/删除）时兜底到默认工作区，不让埋点失败反噬业务。 */
function resolveAnalyticsWorkspace(projectId: string | undefined): string {
  if (!projectId) return 'default-software-builder'
  try {
    return findProject(projectId).workspace_slug
  } catch {
    return 'default-software-builder'
  }
}
