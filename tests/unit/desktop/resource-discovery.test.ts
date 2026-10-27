import { mkdtempSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { inspectSpeechResources, buildResourceDiscoveryTool } from '../../../main/desktop/resource-discovery'
import { createProject } from '../../../main/project/project-service'
import { createToolState } from '../../../main/agent/loop/agent-loop'
import type { SpeechModelManifest } from '../../../main/platform/speech/model-manifest'
import { buildChildExecEnv } from '../../../main/desktop/child-exec-tool'



describe('read-only resources', () => {
  it('actual Python inspection reports missing resources without downloading or claiming business success', async () => {
    const project = createProject({ request_id: 'actual-resource-probe', mode: 'quick' })
    const result = await buildResourceDiscoveryTool(project.project_id, { modelRoot: join(project.root_path, 'absent-models') }).execute({}, {
      projectId: project.project_id, sessionId: 'resource-probe', requestId: 'resource-probe', signal: new AbortController().signal, state: createToolState(),
    })
    expect(result.isError).toBeFalsy()
    const observed = JSON.parse(result.output)
    expect(observed.environment.python).toMatch(/^3\./)
    expect(observed.speech).toMatchObject({ ready: false, downloaded: false })
    expect(observed.business_verification).toBe('unverified')
    expect(result.feedback?.scope).toBe('resource_inventory')
  }, 35000)
  it('checks actual bytes, reuses unchanged results and invalidates damaged or deleted files without downloading', async () => {
    const root = mkdtempSync(join(tmpdir(), 'resource-test-'))
    const asset = (name: string) => ({ name, url: 'https://never-fetched.invalid', bytes: 3, sha256: createHash('sha256').update('abc').digest('hex') })
    const manifest: SpeechModelManifest = { model: asset('model'), tokens: asset('tokens'), vad: asset('vad') }
    for (const entry of Object.values(manifest)) writeFileSync(join(root, entry.name), 'abc')
    expect((await inspectSpeechResources(root, manifest)).ready).toBe(true)
    expect((await inspectSpeechResources(root, manifest)).assets.every(a => a.reused_check)).toBe(true)
    writeFileSync(join(root, 'model'), 'def')
    expect((await inspectSpeechResources(root, manifest)).assets[0]).toMatchObject({ status: 'invalid', reused_check: false })
    unlinkSync(join(root, 'tokens'))
    const missing = await inspectSpeechResources(root, manifest)
    expect(missing.ready).toBe(false)
    expect(missing.downloaded).toBe(false)
  })
  it('resource variables survive execution filtering but channel credentials do not', () => {
    const env = buildChildExecEnv({ PROMA_HOME: 'test', BLOMA_SPEECH_MODEL_DIR: 'models', BLOMA_SECRET_CHANNEL_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret' })
    expect(env.BLOMA_SPEECH_MODEL_DIR).toBe('models')
    expect(env.PROMA_HOME).toBe('test')
    expect(env).not.toHaveProperty('BLOMA_SECRET_CHANNEL_KEY')
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
  })

})
