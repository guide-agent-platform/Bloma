import type { Project } from '../../shared/types'
import { findProject } from '../project/project-service'
import { workflowRetirementReason } from './workflow-retirement'
import { isModernWorkflowVersion } from '../../shared/workflow-version'

/** Frozen experiments and unmarked historical projects never silently migrate. */
export function usesLeanWorkflow(project: Pick<Project, 'workflow_version'>, experimental = false): boolean {
  if (experimental) return false
  if (project.workflow_version === undefined) return false
  if (!isModernWorkflowVersion(project.workflow_version)) throw new Error('WORKFLOW_VERSION_UNSUPPORTED')
  return project.workflow_version === 'software-v1'
}

export function isLeanProject(projectId: string): boolean {
  const project=findProject(projectId)
  return usesLeanWorkflow(project) && !workflowRetirementReason(project)
}

export function isSoftwareProject(projectId: string): boolean {
  const project=findProject(projectId)
  return project.workflow_version === 'software-v1' && !workflowRetirementReason(project)
}
