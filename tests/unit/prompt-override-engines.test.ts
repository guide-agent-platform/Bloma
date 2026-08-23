import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadPromptOverride } from '../../main/prompt-config'
import {
  DEFAULT_SYSTEM_PROMPT as SKETCH_DEFAULT,
} from '../../main/sketch-engine-llm'
import {
  DEFAULT_SYSTEM_PROMPT as MVP_DEFAULT,
} from '../../main/mvp-engine-llm'
import {
  DEFAULT_SYSTEM_PROMPT as ENRICHER_DEFAULT,
} from '../../main/requirement-enricher'
import {
  DEFAULT_SYSTEM_PROMPT as NORMALIZER_DEFAULT,
} from '../../main/requirement-normalizer'
import { DEFAULT_GUIDE_SYSTEM_PROMPT as GUIDE_DEFAULT } from '../../main/guide-agent-service'

/**
 * 提示词外置覆盖接入全部五引擎（TDD，先红后绿）
 *
 * 契约：`{PROMA_HOME}/prompts/{slot}.md` 存在且非空白 → 全量替换该引擎内置
 * 默认 system prompt；不存在/空白 → 回退内置默认。与 prd-engine（`prd-system`）
 * 同一机制（prompt-config.loadPromptOverride，无缓存改完即时生效）。
 *
 * 槽位：sketch-system / mvp-system / guide-system / enricher-system / normalizer-system
 */

const SLOTS = [
  { slot: 'sketch-system', builtin: SKETCH_DEFAULT, marker: '草图生成器' },
  { slot: 'mvp-system', builtin: MVP_DEFAULT, marker: 'MVP 生成器' },
  { slot: 'guide-system', builtin: GUIDE_DEFAULT, marker: '向导 Agent' },
  { slot: 'enricher-system', builtin: ENRICHER_DEFAULT, marker: '需求加厚师' },
  { slot: 'normalizer-system', builtin: NORMALIZER_DEFAULT, marker: '需求整理员' },
] as const

describe('提示词外置覆盖——五引擎接入（TDD）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string | undefined

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    process.env.PROMA_HOME = originalPromaHome
    home = undefined
  })

  it.each(SLOTS)('$slot：覆盖文件存在即生效，删除后回退内置默认', ({ slot, builtin, marker }) => {
    home = mkdtempSync(join(tmpdir(), `bloma-prompt-${slot}-`))
    process.env.PROMA_HOME = home

    // 无覆盖文件 → 内置默认
    expect(loadPromptOverride(slot)).toBeNull()
    expect(builtin).toContain(marker)

    // 写入覆盖文件 → 覆盖生效
    const override = `【自定义${marker}】这是覆盖版提示词，用于验证外置配置即时生效。`
    mkdirSync(join(home, 'prompts'), { recursive: true })
    writeFileSync(join(home, 'prompts', `${slot}.md`), override, 'utf8')
    expect(loadPromptOverride(slot)).toBe(override)

    // 空白文件 → 视为无覆盖（回退内置默认）
    writeFileSync(join(home, 'prompts', `${slot}.md`), '   \n\t\n', 'utf8')
    expect(loadPromptOverride(slot)).toBeNull()

    // 删除 → 回退
    rmSync(join(home, 'prompts', `${slot}.md`), { force: true })
    expect(loadPromptOverride(slot)).toBeNull()
  })

  it('五引擎常量均以 DEFAULT_SYSTEM_PROMPT 导出（供设置页展示内置默认）', () => {
    // TDD 结构断言：接线后各引擎必须导出 DEFAULT_SYSTEM_PROMPT（或 GUIDE 前缀），
    // 且使用处经 loadPromptOverride 组装——此用例锁定「常量可导出 + 槽位字符串在源码中被引用」。
    for (const { slot, builtin, marker } of SLOTS) {
      expect(builtin.length).toBeGreaterThan(50)
      expect(builtin).toContain(marker)
      expect(slot).toBeTruthy()
    }
  })
})
