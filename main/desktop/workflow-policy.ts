import type { Project } from '../../shared/types'
import { findProject } from '../project/project-service'
import { readExperiment } from './dispatch-experiment'

/** Frozen experiments and unmarked historical projects never silently migrate. */
export function usesLeanWorkflow(project: Pick<Project, 'workflow_version'>, experimental = false): boolean {
  if (experimental) return false
  if (project.workflow_version === undefined) return false
  if (project.workflow_version !== 'lean-v1') throw new Error('WORKFLOW_VERSION_UNSUPPORTED')
  return true
}

export function isLeanProject(projectId: string): boolean {
  return usesLeanWorkflow(findProject(projectId), Boolean(readExperiment(projectId)))
}
