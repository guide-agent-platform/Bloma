import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { rmSyncWithRetry } from './fs-retry'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { findProject, readLastSketchRequirements } from './project-service'
import { getSandboxLogs, runSandbox } from './platform-services'
import { runGwtScenarios } from './gwt-service'
import { planScenarios, scenarioName } from './gwt-runner'
import { runSecurityScan } from './security-scan'
import type { AgentLoopTool, ToolContext, ToolOutcome } from './agent-loop'
import {
  NET_FETCH_DEFAULT_CHARS,
  NET_FETCH_MAX_BYTES,
  NET_FETCH_MAX_CHARS_LIMIT,
  NET_FETCH_TIMEOUT_MS,
  assertPublicHttpUrl,
  htmlToText,
} from './net-guard'
import {
  answerDelegationQuestion,
  askDelegationQuestion,
  continueDelegation,
  delegateAgentOnce,
  findDelegation,
  getDelegationSummary,
  listDelegations,
  startDelegation,
  stopDelegation,
  stopDelegations,
  waitForDelegations,
  type DelegationRole,
  type DelegationSummary,
} from './agent-collaboration'

/**
 * Agent Loop 工具集（L2，AgentLoop 改造方案 §4.3；委派协作嫁接方案 §4.2）。
 *
 * 主 agent（role='parent'）9 个受控 ACI 工具（8 本地 + web_fetch 联网只读）+ delegate_agent
 * 委派工具；子 agent 按 role 裁剪（explore/research 只读，implement/review/custom 全量 9，无委派工具）。
 * 输出契约一律按 SWE-agent ACI 规范：截断、结构化、空输出显式反馈（「执行成功，无输出」）。
 * 编辑护栏前置：write_file / edit_file 落盘前做语法/结构校验，错误当场回给模型（lint guardrail）。
 *
 * 通用约束：
 * - 路径沙箱：resolve(join(root, path)) 必须仍在 root 内（防 ../ 逃逸）；
 *   可写范围 = 白名单后缀（.html/.js/.css）+ src/ 子树（沿用 MODEL_WRITABLE_TESTS 思路放宽）。
 * - 网络出口仅 web_fetch：只允许 http/https 公网地址（SSRF 防护拒绝内网/保留段/无点
 *   主机名，重定向终态复检），响应限 2MB，输出按 ACI 契约截断。
 * - create_snapshot / rollback_snapshot 不进工具集：快照时机由编排层控制，
 *   模型无权决定检查点（与「snapshot 由管线在关键节点创建」语义一致）。
 * - 修复预算口径（PR3 §4.4，同构旧 test_repair_count ≤3）：GWT 首次失败后，
 *   edit_file/write_file 共享 3 次修复预算，第 4 次起软着陆提示收尾。
 */

/** 测试失败后的写入类工具修复预算（同构旧管道 test_repair_count ≤ 3）。 */
export const EDIT_BUDGET_AFTER_TEST_FAILURE = 3

/** 系统接管文件（与 mvp-engine-llm SYSTEM_FILES 同集）：模型写入会被拒绝。 */
const SYSTEM_FILES = new Set(['package.json', 'static-server.js'])

/** 模型可写白名单后缀（静态前端产物）。 */
const WRITABLE_EXTENSIONS = new Set(['.html', '.js', '.css'])

/** list_files / grep 跳过的非产物目录。 */
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-main'])

const LIST_DEPTH_LIMIT = 4
const LIST_ENTRY_LIMIT = 200
const GREP_HIT_LIMIT = 50
const READ_DEFAULT_WINDOW = 100
const SANDBOX_LOG_TAIL_LIMIT = 2048

// =========================================================================
// 语法护栏（可注入 seam，测试替换为同步桩）
// =========================================================================

type JsSyntaxChecker = (content: string) => Promise<{ ok: true } | { ok: false; error: string }>

let jsSyntaxChecker: JsSyntaxChecker = checkJsSyntaxViaNode

/** 测试 seam：替换 JS 语法检查器（避免单测依赖真实 node 子进程）。 */
export function setJsSyntaxCheckerForTests(checker?: JsSyntaxChecker): void {
  jsSyntaxChecker = checker ?? checkJsSyntaxViaNode
}

/**
 * node --check 落盘前护栏：先按 ES Module 解析（.mjs，现代语法的超集），
 * 失败再按脚本解析（.cjs，兼容顶层 return 等旧式写法）；两者皆败才判语法错误。
 */
async function checkJsSyntaxViaNode(content: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const base = join(tmpdir(), `bloma-syntax-${randomUUID()}`)
  const mjs = `${base}.mjs`
  const cjs = `${base}.cjs`
  try {
    writeFileSync(mjs, content, 'utf8')
    const moduleCheck = await runNodeCheck(mjs)
    if (moduleCheck.ok) return { ok: true }
    writeFileSync(cjs, content, 'utf8')
    const scriptCheck = await runNodeCheck(cjs)
    if (scriptCheck.ok) return { ok: true }
    return { ok: false, error: moduleCheck.stderr.trim() || 'JS 语法检查未通过' }
  } finally {
    rmSyncWithRetry(mjs, { force: true })
    rmSyncWithRetry(cjs, { force: true })
  }
}

function runNodeCheck(file: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolvePromise) => {
    // Electron 下 process.execPath 是 electron.exe（platform-services resolveNodeExecutable 同款解析）
    const executable = process.env.npm_node_execpath || process.env.NODE || 'node'
    const child = spawn(executable, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.once('error', () => resolvePromise({ ok: false, stderr: '无法启动 node 进行语法检查' }))
    child.once('close', (code) => resolvePromise({ ok: code === 0, stderr }))
  })
}

/** HTML 结构护栏：结构标签配平 + 以 </html> 结尾（对齐磁盘证据 isHtmlDocument 口径）。 */
function checkHtmlStructure(content: string): string | null {
  const issues: string[] = []
  for (const tag of ['html', 'head', 'body', 'script']) {
    const open = (content.match(new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi')) ?? []).length
    const close = (content.match(new RegExp(`</${tag}>`, 'gi')) ?? []).length
    if (open !== close) issues.push(`<${tag}> 开标签 ${open} 个、闭标签 ${close} 个，不匹配`)
  }
  if (!/<\/html>\s*$/i.test(content.trim())) issues.push('文档必须以 </html> 结尾')
  return issues.length > 0 ? `HTML 结构校验未通过：${issues.join('；')}` : null
}

/** 剥离模型自发写入的 meta CSP（平台 CSP 是唯一真相源，双重 CSP 会拦死内联脚本）。 */
function stripMetaCsp(content: string): string {
  return content.replace(/<meta[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '')
}

// =========================================================================
// 路径沙箱
// =========================================================================

function resolveInsideProject(
  root: string,
  rawPath: unknown,
): { ok: true; abs: string; rel: string } | { ok: false; error: string } {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return { ok: false, error: '缺少 path 参数（项目内相对路径，如 index.html 或 src/app.js）' }
  }
  const normalized = rawPath.replace(/\\/g, '/').replace(/^\.\//, '')
  if (normalized.includes('..') || isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    return { ok: false, error: `路径必须在项目目录内（收到 "${rawPath}"，不允许绝对路径或 ../ 逃逸）` }
  }
  const abs = resolve(join(root, normalized))
  const rel = relative(resolve(root), abs).replace(/\\/g, '/')
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: `路径必须在项目目录内（收到 "${rawPath}"）` }
  }
  return { ok: true, abs, rel }
}

function isWritablePath(rel: string): boolean {
  if (SYSTEM_FILES.has(rel)) return false
  if (rel.startsWith('src/')) return true
  return WRITABLE_EXTENSIONS.has(extname(rel).toLowerCase())
}

function notWritableError(rel: string): string {
  if (SYSTEM_FILES.has(rel)) return `「${rel}」由平台管理，不允许直接修改。`
  return `「${rel}」不在可写范围内（允许：.html/.js/.css 文件与 src/ 子树）。`
}

/** 递归收集项目内文件（跳过非产物目录），返回相对路径列表。 */
function collectProjectFiles(root: string, subDir = ''): string[] {
  const out: string[] = []
  const base = subDir ? join(root, subDir) : root
  let entries
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const rel = subDir ? `${subDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue
      if (rel.split('/').length >= LIST_DEPTH_LIMIT) continue
      out.push(...collectProjectFiles(root, rel))
    } else if (entry.isFile()) {
      out.push(rel)
    }
  }
  return out.sort()
}

// =========================================================================
// 工具集工厂
// =========================================================================

export interface BuildAgentToolsOptions {
  projectId: string
  /** 编辑格式能力位：diff（默认，强模型精确替换）/ whole（弱渠道整文件重写，Aider 结论） */
  editFormat?: 'diff' | 'whole'
  /** 委派角色裁剪：缺省 'parent'（全量 8 + delegate_agent）；explore/research 只读；子 agent 无委派工具 */
  role?: 'parent' | DelegationRole
  /** 新修复回合开始时回调（PR3 埋点：self_repair_triggered 的 loop 路径映射） */
  onRepairRound?: (round: number) => void
}

export function buildAgentTools(options: BuildAgentToolsOptions): AgentLoopTool[] {
  const editFormat = options.editFormat ?? 'diff'
  const projectId = options.projectId
  const role = options.role ?? 'parent'

  /**
   * 测试失败后的修复预算门（edit-after-test-failure ≤ 3，PR3 §4.4 口径，同构旧
   * test_repair_count）：只拦真实写入尝试（路径/参数已校验过），无效调用不烧预算。
   */
  const guardRepairBudget = (ctx: ToolContext): ToolOutcome | undefined => {
    if (!ctx.state.test_failed) return undefined
    ctx.state.edits_after_test_failure += 1
    if (ctx.state.edits_after_test_failure > EDIT_BUDGET_AFTER_TEST_FAILURE) {
      return {
        output:
          `测试失败后的修改预算已用尽（${EDIT_BUDGET_AFTER_TEST_FAILURE} 次）。` +
          '请不要再改文件，基于当前状态输出完成总结（说明哪些断言仍未通过）。',
        budgetExhausted: true,
      }
    }
    return undefined
  }

  /** 落盘前统一护栏：路径沙箱 + 可写范围 + 语法/结构校验 + 修复预算门 + meta CSP 剥离。 */
  const validateAndWrite = async (root: string, rel: string, content: string, ctx: ToolContext): Promise<ToolOutcome> => {
    if (!isWritablePath(rel)) return { output: notWritableError(rel), isError: true }
    if (extname(rel).toLowerCase() === '.html') {
      const structureError = checkHtmlStructure(content)
      if (structureError) return { output: `${structureError}\n请修正后重新提交完整内容。`, isError: true }
    }
    if (extname(rel).toLowerCase() === '.js') {
      const syntax = await jsSyntaxChecker(content)
      if (!syntax.ok) {
        return { output: `JS 语法校验未通过，已拒绝写入 ${rel}：\n${syntax.error}\n请读完错误定位后修改再提交。`, isError: true }
      }
    }
    // 修复预算门：路径/参数/语法均校验通过后才烧预算（无效调用不烧，对齐注释语义）
    const budget = guardRepairBudget(ctx)
    if (budget) return budget
    const finalContent = extname(rel).toLowerCase() === '.html' ? stripMetaCsp(content) : content
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, finalContent, 'utf8')
    const stripped = finalContent !== content
    return {
      output: `已写入 ${rel}（${Buffer.byteLength(finalContent, 'utf8')} 字节）${stripped ? '；已剥离与平台 CSP 冲突的 meta 标签' : ''}`,
      detail: { path: rel, bytes: Buffer.byteLength(finalContent, 'utf8') },
    }
  }

  const read_file: AgentLoopTool = {
    name: 'read_file',
    description:
      '读取项目内文件的一个窗口（默认 100 行，带行号）。参数：path（项目内相对路径）、offset（起始行，1 起，可选）、limit（行数，可选）。越界时返回最近可用窗口。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目内相对路径，如 index.html、src/app.js' },
        offset: { type: 'number', description: '起始行号（1 起）' },
        limit: { type: 'number', description: '读取行数（默认 100）' },
      },
      required: ['path'],
    },
    execute: async (toolInput) => {
      const project = findProject(projectId)
      const resolved = resolveInsideProject(project.root_path, toolInput.path)
      if (!resolved.ok) return { output: resolved.error, isError: true }
      if (!existsSync(resolved.abs)) {
        return { output: `文件不存在：${resolved.rel}。可用 list_files 查看项目文件清单。`, isError: true }
      }
      const lines = readFileSync(resolved.abs, 'utf8').split('\n')
      const total = lines.length
      const limit = Math.min(Math.max(numberOr(toolInput.limit, READ_DEFAULT_WINDOW), 1), 500)
      let offset = Math.max(Math.trunc(numberOr(toolInput.offset, 1)), 1)
      if (offset > total) offset = Math.max(1, total - limit + 1) // 越界返回最近可用窗口
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      const body = slice.map((line, index) => `${offset + index} │ ${line}`).join('\n')
      return {
        output: `（${resolved.rel} 共 ${total} 行，显示第 ${offset}~${offset + slice.length - 1} 行）\n${body}`,
      }
    },
  }

  const list_files: AgentLoopTool = {
    name: 'list_files',
    description: '列出项目内文件（相对路径，深度 ≤4，最多 200 条）。参数：path（要列出的子目录，可选，缺省整个项目）。',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '子目录相对路径（缺省列出整个项目）' } },
    },
    execute: async (toolInput) => {
      const project = findProject(projectId)
      let subDir = ''
      if (typeof toolInput.path === 'string' && toolInput.path.trim()) {
        const resolved = resolveInsideProject(project.root_path, toolInput.path)
        if (!resolved.ok) return { output: resolved.error, isError: true }
        subDir = resolved.rel
      }
      const files = collectProjectFiles(project.root_path, subDir)
      if (files.length === 0) return { output: `目录为空（${subDir || '项目根目录'}）。` }
      const shown = files.slice(0, LIST_ENTRY_LIMIT)
      const head = subDir ? `${subDir}/ 下` : '项目文件清单'
      const truncation = files.length > shown.length ? `\n（共 ${files.length} 个文件，仅显示前 ${LIST_ENTRY_LIMIT} 个）` : ''
      return { output: `${head}（${files.length} 个文件）：\n${shown.join('\n')}${truncation}`, detail: { count: files.length } }
    },
  }

  const grep: AgentLoopTool = {
    name: 'grep',
    description:
      '在项目文件里搜索正则模式，只返回命中文件与行号（不返回行内容，最多 50 条命中）。参数：pattern（正则）、glob（文件名过滤，如 "*.js"，可选）。',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        glob: { type: 'string', description: '文件名过滤（如 *.js）' },
      },
      required: ['pattern'],
    },
    execute: async (toolInput) => {
      const project = findProject(projectId)
      if (typeof toolInput.pattern !== 'string' || !toolInput.pattern) {
        return { output: '缺少 pattern 参数。', isError: true }
      }
      let regex: RegExp
      try {
        regex = new RegExp(toolInput.pattern, 'i')
      } catch (error) {
        return { output: `正则表达式无效：${toolInput.pattern}（${error instanceof Error ? error.message : String(error)}）`, isError: true }
      }
      const glob = typeof toolInput.glob === 'string' && toolInput.glob.trim() ? toolInput.glob.trim().replace(/^\*/, '') : ''
      const hits: string[] = []
      for (const rel of collectProjectFiles(project.root_path)) {
        if (glob && !rel.endsWith(glob)) continue
        let content: string
        try {
          content = readFileSync(join(project.root_path, rel), 'utf8')
        } catch {
          continue
        }
        const lines = content.split('\n')
        for (let index = 0; index < lines.length; index += 1) {
          if (regex.test(lines[index])) {
            hits.push(`${rel}:${index + 1}`)
            if (hits.length >= GREP_HIT_LIMIT) break
          }
        }
        if (hits.length >= GREP_HIT_LIMIT) break
      }
      if (hits.length === 0) return { output: `未找到匹配（模式：${toolInput.pattern}${glob ? `，文件过滤：${glob}` : ''}）。` }
      return {
        output: `命中 ${hits.length} 处${hits.length >= GREP_HIT_LIMIT ? '（达到上限 50，可能还有更多）' : ''}：\n${hits.join('\n')}`,
        detail: { hits: hits.length },
      }
    },
  }

  const web_fetch: AgentLoopTool = {
    name: 'web_fetch',
    description:
      '抓取公网网页/文档并转为纯文本（只查资料，不能修改任何东西）。参数：url（http/https 公网地址）、max_chars（返回文本上限，默认 12000，最大 50000）。内网/本机地址会被拒绝；HTML 只保留可见文本。',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的公网 http/https 地址' },
        max_chars: { type: 'number', description: '返回文本字符上限（默认 12000）' },
      },
      required: ['url'],
    },
    execute: async (toolInput) => {
      if (typeof toolInput.url !== 'string' || !toolInput.url.trim()) {
        return { output: '缺少 url 参数。', isError: true }
      }
      const guarded = assertPublicHttpUrl(toolInput.url.trim())
      if (!guarded.ok) return { output: guarded.error, isError: true }
      const maxChars = Math.min(
        Math.max(Math.trunc(numberOr(toolInput.max_chars, NET_FETCH_DEFAULT_CHARS)), 500),
        NET_FETCH_MAX_CHARS_LIMIT,
      )
      let response: Response
      try {
        response = await fetch(guarded.url, {
          signal: AbortSignal.timeout(NET_FETCH_TIMEOUT_MS),
          redirect: 'follow',
          headers: { accept: 'text/html,application/json,text/plain,*/*' },
        })
      } catch (error) {
        return {
          output: `抓取失败（${guarded.url.hostname}）：${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        }
      }
      // 重定向终态复检：防公网 302 跳内网（redirect:'follow' 后 response.url 为终态）
      const finalUrl = assertPublicHttpUrl(response.url || guarded.url.toString())
      if (!finalUrl.ok) {
        return { output: `重定向到了不允许的地址（${response.url}），已拒绝。`, isError: true }
      }
      if (!response.ok) {
        return { output: `目标返回 HTTP ${response.status}（${guarded.url.hostname}），未抓取正文。`, isError: true }
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (!/text\/|json|xml|javascript/i.test(contentType)) {
        return { output: `不支持的响应类型（content-type: ${contentType || '未知'}），只支持文本类内容。`, isError: true }
      }
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > NET_FETCH_MAX_BYTES) {
        return { output: `响应过大（${buffer.byteLength} 字节 > 上限 ${NET_FETCH_MAX_BYTES}），已放弃。`, isError: true }
      }
      const raw = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
      const text = /html/i.test(contentType) ? htmlToText(raw) : raw
      if (!text.trim()) return { output: `抓取成功但页面无可提取文本（${response.url}）。` }
      const truncated = text.length > maxChars
      const body = truncated
        ? `${text.slice(0, maxChars)}\n…（已截断，原文 ${text.length} 字符，可用 max_chars 调大上限重试）`
        : text
      return {
        output: `（${response.url} · HTTP ${response.status} · ${contentType.split(';')[0]}）\n${body}`,
        detail: { url: response.url, status: response.status, chars: text.length, truncated },
      }
    },
  }

  const write_file: AgentLoopTool = {
    name: 'write_file',
    description:
      '把完整文件内容写入项目（整文件覆盖）。参数：path（项目内相对路径）、content（全文）。写入前会做语法/结构校验，校验不过会拒绝写入并返回错误定位。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目内相对路径（如 index.html、src/app.js）' },
        content: { type: 'string', description: '文件完整内容' },
      },
      required: ['path', 'content'],
    },
    execute: async (toolInput, ctx) => {
      if (typeof toolInput.content !== 'string') return { output: '缺少 content 参数（文件完整内容）。', isError: true }
      const project = findProject(projectId)
      const resolved = resolveInsideProject(project.root_path, toolInput.path)
      if (!resolved.ok) return { output: resolved.error, isError: true }
      // 修复预算门在 validateAndWrite 内（校验通过后才烧预算）
      return validateAndWrite(project.root_path, resolved.rel, toolInput.content, ctx)
    },
  }

  const edit_file: AgentLoopTool = {
    name: 'edit_file',
    description:
      editFormat === 'diff'
        ? '精确替换修改：提供 path + old_string（当前文件中唯一存在的片段）+ new_string（替换后的片段）。old_string 未命中或不唯一都会报错，请先 read_file 定点。'
        : '整文件重写修改：提供 path + content（修改后的完整文件内容）。写入前会做语法校验。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目内相对路径' },
        old_string: { type: 'string', description: '（diff 模式）要替换的唯一原文片段' },
        new_string: { type: 'string', description: '（diff 模式）替换后的内容' },
        content: { type: 'string', description: '（whole 模式）修改后的完整文件内容' },
      },
      required: editFormat === 'whole' ? ['path'] : ['path', 'old_string', 'new_string'],
    },
    execute: async (toolInput, ctx) => {
      const project = findProject(projectId)
      const resolved = resolveInsideProject(project.root_path, toolInput.path)
      if (!resolved.ok) return { output: resolved.error, isError: true }

      // whole 模式：无 old_string，走整文件重写（弱渠道能力位）
      if (typeof toolInput.old_string !== 'string') {
        if (typeof toolInput.content !== 'string') {
          return { output: '缺少参数：diff 模式需要 old_string + new_string，whole 模式需要 content。', isError: true }
        }
        return validateAndWrite(project.root_path, resolved.rel, toolInput.content, ctx)
      }

      // diff 模式：new_string 必须显式提供（可为空串但不能缺省，缺省静默删除是隐蔽 bug）
      if (typeof toolInput.new_string !== 'string') {
        return { output: '缺少参数：diff 模式需要 old_string + new_string（new_string 可为空串，但不能缺省）。', isError: true }
      }

      // diff 模式：old_string 唯一命中才替换（SWE-agent ACI：未命中/多命中都报错并引导定点）
      if (!existsSync(resolved.abs)) {
        return { output: `文件不存在：${resolved.rel}。先用 write_file 创建，或 list_files 确认路径。`, isError: true }
      }
      const current = readFileSync(resolved.abs, 'utf8')
      const count = current.split(toolInput.old_string).length - 1
      if (count === 0) {
        return { output: `old_string 在 ${resolved.rel} 中未命中。请先 read_file 定点（注意空白与引号须逐字一致）。`, isError: true }
      }
      if (count > 1) {
        return { output: `old_string 在 ${resolved.rel} 中命中 ${count} 处，不唯一。请扩大上下文使片段唯一。`, isError: true }
      }
      const next = current.replace(toolInput.old_string, toolInput.new_string)
      return validateAndWrite(project.root_path, resolved.rel, next, ctx)
    },
  }

  const run_preview: AgentLoopTool = {
    name: 'run_preview',
    description: '启动/重启项目预览并做健康探活。成功返回 preview_url；失败返回错误分类与服务器日志尾部（用于定位修复）。',
    input_schema: { type: 'object', properties: {} },
    execute: async (_toolInput, ctx) => {
      const sandbox = await runSandbox({ request_id: ctx.requestId, project_id: projectId })
      if (sandbox.status === 'running' && sandbox.preview_url) {
        ctx.state.preview_url = sandbox.preview_url
        return { output: `预览已启动：${sandbox.preview_url}`, detail: { preview_url: sandbox.preview_url } }
      }
      const logs = getSandboxLogs(projectId).slice(-SANDBOX_LOG_TAIL_LIMIT)
      return {
        output:
          `预览启动失败（${sandbox.error_summary?.category ?? 'unknown'}）：` +
          `${sandbox.error_summary?.user_visible_summary ?? '未知原因'}。\n服务器日志尾部：\n${logs || '（无输出）'}`,
        isError: true,
        detail: { category: sandbox.error_summary?.category },
      }
    },
  }

  const run_gwt_tests: AgentLoopTool = {
    name: 'run_gwt_tests',
    description: '执行行为断言测试（GWT 场景），返回通过/失败计数与每个失败场景的原因。需要先 run_preview 拿到可用预览。',
    input_schema: { type: 'object', properties: {} },
    execute: async (_toolInput, ctx) => {
      if (!ctx.state.preview_url) {
        return { output: '还没有可用的预览地址。请先调用 run_preview 启动预览，再运行测试。', isError: true }
      }
      const result = await runGwtScenarios({ project_id: projectId, session_id: ctx.sessionId, preview_url: ctx.state.preview_url })
      if (result.failed_count > 0) {
        // 修复预算口径：每次失败运行 = 一个新修复回合（对应旧 test_repair_count +1）
        ctx.state.test_failed = true
        ctx.state.repair_round += 1
        options.onRepairRound?.(ctx.state.repair_round)
        const failures = result.failure_summary.map((failure) => `- ${failure.scenario}：${failure.reason}`).join('\n')
        return {
          output: `共 ${result.total_count} 个场景：通过 ${result.passed_count}、失败 ${result.failed_count}。\n失败场景：\n${failures}`,
          detail: { failed_count: result.failed_count, total_count: result.total_count },
        }
      }
      // 全过显式列出场景名（ACI：空结果显式反馈 + 可核对的通过清单）
      const scenarioNames = planScenarios(readLastSketchRequirements(projectId)).map((scenario) =>
        scenarioName(scenario.item.id, scenario.assertion),
      )
      const nameList = scenarioNames.length > 0 ? `\n通过场景：${scenarioNames.join('、')}` : ''
      return {
        output: `全部通过（${result.passed_count}/${result.total_count} 个场景）。${nameList}\n测试通过，可以继续 run_security_scan 或输出完成总结。`,
        detail: { passed_count: result.passed_count, total_count: result.total_count },
      }
    },
  }

  const run_security_scan: AgentLoopTool = {
    name: 'run_security_scan',
    description: '对项目产物做安全静态扫描。通过时明确说明；发现高危/严重问题时列出 file:line 与修复建议。',
    input_schema: { type: 'object', properties: {} },
    execute: async () => {
      const project = findProject(projectId)
      const result = runSecurityScan({ project_id: projectId, root_path: project.root_path })
      const blocking = result.issues.filter((issue) => issue.severity === 'high' || issue.severity === 'critical')
      if (result.passed) {
        const minor = result.issues.length - blocking.length
        return {
          output: `安全扫描通过：无高危/严重问题（扫描 ${result.scanned_files} 个文件${minor > 0 ? `，另有 ${minor} 个低/中危提示` : ''}）。`,
          detail: { passed: true, scanned_files: result.scanned_files },
        }
      }
      const listing = blocking.map((issue) => `- ${issue.file}:${issue.line} ${issue.user_visible_summary}`).join('\n')
      return {
        output: `安全扫描未通过（${blocking.length} 个高危/严重问题，扫描 ${result.scanned_files} 个文件）：\n${listing}\n请修复后重新扫描。`,
        detail: { passed: false, blocking: blocking.length },
      }
    },
  }

  // 主 agent（parent）专属委派协作工具集：M1 delegate_agent；M2 wait/get/stop；M3 answer/continue
  const delegate_agent: AgentLoopTool = {
    name: 'delegate_agent',
    description:
      '委派一个真实协作子会话并行处理独立子任务（fire-and-forget：立即返回 delegation_id，不阻塞当前轮）。' +
      '子会话是独立 agent，仅限 1 层深度（子代理不能再委派）。适合长耗时、可并行、需要独立追踪的任务。' +
      '用 wait_for_delegations 收集结果、get_delegation_results 读取摘要。',
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '发给子 agent 的完整任务说明，必须自包含必要上下文' },
        role: {
          type: 'string',
          enum: ['explore', 'research', 'implement', 'review', 'custom'],
          description: '子任务角色：explore 探索代码库 / research 调研 / implement 实现 / review 审查 / custom 自定义',
        },
        expectedOutput: { type: 'string', description: '希望子 agent 最终返回的格式或要点（可选）' },
      },
      required: ['task'],
    },
    execute: async (toolInput, ctx) => {
      const created = delegateAgentOnce(ctx.sessionId, ctx.toolCallId, () =>
        startDelegation(ctx, {
          task: String(toolInput.task ?? ''),
          role: normalizeDelegationRole(toolInput.role),
          expectedOutput: typeof toolInput.expectedOutput === 'string' ? toolInput.expectedOutput : undefined,
        }),
      )
      return {
        output:
          `已委派协作子会话（delegation_id=${created.delegation_id}，role=${created.role}，status=${created.status}）。` +
          '用 wait_for_delegations 等待结果、get_delegation_results 读取摘要。',
        detail: { ...created },
      }
    },
  }

  const wait_for_delegations: AgentLoopTool = {
    name: 'wait_for_delegations',
    description:
      '阻塞等待委派子会话收敛（本工具调用会挂起当前轮直到等待完成或超时）。' +
      'strategy=all 等全部完成、any 等任一完成；超时（timeout_ms，缺省 600000ms）返回当前状态不抛错，由父 agent 决定继续等还是停止。' +
      'delegation_ids 缺省 = 等待当前全部委派。',
    input_schema: {
      type: 'object',
      properties: {
        delegation_ids: { type: 'array', items: { type: 'string' }, description: '要等待的委派 ID 列表（缺省=当前全部）' },
        strategy: { type: 'string', enum: ['all', 'any'], description: 'all=全部收敛（默认）/ any=任一完成即返回' },
        timeout_ms: { type: 'number', description: '等待上限（毫秒，缺省 600000）' },
      },
    },
    execute: async (toolInput, ctx) => {
      const summaries = await waitForDelegations(ctx, {
        delegationIds: stringArrayOrUndefined(toolInput.delegation_ids),
        strategy: toolInput.strategy === 'any' ? 'any' : 'all',
        timeout_ms: optionalNumberOr(toolInput.timeout_ms),
      })
      return {
        output: `委派等待返回（${summaries.length} 个）：\n${formatDelegationSummaries(summaries)}`,
        detail: { summaries },
      }
    },
  }

  const get_delegation_results: AgentLoopTool = {
    name: 'get_delegation_results',
    description:
      '非阻塞读取委派子会话的状态摘要（delegation_id / role / status / goal / result_summary），不做等待。' +
      'delegation_ids 缺省 = 当前全部委派；已终结记录保留最近 50 条。',
    input_schema: {
      type: 'object',
      properties: {
        delegation_ids: { type: 'array', items: { type: 'string' }, description: '要读取的委派 ID 列表（缺省=当前全部）' },
      },
    },
    execute: async (toolInput, ctx) => {
      const ids = stringArrayOrUndefined(toolInput.delegation_ids)
      const records =
        ids && ids.length > 0
          ? ids.map((id) => {
              const record = findDelegation(ctx.sessionId, id)
              if (!record) throw new Error(`未找到当前会话下的委派: ${id}`)
              return record
            })
          : listDelegations(ctx.sessionId)
      const summaries = records.map(getDelegationSummary)
      return {
        output: `委派状态摘要（${summaries.length} 个）：\n${formatDelegationSummaries(summaries)}`,
        detail: { summaries },
      }
    },
  }

  const stop_delegation: AgentLoopTool = {
    name: 'stop_delegation',
    description:
      '停止一个委派子会话：中止其子循环、状态置 cancelled、解除正在等待它的 wait_for_delegations 阻塞，返回该委派当前摘要。',
    input_schema: {
      type: 'object',
      properties: { delegation_id: { type: 'string', description: '要停止的委派 ID' } },
      required: ['delegation_id'],
    },
    execute: async (toolInput, ctx) => {
      if (typeof toolInput.delegation_id !== 'string' || !toolInput.delegation_id.trim()) {
        return { output: '缺少 delegation_id 参数。', isError: true }
      }
      const summary = stopDelegation(ctx.sessionId, toolInput.delegation_id.trim())
      return { output: `已停止委派 ${summary.delegation_id}（status=${summary.status}）。`, detail: { ...summary } }
    },
  }

  const stop_delegations: AgentLoopTool = {
    name: 'stop_delegations',
    description: '批量停止委派子会话。delegation_ids 缺省 = 停止当前全部委派；返回被停止的委派摘要列表。',
    input_schema: {
      type: 'object',
      properties: {
        delegation_ids: { type: 'array', items: { type: 'string' }, description: '要停止的委派 ID 列表（缺省=当前全部）' },
      },
    },
    execute: async (toolInput, ctx) => {
      const summaries = stopDelegations(ctx.sessionId, stringArrayOrUndefined(toolInput.delegation_ids))
      return {
        output: `已停止 ${summaries.length} 个委派：\n${formatDelegationSummaries(summaries)}`,
        detail: { summaries },
      }
    },
  }

  // 子 agent（委派子会话）专属：向主 agent 挂起提问（M3 冒泡）。主 agent 用 answer_delegation_question 代答。
  const ask_delegation_question: AgentLoopTool = {
    name: 'ask_delegation_question',
    description:
      '（协作子 agent）向主 agent 提问：遇到需要用户决策、额外信息或授权确认时调用。' +
      '本工具会挂起等待主 agent 回答，回答返回后继续执行；主 agent 也可用 stop_delegation 中止。',
    input_schema: {
      type: 'object',
      properties: { question: { type: 'string', description: '要问主 agent 的问题（一次一个，需决策的具体问题）' } },
      required: ['question'],
    },
    execute: async (toolInput, ctx) => {
      if (typeof toolInput.question !== 'string' || !toolInput.question.trim()) {
        return { output: '缺少 question 参数。', isError: true }
      }
      if (ctx.state.delegation_depth < 1) {
        return { output: 'ask_delegation_question 只在委派子会话（子 agent）里可用。', isError: true }
      }
      const answer = await askDelegationQuestion(ctx, toolInput.question.trim())
      return { output: `主 agent 回答：${answer}` }
    },
  }

  const answer_delegation_question: AgentLoopTool = {
    name: 'answer_delegation_question',
    description:
      '回答委派子 agent 冒泡的问题（子 agent 调 ask_delegation_question 挂起）。' +
      '回答会回传给子 agent 的挂起点，子 agent 继续执行。用 get_delegation_results 查看哪些委派有 pending_question。',
    input_schema: {
      type: 'object',
      properties: {
        delegation_id: { type: 'string', description: '要回答的委派 ID' },
        answer: { type: 'string', description: '给子 agent 的回答（决策/信息/授权）' },
      },
      required: ['delegation_id', 'answer'],
    },
    execute: async (toolInput, ctx) => {
      const delegationId = String(toolInput.delegation_id ?? '')
      const answer = String(toolInput.answer ?? '')
      if (!delegationId.trim()) return { output: '缺少 delegation_id 参数。', isError: true }
      if (!answer.trim()) return { output: '缺少 answer 参数。', isError: true }
      const result = answerDelegationQuestion(ctx.sessionId, delegationId.trim(), answer.trim())
      return { output: `已回答委派 ${result.delegation_id} 的问题。`, detail: { ...result } }
    },
  }

  const continue_delegation: AgentLoopTool = {
    name: 'continue_delegation',
    description:
      '让一个已终结（completed/failed/cancelled）的委派继续：用新任务指令重启同一子会话（同一 child session，JSONL 追加轮）。' +
      '正在运行中的委派不能续跑（先 wait 或 stop）。适合「已拿到初稿 → 追加一轮修改/验证」。',
    input_schema: {
      type: 'object',
      properties: {
        delegation_id: { type: 'string', description: '要续跑的委派 ID（已终结）' },
        task: { type: 'string', description: '追加给子 agent 的新任务指令（自包含，含上一轮结果引用）' },
      },
      required: ['delegation_id', 'task'],
    },
    execute: async (toolInput, ctx) => {
      const delegationId = String(toolInput.delegation_id ?? '')
      const task = String(toolInput.task ?? '')
      if (!delegationId.trim()) return { output: '缺少 delegation_id 参数。', isError: true }
      if (!task.trim()) return { output: '缺少 task 参数。', isError: true }
      const result = continueDelegation(ctx, delegationId.trim(), task.trim())
      return {
        output: `已继续委派 ${result.delegation_id}（role=${result.role}，child_session=${result.child_session_id}，status=${result.status}）。用 wait_for_delegations 收集续跑结果。`,
        detail: { ...result },
      }
    },
  }

  if (role === 'explore' || role === 'research') {
    // 只读角色：探索/调研不需要写文件或跑测试，但可查公网资料、可向主 agent 冒泡提问
    return [read_file, list_files, grep, web_fetch, ask_delegation_question]
  }
  if (role !== 'parent') {
    // 子 agent（implement/review/custom）：全量 9 工具 + ask 冒泡；无委派/代答/续跑工具（深度限制双保险）
    return [
      read_file,
      list_files,
      grep,
      web_fetch,
      write_file,
      edit_file,
      run_preview,
      run_gwt_tests,
      run_security_scan,
      ask_delegation_question,
    ]
  }
  return [
    read_file,
    list_files,
    grep,
    web_fetch,
    write_file,
    edit_file,
    run_preview,
    run_gwt_tests,
    run_security_scan,
    delegate_agent,
    wait_for_delegations,
    get_delegation_results,
    stop_delegation,
    stop_delegations,
    answer_delegation_question,
    continue_delegation,
  ]
}

function normalizeDelegationRole(value: unknown): DelegationRole {
  if (value === 'explore' || value === 'research' || value === 'implement' || value === 'review' || value === 'custom') {
    return value
  }
  return 'custom'
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 可选毫秒数：非有效数字返回 undefined（让 waitForDelegations 用内置缺省超时）。 */
function optionalNumberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringArrayOrUndefined(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined
}

/** 委派摘要的可读列表（模型视角）：id / role / status，completed 附结果摘要前 200 字，失败附错误。 */
function formatDelegationSummaries(summaries: DelegationSummary[]): string {
  if (summaries.length === 0) return '（无委派记录）'
  return summaries
    .map((summary) => {
      const result = summary.status === 'completed' && summary.result_summary ? `｜${summary.result_summary.slice(0, 200)}` : ''
      const error = summary.error ? `｜${summary.error}` : ''
      return `- ${summary.delegation_id} role=${summary.role} status=${summary.status}${result}${error}`
    })
    .join('\n')
}
