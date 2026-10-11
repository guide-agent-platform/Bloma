import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { runHostSpeechProbe, hasCurrentMicrophoneEvidence, recordManualSpeechComponentAcceptance } from '../../../main/desktop/speech-verification'
import { createHash } from 'node:crypto'
import { restorePromaHome } from '../../support/proma-home-guard'

let root: string
let base: string
const speech = { module: 'speech_runtime', factory: 'SpeechEngine', method: 'transcribe', rate_argument: true }
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'host-speech-'))
  root = join(base, 'project')
  mkdirSync(root)
  process.env.PROMA_HOME = join(base, 'home')
  writeFileSync(join(root, 'speech_runtime.py'), '# product boundary')
})
afterEach(() => { restorePromaHome(process.env.PROMA_HOME); rmSync(base, { recursive: true, force: true }) })
const report = { probe_version: 1, status: 'passed', real_decode_calls: 3, tests: ['flat', 'column', 'stereo'].map(name => ({ name, passed: true })), microphone: { status: 'not_run' } }

describe('host speech evidence', () => {
  it('human acceptance stays separate and only reuses byte-identical speech components', () => {
    writeFileSync(join(root, 'speech_locator.py'), '# locator')
    const components = { 'speech_runtime.py': createHash('sha256').update('# product boundary').digest('hex'),
      'speech_locator.py': createHash('sha256').update('# locator').digest('hex') }
    const evidence = join(base, 'observation.json')
    writeFileSync(evidence, JSON.stringify({ source: 'user_started_component_gui', status: 'failed', samples: 16000, text: '实际识别结果', errors: [], rms: .01, component_sha256: components }))
    recordManualSpeechComponentAcceptance(evidence, 'explicit user acceptance')
    expect(hasCurrentMicrophoneEvidence('p1', root, speech)).toBe(true)
    expect(hasCurrentMicrophoneEvidence('p1', root, { ...speech, factory: 'OtherEngine' })).toBe(false)
    writeFileSync(join(root, 'speech_runtime.py'), '# altered')
    expect(hasCurrentMicrophoneEvidence('p1', root, speech)).toBe(false)
  })
  it('normal delivery never enables microphone and requires actual decode observations', async () => {
    const passed = await runHostSpeechProbe({ projectId: 'p1', root, speech, spawn: async request => {
      expect(request.command).not.toContain('--microphone')
      expect(request.env.BLOMA_SPEECH_OFFLINE).toBe('1')
      return { code: 0, stdout: JSON.stringify(report), stderr: '' }
    } })
    expect(passed.status).toBe('passed')
    expect(hasCurrentMicrophoneEvidence('p1', root, speech)).toBe(false)
    const fake = await runHostSpeechProbe({ projectId: 'p1', root, speech, spawn: async () => ({ code: 0, stdout: JSON.stringify({ ...report, real_decode_calls: 0 }), stderr: '' }) })
    expect(fake.status).toBe('environment_blocked')
  })
  it('explicit successful capture is version bound and stale after code changes', async () => {
    const saved = await runHostSpeechProbe({ projectId: 'p1', root, speech, microphone: true, spawn: async () => ({ code: 0, stdout: JSON.stringify({ ...report, real_decode_calls: 4, microphone: { status: 'passed', rms: .02 } }), stderr: '' }) })
    expect(saved.status).toBe('passed')
    expect(hasCurrentMicrophoneEvidence('p1', root, speech)).toBe(true)
    writeFileSync(join(root, 'speech_runtime.py'), '# changed product')
    expect(hasCurrentMicrophoneEvidence('p1', root, speech)).toBe(false)
  })
})
