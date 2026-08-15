import { describe, expect, it } from 'vitest'
import { GUIDE_SYSTEM_PROMPT } from '../../main/guide-agent-service'

/**
 * GUIDE_SYSTEM_PROMPT 澄清选项约束（S2-AGENT）。
 *
 * 背景：澄清卡片选项曾生成"游戏类型"这类笼统大类，用户无法选择"到底是什么样的游戏类型"。
 * 要求 prompt 明确引导模型生成具体可执行的子类型选项。
 */
describe('GUIDE_SYSTEM_PROMPT 澄清选项约束', () => {
  it('要求澄清选项是具体子类型而非笼统大类', () => {
    expect(GUIDE_SYSTEM_PROMPT).toContain('具体子类型')
    expect(GUIDE_SYSTEM_PROMPT).toContain('不能是笼统大类')
    // 反例：明确禁止"游戏类型"这种无法细分的选项
    expect(GUIDE_SYSTEM_PROMPT).toContain('游戏类型')
    // 正例：给出具体可执行的子类型示范
    expect(GUIDE_SYSTEM_PROMPT).toContain('角色扮演')
  })
})
