import { describe, expect, it } from 'vitest'
import { readProjectAttempts, consumeProjectAttempt, resetProjectAttemptScope } from '../../main/platform/execution/project-attempts'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
describe('durable attempt accounting', () => {
  it('recreation does not refill quotas; explicit resume resets active but retains history', () => {
    const id = 'attempt-restart-test'
    expect(consumeProjectAttempt(id, 'script:child', 2).allowed).toBe(true)
    expect(consumeProjectAttempt(id, 'script:child', 2).used).toBe(2)
    expect(readProjectAttempts(id).active['script:child']).toBe(2)
    expect(consumeProjectAttempt(id, 'script:child', 2).allowed).toBe(false)
    resetProjectAttemptScope(id, 'script:child')
    expect(consumeProjectAttempt(id, 'script:child', 2)).toEqual({ allowed: true, used: 1, total: 3 })
  })
  it('unreadable history never becomes a fresh empty quota', () => {
    consumeProjectAttempt('attempt-corrupt-test', 'core', 2)
    writeFileSync(join(getPromaHome(), 'execution-attempts/attempt-corrupt-test.json'), '{broken')
    expect(() => consumeProjectAttempt('attempt-corrupt-test', 'core', 2)).toThrow()
  })
})
