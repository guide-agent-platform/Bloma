import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 源码锚（2026-10-06 根因报告发现②修复）：形态引导卡 web_to_desktop 路径必须走
 * UX 草图门（runUxConfirmGate），不得直调 enterDesktopLine——确认门矩阵
 * （quick=PRD+UX / longterm=PRD+UX+MVP）在任何改品类路径上不得有缝隙。
 * 2026-10-06 前实锤：直调绕过 UX 门，PRD 确认到 arch 之间用户没看过草图。
 * 源码活读取双向对账（T8-004 同形态）：手写漂移即红。
 */
const source = readFileSync(join(process.cwd(), 'main/orchestration/stages/agent-dispatch.ts'), 'utf8')

function functionBody(name: string): string {
  const start = source.indexOf(`function ${name}`)
  expect(start, `函数 ${name} 应存在于 agent-dispatch.ts`).toBeGreaterThan(0)
  const next = source.indexOf('\nfunction ', start + 1)
  return source.slice(start, next > 0 ? next : undefined)
}

describe('形态卡回传走 UX 门（源码锚）', () => {
  it('resolveWebLineRetiredCard 分支调用 runUxConfirmGate', () => {
    const body = functionBody('resolveWebLineRetiredCard')
    expect(body).toContain('runUxConfirmGate')
  })

  it('resolveWebLineRetiredCard 不直调 enterDesktopLine（确认后由 ux-confirm 进桌面线）', () => {
    const body = functionBody('resolveWebLineRetiredCard')
    expect(body).not.toContain('enterDesktopLine(')
  })
})
