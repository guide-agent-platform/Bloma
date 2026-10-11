// @vitest-environment jsdom
import React from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolBlocksReplay } from '../../renderer/components/ToolCallBlock'
import { formatToolFeedback } from '../../shared/tool-feedback'

afterEach(cleanup)
describe('tool history feedback presentation', () => {
  it('a successful process with no business evidence is shown as pending verification', () => {
    render(<ToolBlocksReplay blocks={[{ type: 'tool_result', tool_use_id: 'x', content: formatToolFeedback({ schema_version: 1, execution: 'completed', verification: 'unverified', source: 'fixed_input' }, 'captured fixture') }]} />)
    expect(screen.getByText('已执行，待验证')).toBeTruthy()
  })
  it('budget error preserves its actual category in replay', () => {
    render(<ToolBlocksReplay blocks={[{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: formatToolFeedback({ schema_version: 1, execution: 'not_run', verification: 'unverified', category: 'budget' }, 'stop') }]} />)
    expect(screen.getByText('额度已用尽')).toBeTruthy()
  })
})
