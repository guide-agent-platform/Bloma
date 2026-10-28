import { expect, it } from 'vitest'
import { runCapabilityVerifiers, type CapabilityContext } from '../../../main/desktop/capability-verifiers'

const context = (manifest: Record<string, unknown>): CapabilityContext => ({ projectId: 'fixture', root: process.cwd(), manifest,
  backplane: { requirements: [{ id: 'F-001', description: '讲解', capabilities: ['llm'] }, { id: 'F-002', description: '追问', capabilities: ['llm'] }] } as never })
it('names missing and unknown model feature mappings before trying an invalid client', async () => {
  await expect(runCapabilityVerifiers(context({ llm: { module: 'must-not-load', factory: 'Client', method: 'call', covers: ['F-001', 'F-999'] } })))
    .rejects.toThrow(/MODEL_COVERAGE_INVALID:.*"missing":\["F-002"\].*"unknown":\["F-999"\]/)
})
it('keeps undeclared model features unverified and identifies the missing feature IDs', async () => {
  const results = await runCapabilityVerifiers(context({}))
  expect(results[0]).toMatchObject({ status: 'unverified', features: { 'F-001': 'unverified', 'F-002': 'unverified' } })
  expect(results[0].missing.join()).toContain('F-001,F-002')
})
