import type { Project } from '../../shared/types'
import { findProject } from '../project/project-service'
import { readExperiment } from './dispatch-experiment'
import { isModernWorkflowVersion } from '../../shared/workflow-version'

/** Frozen experiments and unmarked historical projects never silently migrate. */
export function usesLeanWorkflow(project: Pick<Project, 'workflow_version'>, experimental = false): boolean {
  if (experimental) return false
  if (project.workflow_version === undefined) return false
  if (!isModernWorkflowVersion(project.workflow_version)) throw new Error('WORKFLOW_VERSION_UNSUPPORTED')
  return true
}

export function isLeanProject(projectId: string): boolean {
  return usesLeanWorkflow(findProject(projectId), Boolean(readExperiment(projectId)))
}

export function isSoftwareProject(projectId: string): boolean {
  return findProject(projectId).workflow_version === 'software-v1' && !readExperiment(projectId)
}
