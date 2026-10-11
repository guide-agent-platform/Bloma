import { mkdtempSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { inspectSpeechResources } from '../../../main/desktop/resource-discovery'
import type { SpeechModelManifest } from '../../../main/platform/speech/model-manifest'
import { buildChildExecEnv } from '../../../main/desktop/child-exec-tool'
import { buildDesktopChildTools, buildDispatcherTools } from '../../../main/desktop/dispatcher-loop'
import { checkDispatcherToolGate } from '../../../main/desktop/dispatcher-gate'
import { DESKTOP_PHASES } from '../../../main/desktop/dispatcher-phases'
describe('read-only resources', () => {
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
  it('discovery is installed on parent and workers and allowed by the real phase gate', () => {
    expect(buildDispatcherTools('resource-fixture').some(t => t.name === 'inspect_project_resources')).toBe(true)
    expect(buildDesktopChildTools('resource-fixture', 'implement', 'diff').some(t => t.name === 'inspect_project_resources')).toBe(true)
    expect(checkDispatcherToolGate(DESKTOP_PHASES['desktop-arch'], 'inspect_project_resources')).toBeNull()
  })
})
