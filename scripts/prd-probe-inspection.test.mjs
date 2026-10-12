import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPrdProbe } from './prd-probe-inspection.mjs'

test('Find the PRD before any generated product directory exists; reject ambiguity and mismatched identity', () => {
  const home = mkdtempSync(join(tmpdir(), 'bloma-prd-probe-binding-'))
  try {
    const project = { project_id: 'p', workspace_slug: 'builder', status: 'active', root_path: join(home, 'not-materialized') }
    writeFileSync(join(home, 'projects.json'), JSON.stringify([project]))
    const docDir = join(home, 'agent-workspaces/builder/documents/p')
    mkdirSync(docDir, { recursive: true })
    writeFileSync(join(docDir, 'prd.json'), JSON.stringify({ project_id: 'p', requirements: [] }))
    assert.equal(readPrdProbe(home).project.project_id, 'p')
    assert.equal(readPrdProbe(home, 'p').backplane.project_id, 'p')
    assert.throws(() => readPrdProbe(home, 'unknown'), /uniquely bind/)
    writeFileSync(join(home, 'projects.json'), JSON.stringify([project, { ...project, project_id: 'other' }]))
    assert.throws(() => readPrdProbe(home), /uniquely bind/)
    writeFileSync(join(docDir, 'prd.json'), JSON.stringify({ project_id: 'wrong' }))
    assert.throws(() => readPrdProbe(home, 'p'), /identity/)
  } finally { rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) }
})
