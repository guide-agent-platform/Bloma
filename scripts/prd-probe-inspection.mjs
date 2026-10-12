import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** PRD exists before generated-projects is materialized. Bind to the host catalogue, not product directories. */
export function readPrdProbe(home, projectId) {
  const catalogue = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8'))
  const projects = Array.isArray(catalogue) ? catalogue : catalogue.projects ?? []
  const candidates = projectId ? projects.filter(project => project.project_id === projectId) : projects.filter(project => project.status === 'active')
  if (candidates.length !== 1) throw new Error('Cannot uniquely bind the PRD probe to the active project')
  const project = candidates[0]
  const path = join(home, 'agent-workspaces', project.workspace_slug, 'documents', project.project_id, 'prd.json')
  if (!existsSync(path)) throw new Error('PRD confirmation appeared without a persisted PRD')
  const backplane = JSON.parse(readFileSync(path, 'utf8'))
  if (backplane.project_id !== project.project_id) throw new Error('PRD identity does not match the host project')
  return { project, backplane, path }
}
