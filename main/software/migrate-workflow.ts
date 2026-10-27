import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { findProject, updateProject } from '../project/project-service'
import { importSoftwareProject } from './import-project'
import { existsSync } from 'node:fs'

/** Explicit copy migration. The old index entry, receipts and budget stay intact;
 * copied artifacts do not confer confirmation or delivery authority on the copy. */
export async function migrateLegacyWorkflow(projectId: string, signal?: AbortSignal) {
  const original = findProject(projectId)
  if (original.workflow_version !== undefined && original.workflow_version !== 'lean-v1') throw Error('WORKFLOW_MIGRATION_NOT_LEGACY')
  if (existsSync(join(getPromaHome(), 'dispatch-experiments', projectId + '.json'))) throw Error('WORKFLOW_FROZEN_EXPERIMENT_READ_ONLY')
  const before = JSON.stringify(original)
  const copy = await importSoftwareProject(original.root_path, original.mode, signal)
  if (JSON.stringify(findProject(projectId)) !== before) throw Error('WORKFLOW_MIGRATION_SOURCE_METADATA_CHANGED')
  const metadata = { version: 1, project_id: copy.project_id, source_project_id: projectId, source_workflow: original.workflow_version ?? 'unmarked', at: new Date().toISOString(),
    source_metadata: original, copied_source_digest: copy.imported_source?.baseline_digest,
    note: '原项目及所有外部数据/账本保留；只复制源码目录（含其中的数据），不继承确认、PASS、外部运行时或费用授权。外部数据位置须在新任务单中核对。' }
  writeTextFileAtomic(join(getPromaHome(), 'workflow-migrations', copy.project_id + '.json'), JSON.stringify(metadata))
  return updateProject(copy.project_id, { name: `${original.name}（新流程副本）`, name_source: 'user', status: 'active', current_stage: 'clarifying', workflow_migration: { source_project_id: projectId, source_workflow: metadata.source_workflow, at: metadata.at } })
}
