import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import type { Project } from '../../shared/types'
import { isModernWorkflowVersion } from '../../shared/workflow-version'

/** Frozen identity is independent of the former execution opt-in switch. */
export function workflowRetirementReason(project: Pick<Project, 'project_id' | 'workflow_version'>): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(project.project_id)) throw Error('WORKFLOW_PROJECT_ID_INVALID')
  if (existsSync(join(getPromaHome(), 'dispatch-experiments', project.project_id + '.json'))) {
    return '冻结实验的执行入口已退役；原始配置、事件、证据和账本保留，可只读查看或导出报告。'
  }
  if (project.workflow_version === undefined) return '旧版生成流程已退役。历史、产物和数据保留，可查看、启动已交付程序或导出；继续修改请在历史项目中选择“复制到新流程”。'
  if (!isModernWorkflowVersion(project.workflow_version)) return 'WORKFLOW_VERSION_UNSUPPORTED：无法执行未知版本，请先导出并核对来源。'
}
