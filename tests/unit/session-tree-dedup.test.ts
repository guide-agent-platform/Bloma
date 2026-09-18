import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendSessionMessage, resetSessionTreeForTests } from '../../main/session-tree'
import { getAgentSessionPath } from '../../storage/config-paths'
import { restorePromaHome } from '../support/proma-home-guard'

/**
 * R2（2026-09-19 狗粮 7601e5ae 会话取证）：同一用户输入被双路径双写（点选回流先记、
 * orchestrator 下一轮输入再记；两轮连续点选时同文本三重）——回放气泡重复、模型
 * 上下文重复回灌。锁三点：同内容 3s 内 user 双写幂等跳过；不同内容/超窗不误伤；
 * tool_result 批（loop 侧合法同文案）不适用护栏。
 */

describe('R2 会话写入幂等护栏（session-tree）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'r2-session-tree-'))
    process.env.PROMA_HOME = home
    resetSessionTreeForTests()
  })
  afterEach(() => {
    restorePromaHome(originalPromaHome)
    rmSync(home, { recursive: true, force: true })
  })

  it('同内容 user 记录 3 秒内双写 → 只落一条（狗粮点选双写形态）', () => {
    const sid = 'r2-dup'
    const content = [{ type: 'text', text: '日常流水随手记' }]
    appendSessionMessage(sid, { role: 'user', content, timestamp: 1_000 })
    appendSessionMessage(sid, { role: 'system', content: [{ type: 'text', text: '[decision] …' }], timestamp: 1_100 })
    appendSessionMessage(sid, { role: 'user', content, timestamp: 2_000 })
    const lines = readFileSync(getAgentSessionPath(sid), 'utf8').trim().split('\n')
    const userRows = lines.filter((l) => l.includes('"role":"user"'))
    expect(userRows).toHaveLength(1)
  })

  it('同内容但超窗（>3s）→ 保留（用户真连发不误吞）', () => {
    const sid = 'r2-window'
    const content = [{ type: 'text', text: '继续' }]
    appendSessionMessage(sid, { role: 'user', content, timestamp: 1_000 })
    appendSessionMessage(sid, { role: 'user', content, timestamp: 10_000 })
    const lines = readFileSync(getAgentSessionPath(sid), 'utf8').trim().split('\n')
    expect(lines.filter((l) => l.includes('"role":"user"'))).toHaveLength(2)
  })

  it('tool_result 批同文案 3s 内重复 → 不适用护栏（审计完整性优先）', () => {
    const sid = 'r2-toolresult'
    const content = [{ type: 'tool_result', tool_use_id: 't1', content: '预览已启动：http://localhost:3001' }]
    appendSessionMessage(sid, { role: 'user', content, timestamp: 1_000 })
    appendSessionMessage(sid, { role: 'user', content, timestamp: 2_000 })
    const lines = readFileSync(getAgentSessionPath(sid), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
  })

  it('不同内容的连续 user 记录全保留；assistant 不受护栏影响', () => {
    const sid = 'r2-mixed'
    mkdirSync(join(home, 'agent-sessions'), { recursive: true })
    writeFileSync(getAgentSessionPath('warm'), '{"role":"user","content":[{"type":"text","text":"旧"}]}', 'utf8')
    appendSessionMessage(sid, { role: 'user', content: [{ type: 'text', text: 'A' }], timestamp: 1_000 })
    appendSessionMessage(sid, { role: 'user', content: [{ type: 'text', text: 'B' }], timestamp: 1_500 })
    appendSessionMessage(sid, { role: 'assistant', content: [{ type: 'text', text: '同话' }], timestamp: 1_600 })
    appendSessionMessage(sid, { role: 'assistant', content: [{ type: 'text', text: '同话' }], timestamp: 1_700 })
    const lines = readFileSync(getAgentSessionPath(sid), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(4)
  })
})
