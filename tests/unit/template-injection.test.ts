import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPrdFewShotInjection } from '../../main/agent/prompting/template-injection'
const original = process.env.PROMA_HOME
let home: string

afterEach(() => {
  if (original === undefined) delete process.env.PROMA_HOME
  else process.env.PROMA_HOME = original
  if (home) rmSync(home, { recursive: true, force: true })
})
it('reads the active product example without obsolete execution/template slices', () => {
  home = mkdtempSync(join(tmpdir(), 'proma-inject-'))
  process.env.PROMA_HOME = home
  const section = buildPrdFewShotInjection('desktop_tool')
  expect(section).toContain('同类型产品示例')
  expect(section).toContain('批量重命名')
  expect(section!.length).toBeLessThan(900)
})
