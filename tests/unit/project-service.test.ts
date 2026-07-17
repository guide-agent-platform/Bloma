import { describe, expect, it } from 'vitest'
import { isWorkflowStage } from '../../main/project-service'

describe('ProjectService stage validation', () => {
  it('accepts documented workflow stages', () => {
    expect(isWorkflowStage('clarifying')).toBe(true)
    expect(isWorkflowStage('blocked_for_user_decision')).toBe(true)
  })

  it('rejects undocumented workflow stages', () => {
    expect(isWorkflowStage('unknown_stage')).toBe(false)
  })
})
