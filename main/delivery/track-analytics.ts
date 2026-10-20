// 交付埋点汇（PR3a 自 platform-services 拆出）：analytics.jsonl 追加；项目缺失兜底默认工作区。
import { randomUUID } from 'node:crypto'





import type { AnalyticsTrackInput, AnalyticsTrackResult } from '../../shared/types';
import { getAnalyticsPath } from '../../storage/config-paths';
import { appendJsonLine } from '../../storage/json-store';

import { findProject } from '../project/project-service';


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
