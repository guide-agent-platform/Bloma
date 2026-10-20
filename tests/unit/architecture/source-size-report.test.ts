import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('reports large modules at a configurable threshold without failing architecture or hiding exempt files', () => {
  const root = mkdtempSync(join(tmpdir(), 'source-size-report-'))
  try {
    mkdirSync(join(root, 'main'))
    writeFileSync(join(root, 'main', 'cohesive.ts'), '// comment\n'.repeat(900))
    const run = (threshold: string) => spawnSync(process.execPath, ['scripts/source-size-report.mjs', '--root', root, '--threshold', threshold], { encoding: 'utf8', windowsHide: true })
    const report = run('800')
    expect(report.status).toBe(0)
    expect(JSON.parse(report.stdout)).toMatchObject({ mode: 'informational', review_candidates: [{ path: 'main/cohesive.ts', lines: 901 }] })
    expect(JSON.parse(run('1000').stdout).review_candidates).toEqual([])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
