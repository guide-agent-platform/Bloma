import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject, findProject } from '../../../main/project/project-service'
import { isLeanProject, isSoftwareProject, usesLeanWorkflow } from '../../../main/desktop/workflow-policy'

let home: string, previous: string | undefined
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-lean-policy-')); process.env.PROMA_HOME = home })
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true }) })
describe('workflow rollout boundary', () => {
  it('persists host-selected lean projects without upgrading unmarked projects', () => {
    const old = createProject({ request_id: 'old', mode: 'quick' })
    const fresh = createProject({ request_id: 'new', mode: 'longterm' }, { workflowVersion: 'lean-v1' })
    expect(findProject(fresh.project_id).workflow_version).toBe('lean-v1')
    expect(isLeanProject(fresh.project_id)).toBe(true)
    expect(isLeanProject(old.project_id)).toBe(false)
    const software = createProject({ request_id: 'software', mode: 'quick' }, { workflowVersion: 'software-v1' })
    expect(isLeanProject(software.project_id)).toBe(true)
    expect(isSoftwareProject(software.project_id)).toBe(true)
    expect(isSoftwareProject(fresh.project_id)).toBe(false)
  })
  it('keeps experiments on their pinned policy and rejects unknown production versions', () => {
    expect(usesLeanWorkflow({ workflow_version: 'lean-v1' }, true)).toBe(false)
    expect(usesLeanWorkflow({ workflow_version: 'software-v1' }, true)).toBe(false)
    expect(() => usesLeanWorkflow({ workflow_version: 'unknown' } as never)).toThrow('WORKFLOW_VERSION_UNSUPPORTED')
  })
})
