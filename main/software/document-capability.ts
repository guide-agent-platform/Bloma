import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mainRootDir } from '../platform/paths'
import { executeSoftwareCommand } from './command-runtime'

export const DOCUMENT_COMPONENT = 'document_runtime.cjs'
export const DOCUMENT_PACKAGES = { 'pdfjs-dist': '6.4.299', mammoth: '1.13.0' } as const
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function component(root: string) {
  const bytes = readFileSync(join(mainRootDir(), 'templates/tools', DOCUMENT_COMPONENT)), target = join(root, DOCUMENT_COMPONENT)
  const state = !existsSync(target) ? 'missing' : lstatSync(target).isFile() && !lstatSync(target).isSymbolicLink() && lstatSync(target).size === bytes.length && sha(readFileSync(target)) === sha(bytes) ? 'platform_component' : 'conflict'
  return { bytes, target, state, sha256: sha(bytes) }
}
type Execute = typeof executeSoftwareCommand
async function probe(projectId: string, root: string, signal: AbortSignal, execute: Execute) {
  return execute({ projectId, root, signal, timeoutMs: 30000, command: ['node', '-e', `require('./${DOCUMENT_COMPONENT}').inspectDependencies().then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exitCode=1})`] })
}
export async function inspectDocumentCapability(projectId: string, root: string, signal: AbortSignal, execute: Execute = executeSoftwareCommand) {
  const state = component(root)
  const dependencies = state.state === 'platform_component' ? await probe(projectId, root, signal, execute) : undefined
  return { capability: 'documents', provider: 'node-document-text-v1', component: { name: DOCUMENT_COMPONENT, state: state.state, sha256: state.sha256 },
    dependencies: dependencies?.code === 0 ? JSON.parse(dependencies.stdout.trim().split(/\r?\n/).at(-1)!) : undefined,
    ready: state.state === 'platform_component' && dependencies?.code === 0, error: dependencies && dependencies.code !== 0 ? dependencies.stderr.slice(-1600) : undefined,
    product_verification: 'unverified', formats: ['pdf_text', 'docx_text', 'utf8_txt', 'utf8_md'], retrieval: 'literal', ocr: 'unsupported' }
}
const preparing = new Set<string>()
export async function prepareDocumentCapability(projectId: string, root: string, signal: AbortSignal, install = false, execute: Execute = executeSoftwareCommand) {
  if (preparing.has(projectId)) throw Error('DOCUMENT_PREPARATION_BUSY')
  preparing.add(projectId)
  try {
    signal.throwIfAborted()
    const state = component(root)
    if (state.state === 'conflict') throw Error('DOCUMENT_COMPONENT_CONFLICT: 保留已有文件，先核对差异')
    if (state.state === 'missing') writeFileSync(state.target, state.bytes, { flag: 'wx' })
    let result = await inspectDocumentCapability(projectId, root, signal, execute)
    if (!result.ready && install) {
      const manifest = join(root, 'package.json')
      if (!existsSync(manifest)) throw Error('DOCUMENT_PACKAGE_MANIFEST_REQUIRED: 先建立产品自己的Node工程')
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      if (['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'].some(name => existsSync(join(root, name))) || pkg.packageManager && !pkg.packageManager.startsWith('npm@')) throw Error('DOCUMENT_USE_PROJECT_PACKAGE_MANAGER: 按原锁文件安装依赖后重新准备')
      const declared = { ...pkg.devDependencies, ...pkg.dependencies, ...pkg.optionalDependencies }
      const missing = Object.entries(DOCUMENT_PACKAGES).filter(([name]) => !declared[name]).map(([name, version]) => `${name}@${version}`)
      const command = missing.length ? ['npm', 'install', '--save-exact', ...missing] : ['npm', existsSync(join(root, 'package-lock.json')) ? 'ci' : 'install']
      const installed = await execute({ projectId, root, command, signal, timeoutMs: 300000 })
      if (installed.code !== 0) throw Error(`DOCUMENT_DEPENDENCIES_FAILED: ${installed.stderr.slice(-1600)}`)
      result = await inspectDocumentCapability(projectId, root, signal, execute)
    }
    return { ...result, status: result.ready ? 'prepared' : 'environment_blocked', next: '产品后端require("./document_runtime.cjs")，先extractDocument(file,{dataDir:APP_DATA_DIR})，再searchDocuments/verifyCitation；准备不等于GUI业务或真实AI质量通过。依赖失败时按实际Node版本/包管理器诊断，勿改写成熟解析器。' }
  } finally { preparing.delete(projectId) }
}

export const DOCUMENT_GUIDANCE = {
  prepare: 'inspect_software_capabilities({capability:"documents"})；prepare_software_capability({capability:"documents",install_dependencies:true})物化组件并按npm工程安装缺少的固定依赖。其它包管理器保留原锁文件，按正常命令安装后重试；默认不联网安装。',
  usage: 'Node后端：const {extractDocument,searchDocuments,verifyCitation}=require("./document_runtime.cjs"); const doc=await extractDocument(file,{dataDir:process.env.APP_DATA_DIR}); const result=searchDocuments([doc],"关键词"); verifyCitation([doc],result.hits[0]);',
  identity: 'documentId绑定原文件SHA-256，blockId绑定原文件/位置/文本；笔记和AI消息另保留自己的资料/消息/步骤身份，禁止全局最后回答兜底。引用必须核对documentId、blockId、start、end、quote，并从真实原文显示。',
  limits: '16MiB文件、500页PDF、2Mi字符提取文本；UTF-8 TXT/MD、PDF文本、DOCX纯文本。不含OCR、版式/表格还原、向量搜索或回答正确性。PDF保留实际页码，DOCX不虚构页码。检索为区分大小写的块内字面匹配，跨块短语不保证命中。解析放工作进程并使用现有超时/取消和进程监管；限额不是OS沙箱或恶意文档安全认证。',
  acceptance: '分别检查多文件、中文、损坏输入、重开、跨资料关系及错误quote；documents是准备工具的选择器，不是新增需求capabilities标签或CORE_CHECK验证器。产品路径仍按GUI/CLI验收；组件准备、真实解析、本机GUI、真实AI效果和独立机器交付各自取证。',
}
