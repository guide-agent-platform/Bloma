// Internal file/metadata preparation only; never starts a model or copies channel credentials.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const output = join(mkdtempSync(join(tmpdir(), 'bloma-experiment-cli-')), 'entry.mjs')
try {
  await build({ entryPoints: [join(root, 'scripts/dispatch-experiment-entry.ts')], outfile: output,
    bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const result = spawnSync(process.execPath, [output, ...process.argv.slice(2)], { cwd: root, windowsHide: true, stdio: 'inherit' })
  process.exitCode = result.status ?? 1
} finally { if (existsSync(output)) unlinkSync(output); rmdirSync(dirname(output)) }
