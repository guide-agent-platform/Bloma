import test from 'node:test'
import assert from 'node:assert/strict'
import { selectPipelineConfirmation, selectReviewDelegation } from './lib/dogfood-card-policy.mjs'

test('nested global review options delegate without waiving review issues', () => {
  assert.deepEqual(selectPipelineConfirmation({ kind: 'prd_review',
    review_questions: [{ id: 'issue', options: [{ id: 'issue:ignore' }] }],
    global_options: [{ id: 'prd_review_delegate_all' }] }), { kind: 'option', id: 'prd_review_delegate_all' })
})

test('an exhausted or disabled review stops instead of inventing a delegate click', () => {
  for (const global_options of [[], [{ id: 'prd_review_override' }], [{ id: 'prd_review_delegate_all', disabled: true }]]) {
    assert.deepEqual(selectPipelineConfirmation({ kind: 'prd_review', global_options }),
      { kind: 'stop', reason: 'prd_review_unresolved' })
  }
  assert.equal(selectReviewDelegation([{ kind: 'review', id: 'override', label: '全部交给向导决定' }]), undefined)
  assert.equal(selectReviewDelegation([{ kind: 'clarify', id: 'prd_review_delegate_all' }]), undefined)
})

test('unknown cards and absence stop without spending a generic continue round', () => {
  assert.deepEqual(selectPipelineConfirmation({ kind: 'other', questions: [{ id: 'auto' }] }),
    { kind: 'stop', reason: 'unsupported_card' })
  assert.deepEqual(selectPipelineConfirmation(undefined), { kind: 'stop', reason: 'no_card' })
  assert.equal(selectPipelineConfirmation({ kind: 'toString' }).kind, 'stop')
})

test('ordinary confirmations retain their distinct transport', () => {
  assert.deepEqual(selectPipelineConfirmation({ kind: 'requirement_confirm' }), { kind: 'requirement_confirm' })
  for (const [kind, id] of [['prd_confirm', 'prd_confirm_confirm'], ['ux_confirm', 'ux_confirm_go'], ['mvp_confirm', 'mvp_confirm_go']]) {
    assert.deepEqual(selectPipelineConfirmation({ kind }), { kind: 'option', id })
  }
})
