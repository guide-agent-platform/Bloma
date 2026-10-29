import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { findProject } from '../project/project-service'
import { resolveProjectRoot } from '../../shared/project-root-override'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import { importedProjectContext, importedProjectChanges } from './import-project'
import { redactSoftwareOutput } from './process-manager'

const ignored = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', 'dist', 'build', '00_HISTORY', '00_VERIFY'])
const sourceFile = /\.(?:[cm]?[jt]sx?|py|rs|go|java|cs|cpp|c|h|html|css|json|toml|md|yaml|yml|lock|mod|txt)$|^\.python-version$/i
const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
export function repositoryFiles(root: string): string[] {
  const files: string[] = []
  const visit = (directory: string, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ignored.has(entry.name)) continue
      const path = prefix + entry.name
      if (entry.isDirectory()) { if (path.split('/').length > 48) throw Error('REPOSITORY_DEPTH_LIMIT'); visit(join(directory, entry.name), `${path}/`) }
      else if (entry.isFile() && sourceFile.test(entry.name)) { if (files.length >= 100000) throw Error('REPOSITORY_FILE_LIMIT'); files.push(path) }
    }
  }
  visit(root); return files.sort()
}
function ownedFile(root: string, path: string) {
  const base = realpathSync(root), file = realpathSync(resolve(base, path)), rel = relative(base, file)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !statSync(file).isFile()) throw Error('REPOSITORY_FILE_OUTSIDE_PROJECT')
  if (rel.split(sep).some(part => ['.git', 'node_modules', '.venv'].includes(part))) throw Error('REPOSITORY_DEPENDENCY_FILE_USE_PACKAGE_MANAGER')
  return { file, path: rel.replaceAll(sep, '/') }
}
export function repositoryFileFacts(projectId: string, root: string, requested: string) {
  const { file, path } = ownedFile(root, requested), info = statSync(file)
  if (info.size > 2 * 1024 * 1024) throw Error('REPOSITORY_FILE_TOO_LARGE: 用read_file的有界行窗口读取')
  const bytes = readFileSync(file), sha256 = digest(bytes), cache = join(getPromaHome(), 'software-repository-facts', projectId, `${digest(path)}.json`)
  if (existsSync(cache)) {
    try { const value = JSON.parse(readFileSync(cache, 'utf8')); if (value.sha256 === sha256 && value.path === path) return { ...value, reused: true } } catch { /* stale index is not authority */ }
  }
  const declarations: Array<{ name: string; line: number; kind: string }> = [], imports: Array<{ target: string; line: number }> = []
  const lines = bytes.toString('utf8').split(/\r?\n/)
  for (const [i, line] of lines.entries()) {
    const declaration = /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(function|class|interface|type|enum|const|let|var|def|struct|fn)\s+([A-Za-z_$][\w$]*)/.exec(line)
    if (declaration && declarations.length < 100) declarations.push({ kind: declaration[1], name: declaration[2], line: i + 1 })
    const imported = /(?:\bfrom\s+|\brequire\(\s*|\bimport\s*)["']([^"']+)["']/.exec(line) ?? /^\s*(?:from|import)\s+([\w.]+)/.exec(line)
    if (imported && imports.length < 100) imports.push({ target: imported[1], line: i + 1 })
  }
  const facts = { version: 1, path, sha256, lines: lines.length, declaration_candidates: declarations, import_candidates: imports,
    boundary: '按源码提取的定位候选，非语言服务器语义结论或测试通过证据；缓存每次按实际内容摘要校验。' }
  writeTextFileAtomic(cache, JSON.stringify(facts)); return { ...facts, reused: false }
}
export function buildRepositoryContextTool(projectId: string): AgentLoopTool {
  return { name: 'inspect_repository', parallelSafe: true, description: '已有工程按需定位：overview看包脚本/锁文件/测试；changes对比导入基线与当前副本字节，不读取原目录；file提取声明/导入候选；search查相关源码。候选或差异不是测试通过证据。',
    input_schema: { type: 'object', required: ['mode'], additionalProperties: false, properties: { mode: { type: 'string', enum: ['overview', 'file', 'search', 'changes'] }, path: { type: 'string' }, query: { type: 'string', minLength: 1, maxLength: 120 } } },
    execute: async (input, ctx) => {
      try {
        if (ctx.projectId !== projectId) throw Error('REPOSITORY_PROJECT_MISMATCH')
        const root = resolveProjectRoot(projectId, () => findProject(projectId).root_path)
        if (input.mode === 'changes') return { output: redactSoftwareOutput(JSON.stringify(await importedProjectChanges(projectId, root, ctx.signal))) }
        if (input.mode === 'file') {
          if (typeof input.path !== 'string' || !input.path) throw Error('REPOSITORY_FILE_REQUIRED')
          return { output: redactSoftwareOutput(JSON.stringify(repositoryFileFacts(projectId, root, input.path))) }
        }
        let files = repositoryFiles(root)
        if (input.mode === 'search' && typeof input.path === 'string' && input.path) {
          const directory = realpathSync(resolve(root, input.path)), rel = relative(realpathSync(root), directory)
          if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw Error('REPOSITORY_SEARCH_OUTSIDE_PROJECT')
          const prefix = rel.replaceAll(sep, '/')
          if (prefix) files = files.filter(file => file === prefix || file.startsWith(`${prefix}/`))
        }
        if (input.mode === 'overview') {
          let scripts: Record<string, unknown> = {}, dependencies: unknown = {}, engines: unknown
          if (existsSync(join(root, 'package.json'))) {
            const value = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
            scripts = Object.fromEntries(Object.entries(value.scripts ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string').slice(0, 16).map(([name, command]) => [name, command.slice(0, 200)])); engines = value.engines
            dependencies = { runtime: Object.keys(value.dependencies ?? {}).slice(0, 50), development: Object.keys(value.devDependencies ?? {}).slice(0, 50) }
          }
          const overview = { files: files.length, scripts, engines, dependencies,
            manifests: files.filter(file => /(?:^|\/)(?:package.json|package-lock.json|pnpm-lock.yaml|yarn.lock|pyproject.toml|uv.lock|requirements.txt|Cargo.toml|go.mod)$/.test(file)).slice(0, 60),
            tests: files.filter(file => /(^|\/)(tests?|__tests__)\/|[.](test|spec)[.]/.test(file)).slice(0, 30),
            imported: importedProjectContext(projectId), note: '先复用现有脚本和入口；清单仅定位，不执行测试或证明依赖可用。' }
          const output = JSON.stringify(overview)
          return { output: redactSoftwareOutput(output.length <= 14000 ? output : JSON.stringify({ files: files.length, scripts, overview_truncated: true, note: '清单过大，按目录用find/grep或inspect_repository file/search继续定位；未将截断JSON当作完整索引。' })) }
        }
        if (input.mode !== 'search' || typeof input.query !== 'string' || !input.query.trim() || input.query.length > 120) throw Error('REPOSITORY_SEARCH_QUERY_REQUIRED')
        const query = input.query.toLowerCase(), hits: Array<{ path: string; line: number; text: string }> = []; let skipped = 0, scanned = 0
        for (const path of files) {
          ctx.signal.throwIfAborted()
          const file = join(root, path); if (statSync(file).size > 2 * 1024 * 1024) { skipped++; continue }
          scanned++
          for (const [i, line] of readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
            if (line.toLowerCase().includes(query)) hits.push({ path, line: i + 1, text: redactSoftwareOutput(line).slice(0, 240) })
            if (hits.length >= 30) break
          }
          if (hits.length >= 30) break
        }
        return { output: JSON.stringify({ hits, scanned, skipped_large_files: skipped, truncated: scanned + skipped < files.length || hits.length >= 30 }) }
      } catch (error) { return { isError: true, output: String(error) } }
    } }
}
