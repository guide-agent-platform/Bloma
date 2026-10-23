import { describe, expect, it } from 'vitest'
import { buildProductionAgentPrompt, usesProductionAgent } from '../../../main/desktop/production-agent'
import { DESKTOP_PHASES } from '../../../main/desktop/dispatcher-phases'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { createProject, findProject } from '../../../main/project/project-service'
import { runDesktopDispatcherLoop } from '../../../main/desktop/dispatcher-loop'
import type { SDKQuery } from '../../../main/orchestration/stages/orchestration-contracts'
import * as productionBudget from '../../../main/desktop/production-budget'

describe('primary agent execution', () => {
  it('owns arch/scaffold/implementation but leaves independent verification and experiments intact', () => {
    for (const phase of ['desktop-arch', 'desktop-scaffold', 'desktop-implement'] as const) {
      expect(usesProductionAgent(DESKTOP_PHASES[phase], false)).toBe(true)
      expect(usesProductionAgent(DESKTOP_PHASES[phase], true)).toBe(false)
      const prompt = buildProductionAgentPrompt(DESKTOP_PHASES[phase], { projectName: '智学伴' })
      expect(prompt).toContain('可直接读取、编辑')
      expect(prompt).toContain('PHASE_ADVANCE')
      expect(prompt).not.toContain('你不直接写文件')
      expect(prompt).not.toContain('同一委派线续接')
    }
    expect(usesProductionAgent(DESKTOP_PHASES['desktop-verify'], false)).toBe(false)
  })
  it('edits a real project directly without delegation and does not manufacture a phase pass', async () => {
    vi.stubEnv('PROMA_HOME', mkdtempSync(join(tmpdir(), 'bloma-primary-agent-')))
    vi.stubEnv('BLOMA_DESKTOP_DISPATCH', '1')
    try {
      const project = createProject({ request_id: 'primary-agent', mode: 'quick' })
      const root = findProject(project.project_id).root_path
      let request = 0
      const query: SDKQuery = async function* () {
        const content = request++ === 0 ? [{ type: 'tool_use' as const, id: 'write', name: 'write_file', input: { path: 'core/feature.py', content: 'def answer():\n    return 42\n' } }]
          : [{ type: 'text' as const, text: '实现文件已保存，架构文档尚未完成。' }]
        yield { type: 'assistant', message: { role: 'assistant', content } }
        yield { type: 'result', subtype: 'success' }
      }
      const result = await runDesktopDispatcherLoop({ projectId: project.project_id, sessionId: 'primary', requestId: 'run',
        currentPhase: 'desktop-arch', task: '实现最小能力', projectName: 'probe', sandboxRoot: root, query, env: {},
        requirementsDigest: 'F-001 answer', maxTokens: 1024, signal: new AbortController().signal, publish: () => {} })
      expect(readFileSync(join(root, 'core/feature.py'), 'utf8')).toContain('return 42')
      expect(result.loopResult?.toolCalls.map(t => t.name)).toEqual(['write_file'])
      expect(result.advance?.decision).toBe('reject')
    } finally { vi.unstubAllEnvs() }
  })
  it('aborts the running provider on a host deadline and reports a local stop', async () => {
    vi.stubEnv('PROMA_HOME', mkdtempSync(join(tmpdir(), 'bloma-primary-deadline-')))
    vi.stubEnv('BLOMA_DESKTOP_DISPATCH', '1')
    vi.spyOn(productionBudget, 'productionDeadlineMs').mockReturnValue(25)
    // Start the clock after the provider is actually listening. SDK startup is
    // real asynchronous work and can itself exceed 25ms on a busy machine.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const project = createProject({ request_id: 'deadline', mode: 'quick' })
      let aborted = false
      let providerStarted!: () => void
      const started = new Promise<void>(resolve => { providerStarted = resolve })
      const query: SDKQuery = async function* (_prompt, options) {
        await new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason) }, { once: true })
          providerStarted()
        })
        yield { type: 'result', subtype: 'success' }
      }
      const running = runDesktopDispatcherLoop({ projectId: project.project_id, sessionId: 'primary', requestId: 'deadline',
        currentPhase: 'desktop-arch', task: 'probe', projectName: 'probe', sandboxRoot: findProject(project.project_id).root_path,
        query, env: {}, requirementsDigest: 'F-001', maxTokens: 1024, signal: new AbortController().signal, publish: () => {} })
      expect(await Promise.race([started.then(() => true), running.then(() => false)])).toBe(true)
      await vi.advanceTimersByTimeAsync(25)
      const result = await running
      expect(aborted).toBe(true)
      expect(result.status).toBe('error')
      expect(result.error_message).toContain('HARNESS_DEADLINE_EXCEEDED')
      expect(result.advance).toBeUndefined()
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs() }
  })
})
