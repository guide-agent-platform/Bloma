import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { writeFileSync } from 'node:fs'
import type { GuiAcceptanceSuite } from './gui-acceptance'

export const MAX_GUI_FIXTURE_BYTES = 20 * 1024 * 1024
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
export function guiDataPath(data: string, path: string): string {
  if (!/^(?:input|outputs)\/[A-Za-z0-9_./-]+$/.test(path) || path.split('/').some(part => !part || ['.', '..'].includes(part) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part))) throw Error('GUI_DATA_PATH_INVALID')
  mkdirSync(data, { recursive: true }); const root = realpathSync(data), target = resolve(root, path)
  let parent = target; while (!existsSync(parent) && parent !== dirname(parent)) parent = dirname(parent)
  const canonical = resolve(realpathSync(parent), relative(parent, target)), rel = relative(root, canonical)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw Error('GUI_DATA_PATH_OUTSIDE_ISOLATED_DIRECTORY')
  return canonical
}
function blobPath(projectId: string, scope: string, digest: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId) || ![scope, digest].every(value => /^[a-f0-9]{64}$/.test(value))) throw Error('GUI_FIXTURE_ID_INVALID')
  return join(getPromaHome(), 'gui-acceptance-fixtures', projectId, scope, `${digest}.bin`)
}
/** Freeze bytes before the implementation can change its source fixture. File
 * contents never enter prompts or JSONL, only source/path/hash metadata. */
export function sealGuiFixtures(projectId: string, root: string, suite: GuiAcceptanceSuite): GuiAcceptanceSuite {
  let total = 0
  const fixtures = suite.fixtures?.map(file => {
    if (file.text !== undefined) return file
    if (!file.source || isAbsolute(file.source) || /^[A-Za-z]:/.test(file.source) || file.source.split(/[\\/]/).includes('..')) throw Error('GUI_FIXTURE_SOURCE_INVALID')
    const canonicalRoot = realpathSync(root), source = realpathSync(resolve(canonicalRoot, file.source)), rel = relative(canonicalRoot, source)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !statSync(source).isFile()) throw Error('GUI_FIXTURE_SOURCE_OUTSIDE_PROJECT')
    const size = statSync(source).size
    if (size > MAX_GUI_FIXTURE_BYTES || (total += size) > 64 * 1024 * 1024) throw Error('GUI_FIXTURE_SIZE_LIMIT')
    const bytes = readFileSync(source), sha256 = hash(bytes), target = blobPath(projectId, suite.scope_hash, sha256)
    if (!existsSync(target)) { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes, { flag: 'wx' }) }
    else if (hash(readFileSync(target)) !== sha256) throw Error('GUI_FIXTURE_FROZEN_BYTES_CHANGED')
    return { path: file.path, source: file.source, sha256, size: bytes.length }
  })
  return { ...suite, ...(fixtures ? { fixtures } : {}) }
}
export function materializeGuiFixtures(projectId: string, suite: GuiAcceptanceSuite, data: string) {
  for (const file of suite.fixtures ?? []) {
    const target = guiDataPath(data, file.path); mkdirSync(dirname(target), { recursive: true })
    if (file.text !== undefined) writeTextFileAtomic(target, file.text)
    else {
      if (!file.sha256) throw Error('GUI_FIXTURE_NOT_SEALED')
      const bytes = readFileSync(blobPath(projectId, suite.scope_hash, file.sha256))
      if (bytes.length > MAX_GUI_FIXTURE_BYTES || bytes.length !== file.size || hash(bytes) !== file.sha256) throw Error('GUI_FIXTURE_FROZEN_BYTES_CHANGED')
      writeFileSync(target, bytes)
    }
  }
}
export const GUI_FIXTURE_SCHEMA = { type: 'array', maxItems: 16, description: '每项只传path和text/source二选一；sha256/size由宿主生成。source单文件最多20MiB，总共64MiB。持续调试后续调用可复用已登记path。', items: { type: 'object', required: ['path'], additionalProperties: false, properties: {
  path: { type: 'string', pattern: '^input/[A-Za-z0-9_./-]+$', description: '隔离数据目录中的固定文件名，如input/sample.pdf。' },
  text: { type: 'string', maxLength: 4096, description: '小型文本fixture，与source二选一。' },
  source: { type: 'string', description: '项目内真实文件相对路径，宿主冻结内容；不发送二进制或base64给模型。' },
} } }
