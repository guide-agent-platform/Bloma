// Preserve an interrupted/failed case. Only new test variants inside run-artifacts are writable.
import { cpSync, existsSync, mkdirSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve, relative, join, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
const [sourceArg, targetArg] = process.argv.slice(2)
const source = resolve(sourceArg || '')
const target = resolve(targetArg || '')
const rel = relative(resolve('run-artifacts'), target)
const sourceRel = relative(resolve(tmpdir()), source)
if (!sourceArg || !targetArg || isAbsolute(rel) || !rel || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') ||
    !sourceRel.startsWith('blr-') || existsSync(target)) throw new Error('Fresh workspace variant of an explicitly isolated test case required')
mkdirSync(target, { recursive: true })
cpSync(source, target, { recursive: true, filter: path => !relative(source, path).split(/[\\/]/).some(p =>
  ['.venv', '.git', '__pycache__', '00_VERIFY', 'data'].includes(p)) })
symlinkSync(join(source, '.venv'), join(target, '.venv'), 'junction')
const files = {}
for (const name of ['app.py', 'ui/index.html', 'CORE_CHECK.json']) if (existsSync(join(source, name))) {
  files[name] = createHash('sha256').update(readFileSync(join(source, name))).digest('hex')
}
writeFileSync(join(target, 'variant-source.json'), JSON.stringify({ source, source_files_sha256: files, original_code_modified: false }, null, 2))
console.log(JSON.stringify({ source, target, original_code_modified: false }))
