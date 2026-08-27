/**
 * config-paths 存储路径防御（PROMA_HOME 污染）
 *
 * 背景：Node 中 `process.env.X = undefined` 会被强制转成字符串 "undefined"，
 * 测试 teardown 裸恢复 env 时会把 PROMA_HOME 污染成 "undefined"（相对路径）。
 * 若 getPromaHome() 不防御，写入会落到 cwd（项目根）下的 `./undefined/agent-sessions/`
 * （已在 Bloma 根目录实际观察到 20+ 个污染文件，详见 automation notes 2026-08-27）。
 *
 * 对齐：docs/06_TESTS/testing-standards.md §3 STORE 功能域；config-paths.ts 注释
 * （"PROMA_HOME 被污染时甚至会在 cwd 下建出 undefined/agent-workspaces/..."）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getAgentSessionPath, getPromaHome } from '../../storage/config-paths'

const originalPromaHome = process.env.PROMA_HOME

afterEach(() => {
  // 安全恢复：本机未设 PROMA_HOME 时用 delete，绝不把 undefined 赋回 env（避免污染字符串 "undefined"）
  if (originalPromaHome === undefined) delete process.env.PROMA_HOME
  else process.env.PROMA_HOME = originalPromaHome
})

describe('PROMA_HOME 污染防御（字符串 "undefined"）', () => {
  it('[S0-STORE-007] getPromaHome 在 PROMA_HOME 为字符串 "undefined" 时回退用户主目录 .proma', () => {
    process.env.PROMA_HOME = 'undefined'
    const home = getPromaHome()
    expect(home).not.toBe('undefined')
    expect(home).toContain('.proma')
    // 回退路径必须是绝对路径（基于用户主目录），而不是相对路径 "undefined"
    expect(join(home, 'agent-sessions')).not.toMatch(/^undefined[\\/]/)
  })

  it('[S0-STORE-007] 污染变体统一防御：null/空串/纯空格/带空格变体均回退主目录（参数化）', () => {
    // 与 product 层 getPromaHome 的 trim 后拒 "undefined"/"null"/空串 语义一一对应
    const variants = ['null', '', '   ', ' undefined ', ' null ']
    for (const polluted of variants) {
      process.env.PROMA_HOME = polluted
      const home = getPromaHome()
      expect(home, `PROMA_HOME=${JSON.stringify(polluted)}`).not.toBe(polluted)
      expect(home, `PROMA_HOME=${JSON.stringify(polluted)}`).toContain('.proma')
      expect(join(home, 'agent-sessions')).not.toMatch(/^undefined[\\/]/)
    }
  })

  it('[S0-STORE-007] getAgentSessionPath 在污染时不产生 cwd 下的相对 "undefined" 会话路径', () => {
    process.env.PROMA_HOME = 'undefined'
    // 纯路径断言，不调用 getAgentSessionPath（避免触发 ensureDir 在真实 ~/.proma 建目录的副作用）
    const sessionPath = join(getPromaHome(), 'agent-sessions', 's1.jsonl')
    expect(sessionPath.split(/[\\/]/).includes('undefined')).toBe(false)
    expect(sessionPath.startsWith(tmpdir()) || sessionPath.includes('.proma')).toBe(true)
  })

  it('[S0-STORE-007] 污染时写入落点隔离：临时 PROMA_HOME 下 mkdir 不落到 cwd 或真实主目录', () => {
    const home = mkdtempSync(join(tmpdir(), 'bloma-probe-home-'))
    process.env.PROMA_HOME = home
    const sessionPath = getAgentSessionPath('s-isolated')
    expect(sessionPath).toContain(join(home, 'agent-sessions'))
    expect(sessionPath.split(/[\\/]/).includes('undefined')).toBe(false)
    rmSync(home, { recursive: true, force: true })
  })

  it('[S0-STORE-007] 正常 PROMA_HOME 值不受影响（不破坏既有行为）', () => {
    const custom = join(tmpdir(), 'bloma-probe-home')
    process.env.PROMA_HOME = custom
    expect(getPromaHome()).toBe(custom)
    expect(getAgentSessionPath('s2')).toContain(join(custom, 'agent-sessions'))
  })
})
