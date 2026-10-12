// Read-only source snapshot for independent execution. No venv links or business data copy.
import { lstatSync, realpathSync, readdirSync, readFileSync, mkdirSync, copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve, relative, isAbsolute, join, dirname } from 'node:path'
const [sourceArg, targetArg] = process.argv.slice(2)
if (!sourceArg || !targetArg) throw new Error('Explicit source and fresh target required')
const source = realpathSync(sourceArg), target = resolve(targetArg)
const origin = relative(realpathSync(tmpdir()), source)
const dest = relative(resolve('run-artifacts'), target)
if (!origin.split(/[\\/]/)[0]?.startsWith('bloma-complex-') || isAbsolute(origin) || origin.startsWith('..') ||
    !source.includes('generated-projects') || !dest || isAbsolute(dest) || dest.startsWith('..') || existsSync(target)) throw new Error('Owned isolated test source and fresh artifact target required')
const skipped = new Set(['.venv', '.git', '__pycache__', 'node_modules', 'data', '00_VERIFY', '00_HISTORY'])
const list = []
function walk(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (skipped.has(entry.name) || entry.name.startsWith('.')) continue
    const file = join(path, entry.name)
    if (lstatSync(file).isSymbolicLink()) throw new Error('Linked source is not copied')
    if (entry.isDirectory()) walk(file)
    else list.push(relative(source, file))
  }
}
walk(source)
const hashes = () => Object.fromEntries(list.map(name => [name.replaceAll('\\', '/'), createHash('sha256').update(readFileSync(join(source, name))).digest('hex')]))
const before = hashes()
mkdirSync(target, { recursive: true })
for (const name of list) { mkdirSync(dirname(join(target, name)), { recursive: true }); copyFileSync(join(source, name), join(target, name)) }
const after = hashes()
if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Source changed during copy; this snapshot is not a stable baseline')
const report = { source, target, source_files_sha256: before, source_unchanged_during_copy: true,
  python: join(source, '.venv', 'Scripts', 'python.exe'), venv_copied_or_linked: false, business_data_copied: false }
writeFileSync(join(target, 'snapshot-source.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ target, copied_files: list.length, source_unchanged_during_copy: true }))
