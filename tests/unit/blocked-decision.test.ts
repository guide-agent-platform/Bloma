import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { syncDocuments } from '../../main/document-engine'
import {
  resolveBlockedDecision,
  resumeBlockedFlow,
  setProgrammingEventPublisher,
} from '../../main/programming-orchestrator'
import { createProject, findProject, recordSketchGenerated, updateProject } from '../../main/project-service'
import type { AgentEvent } from '../../shared/types'

/**
 * A2/A3 — 阻塞态让渡 + resume 闭环。
 *
 * 锁定两件事：
 * - resolveBlockedDecision：消费 metadata.selected_option_id（A3），并区分编程阻塞 vs 引导澄清。
 * - resumeBlockedFlow：继续/接受/补充说明三分支的真实语义（A2），而非退回重新澄清。
 */
describe('Blocked decision resume loop (A2/A3)', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    setProgrammingEventPublisher(() => undefined)
  })

  function makeBlockedProject(blockedAction: 'mvp_repair' | 'test_repair' | 'judge_return') {
    const home = mkdtempSync(join(tmpdir(), 'proma-blocked-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    updateProject(project.project_id, { blocked_action: blockedAction })
    return project
  }

  describe('resolveBlockedDecision', () => {
    it('returns undefined for non-blocked stages even if blocked_action is set', () => {
      const project = makeBlockedProject('mvp_repair')
      const decision = resolveBlockedDecision({
        request_id: 'req', session_id: 's', project_id: project.project_id,
        content: '继续尝试', mode: 'quick', current_stage: 'generating_mvp',
        metadata: { source: 'card_option', selected_option_id: 'continue' },
      })
      expect(decision).toBeUndefined()
    })

    it('returns undefined for the clarification blocked state (no blocked_action)', () => {
      const home = mkdtempSync(join(tmpdir(), 'proma-blocked-'))
      process.env.PROMA_HOME = home
      const project = createProject({ request_id: 'req-project', mode: 'quick' })
      // 引导澄清态：current_stage 也是 blocked_for_user_decision，但没有 blocked_action
      const decision = resolveBlockedDecision({
        request_id: 'req', session_id: 's', project_id: project.project_id,
        content: '范围选项', mode: 'quick', current_stage: 'blocked_for_user_decision',
        metadata: { source: 'card_option', selected_option_id: 'scope' },
      })
      expect(decision).toBeUndefined()
    })

    it('maps card_option selected_option_id to the corresponding decision (A3)', () => {
      const project = makeBlockedProject('test_repair')
      const base = { request_id: 'req', session_id: 's', project_id: project.project_id, mode: 'quick' as const }
      const resolve = (id: string) => resolveBlockedDecision({
        ...base, content: '', current_stage: 'blocked_for_user_decision',
        metadata: { source: 'card_option', selected_option_id: id },
      })
      expect(resolve('continue')).toBe('continue')
      expect(resolve('accept')).toBe('accept')
      expect(resolve('explain')).toBe('explain')
    })

    it('falls back to continue for an unknown card option id', () => {
      const project = makeBlockedProject('mvp_repair')
      const decision = resolveBlockedDecision({
        request_id: 'req', session_id: 's', project_id: project.project_id,
        content: '', mode: 'quick', current_stage: 'blocked_for_user_decision',
        metadata: { source: 'card_option', selected_option_id: 'some-legacy-id' },
      })
      expect(decision).toBe('continue')
    })

    it('falls back to free-text heuristics when the user types instead of tapping a card', () => {
      const project = makeBlockedProject('judge_return')
      const base = { request_id: 'req', session_id: 's', project_id: project.project_id, mode: 'quick' as const }
      const resolve = (content: string) => resolveBlockedDecision({
        ...base, content, current_stage: 'blocked_for_user_decision', metadata: { source: 'chat' },
      })
      expect(resolve('接受现状，就这样吧')).toBe('accept')
      expect(resolve('继续尝试再修一次')).toBe('continue')
      expect(resolve('这里不该这样')).toBe('explain')
    })
  })

  describe('resumeBlockedFlow', () => {
    it('accept → clears the block, resets counts, and moves the project to ready', async () => {
      const project = makeBlockedProject('test_repair')
      updateProject(project.project_id, { runtime_repair_count: 3, test_repair_count: 3, judge_return_count: 2 })
      const events: AgentEvent[] = []
      setProgrammingEventPublisher((event) => events.push(event))

      await resumeBlockedFlow(
        { request_id: 'req', session_id: 's', project_id: project.project_id, mode: 'quick', decision: 'accept', content: '' },
        (event) => events.push(event),
      )

      const after = findProject(project.project_id)
      expect(after.current_stage).toBe('ready')
      expect(after.blocked_action).toBeUndefined()
      expect(after.runtime_repair_count).toBe(0)
      expect(after.test_repair_count).toBe(0)
      expect(after.judge_return_count).toBe(0)
      expect(events.some((event) => event.type === 'stage_changed' && event.payload.stage === 'ready')).toBe(true)
    })

    it('explain → clears the block and returns to the clarifying stage', async () => {
      const project = makeBlockedProject('mvp_repair')
      const events: AgentEvent[] = []
      setProgrammingEventPublisher((event) => events.push(event))

      await resumeBlockedFlow(
        { request_id: 'req', session_id: 's', project_id: project.project_id, mode: 'quick', decision: 'explain', content: '' },
        (event) => events.push(event),
      )

      const after = findProject(project.project_id)
      expect(after.current_stage).toBe('clarifying')
      expect(after.blocked_action).toBeUndefined()
      expect(events.some((event) => event.type === 'stage_changed' && event.payload.stage === 'clarifying')).toBe(true)
    })

    it('continue + judge_return → re-runs judge review instead of re-clarifying', async () => {
      const project = makeBlockedProject('judge_return')
      // 铺设能让裁判判 pass 的素材：草图需求 + 文档 + 含核心功能点的页面
      recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
      syncDocuments({ request_id: 'req-sync', session_id: 'session-1', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
      writeFileSync(join(project.root_path, 'index.html'), '<p>记录收入与支出</p>', 'utf8')
      updateProject(project.project_id, { judge_return_count: 3 })

      await resumeBlockedFlow(
        { request_id: 'req', session_id: 's', project_id: project.project_id, mode: 'quick', decision: 'continue', content: '' },
        () => undefined,
      )

      const after = findProject(project.project_id)
      // 重新走裁判 → 判定通过 → ready（而不是停在 clarifying/blocked）
      expect(after.current_stage).toBe('ready')
      expect(after.blocked_action).toBeUndefined()
      expect(after.judge_return_count ?? 0).toBe(0)
    })
  })
})
