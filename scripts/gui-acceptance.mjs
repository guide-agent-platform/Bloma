import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const temporary = mkdtempSync(join(tmpdir(), 'bloma-gui-cli-'))
try {
  const output = join(temporary, 'entry.mjs')
  await build({ entryPoints: [join(root, 'scripts/gui-acceptance-entry.ts')], outfile: output,
    bundle: true, platform: 'node', format: 'esm', external: ['electron'], logLevel: 'silent' })
  const result = spawnSync(process.execPath, [output, ...process.argv.slice(2)], { cwd: root, windowsHide: true, stdio: 'inherit' })
  process.exitCode = result.status ?? 1
} finally { rmSync(temporary, { recursive: true, force: true }) }
