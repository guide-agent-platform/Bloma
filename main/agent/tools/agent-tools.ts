import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { rmSyncWithRetry } from '../../platform/storage/fs-retry'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { findProject, readLastSketchRequirements } from '../../project/project-service'
import { decideWrite, estimateTokenCount } from '../loop/usage-guard'
import { withAbort, toolEvidenceEnabled, writeGuardEnabled, preflightEnabled, compactToolEnabled, MAX_EXPLICIT_COMPACTIONS, type AgentLoopTool, type ToolContext, type ToolOutcome } from '../loop/agent-loop'
import { commitFileWrite, fileRevisionOf, fileRevisionsOf } from './write-lease'
import { replaceUniqueText } from './text-edit'
import { resolveProjectRoot } from '../../../shared/project-root-override'
import { buildDelegationTools } from '../delegation/delegation-tools'
import { buildWebFetch, buildWebResearch } from './web-tools'
// 向后兼容 re-export（setWebResearchTimeoutForTests 随 web_research 迁至 web-tools；存量 import 零改动）
export { WEB_RESEARCH_TIMEOUT_MS, setWebResearchTimeoutForTests } from './web-tools'
import type { DelegationRole } from '../delegation/agent-collaboration'

/**
 * Agent Loop 工具集（L2，AgentLoop 改造方案 §4.3；委派协作嫁接方案 §4.2）。
 *
 * 主 agent（role='parent'）9 个受控 ACI 工具（8 本地 + web_fetch 联网只读）+ 委派工具族
 * （delegate_agent / web_research 委派化调研 / wait·get·stop / ask·answer·continue）；
 * 子 agent 按 role 裁剪（explore/research 只读，implement/review/custom 全量 9，无委派工具）。
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

/** web_research 回灌主 loop 的结论上限（字符）。 */
export const WEB_RESEARCH_MAX_CHARS = 4000
/** web_research 调研子代理的收敛上限（毫秒）。 */

/** 系统接管文件（与 mvp-engine-llm SYSTEM_FILES 同集）：模型写入会被拒绝。
 *  比较统一小写化（M-7）：Windows 大小写不敏感文件系统上 'Static-Server.js' 会实际
 *  覆盖 static-server.js（篡改沙箱服务端含 CSP 响应头），精确匹配会被绕过。
 *  W3：增 .bloma-real-variant 标记（平台管理，防 agent 篡改形态判定）。真实脚手架项目
 *  里 package.json/server.js 是产物文件可写——变体感知由 isSystemFile(rel, realVariant) 分流。 */
const SYSTEM_FILES = new Set(['package.json', 'static-server.js', '.bloma-real-variant'])

/** 8.3 短名族（T-2 实测实锤：Windows 短名别名可写覆盖系统文件——写入
 *  'STATIC~1.JS' 实际命中 static-server.js；'PACKAG~1.JSO' 命中 package.json。
 *  生成规则与 Windows 一致：基名前 6 字符 + ~序号 + 扩展名前 3 字符）。 */
const SYSTEM_FILE_SHORT_NAMES = new Set(
  [...SYSTEM_FILES].map((name) => {
    const dot = name.lastIndexOf('.')
    const base = name.slice(0, dot).slice(0, 6)
    const ext = name.slice(dot + 1, dot + 4)
    return `${base}~1.${ext}`.toLowerCase()
  }),
)

function isSystemFile(rel: string, realVariant = false): boolean {
  const lower = rel.toLowerCase()
  // W3：真实脚手架项目里只有变体标记是平台管理件（package.json/server.js 皆是产物）；
  // 旧路径维持全集字节级不变
  if (realVariant) return lower === '.bloma-real-variant'
  if (SYSTEM_FILES.has(lower)) return true
  // T-2：短名别名族（STATIC~N.JS / PACKAG~N.JSO）——~N 序号归一到 ~1 后比对
  const base = lower.split(/[\\/]/).pop() ?? lower
  if (/^[a-z0-9]{1,6}~\d+\.[a-z0-9]{1,3}$/.test(base)) {
    if (SYSTEM_FILE_SHORT_NAMES.has(base.replace(/~\d+\./, '~1.'))) return true
  }
  return false
}

/** 模型可写白名单后缀（静态前端产物）。 */
const WRITABLE_EXTENSIONS = new Set(['.html', '.js', '.css'])

/** 只读参考目录（PR-1 骨架先行 examples + 官方模块库 official-modules）：只读——防止模型
 *  改写参考实现误导后续轮次。软保护而非安全边界（SYSTEM_FILES 才是）：目录短名变体
 *  （EXAMPLES~1/ 等）不在防御面，入侵后果仅为参考实现被改写，不影响系统接管文件与 CSP。 */
const READONLY_DIR_PREFIXES = ['src/examples/', 'src/official-modules/']

function isReadOnlyPath(rel: string): boolean {
  const lower = rel.toLowerCase()
  return READONLY_DIR_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

/** list_files / grep 跳过的非产物目录。 */
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-main'])

const LIST_DEPTH_LIMIT = 4
const LIST_ENTRY_LIMIT = 200
const GREP_HIT_LIMIT = 50
const READ_DEFAULT_WINDOW = 100
export const SANDBOX_LOG_TAIL_LIMIT = 2048

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

function isWritablePath(rel: string, realVariant = false): boolean {
  if (isSystemFile(rel, realVariant)) return false
  if (isReadOnlyPath(rel)) return false
  if (realVariant) {
    // W3：真实工程件皆产物——项目内任意文件可写；仅排除基础设施目录（vendor 供货/
    // 版本史/回滚备份，非 agent 职责）
    const lower = rel.toLowerCase()
    if (lower.startsWith('node_modules/') || lower.startsWith('.git/') || lower.startsWith('data-backups/')) return false
    return true
  }
  if (rel.startsWith('src/')) return true
  return WRITABLE_EXTENSIONS.has(extname(rel).toLowerCase())
}

function notWritableError(rel: string, realVariant = false): string {
  if (isSystemFile(rel, realVariant)) return `「${rel}」由平台管理，不允许直接修改。`
  if (rel.toLowerCase().startsWith('src/official-modules/')) return `「${rel}」是官方模块（只读参考），不允许修改；可 read_file 查看后复制到业务文件按需改编。`
  if (isReadOnlyPath(rel)) return `「${rel}」是只读参考示例（骨架包 src/examples/），不允许修改；可 read_file 参考共模式后在业务文件中实现。`
  if (realVariant) return `「${rel}」不在可写范围内（node_modules/.git/data-backups 是平台基础设施，不允许修改）。`
  return `「${rel}」不在可写范围内（允许：.html/.js/.css 文件与 src/ 子树）。`
}

/** 注入点⑥工具层拦截（周计划 §6）：外部 CDN script/link 引用检测（模板依赖白名单禁外部
 * 资源）；注入点关闭时返回 null 不拦截（行为=现状）。仅拦可执行/样式外链，img/字体
 * 等资源外链不拦（模板允许图片占位）。 */
export function externalResourceViolation(htmlContent: string): string | null {
  const scriptMatch = /<script[^>]+src\s*=\s*["']https?:\/\/[^"']+["']/i.exec(htmlContent)
  if (scriptMatch) return `检测到外部脚本引用（${scriptMatch[0].slice(0, 80)}…）`
  const linkMatch = /<link[^>]+href\s*=\s*["']https?:\/\/[^"']+["']/i.exec(htmlContent)
  if (linkMatch) return `检测到外部样式引用（${linkMatch[0].slice(0, 80)}…）`
  return null
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

/** W3（Phase 10）：find 工具的 glob→正则（支持 * 单段与 ** 跨目录；Windows 大小写不敏感）。 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

/** find 返回上限（与 LIST_ENTRY_LIMIT 同档）。 */
const FIND_ENTRY_LIMIT = 100

// =========================================================================
// D 系列辅助（咨询 D，2026-09-09）：文件版本戳 / 验证状态行 / 版本登记
// =========================================================================

/** D4a/P1-06：文件版本戳与版本记录已下沉 write-lease（提交点 CAS 与写租约同模块）；
 *  fileRevisionOf 由下方 import 绑定后 re-export，保持既有 import 路径零改动。 */
export { fileRevisionOf }

/**
 * D2：验证状态行（宿主维护，不靠 LLM 自报）——「已验证什么 / 尚缺什么」。
 * 仅 BLOMA_TOOL_EVIDENCE=on 时被消费；返回空串表示未启用（字节级现状）。
 */
export function validationStateLine(state: { gwt_all_passed: boolean; security_all_passed: boolean; api_all_passed: boolean; preflight_passed?: boolean }): string {
  if (!toolEvidenceEnabled()) return ''
  const done: string[] = []
  const missing: string[] = []
  ;(state.gwt_all_passed ? done : missing).push('行为断言 GWT')
  ;(state.api_all_passed ? done : missing).push('API 契约')
  ;(state.security_all_passed ? done : missing).push('安全扫描')
  // W3-D2：预检开启时收口面增加 run_preflight（未跑/未过都在「尚缺」）
  if (preflightEnabled()) (state.preflight_passed ? done : missing).push('收口预检 run_preflight')
  if (missing.length === 0) return '\n验证状态：行为断言/ API 契约/安全扫描均已通过——全部验证面通过，可输出完成总结。'
  return `\n验证状态：已通过=${done.length ? done.join('、') : '（无）'}；尚缺=${missing.join('、')}${!state.api_all_passed ? '（数据留存/接口类项目收口前必须 run_api_contract_tests 通过）' : ''}${preflightEnabled() && !state.preflight_passed ? '（收口前必须 run_preflight 全部通过）' : ''}。`
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
  /** W4-F2（咨询 D4）：修复轮修改授权边界——传入即启用：write_file/edit_file 越界返回
   *  WRITE_SCOPE_DENIED + next_actions（不诱导绕权限），并注册 repair_control 窄入口。 */
  writeScope?: WriteScopeHolder
  /** PR4c：真实脚手架变体（原由本模块读标记文件判定，现调用方注入；缺省 false=旧路径行为） */
  realFullstackVariant?: boolean
  /** PR4c：产物落盘后的地图刷新回调（原直连 project-map，现调用方注入；缺省不刷新） */
  onProjectFilesChanged?: (projectRoot: string) => void
}

/** W4-F2：授权边界持有者（宿主创建与裁决，工具层只读/申请，模型不能直改）。 */
export interface WriteScopeHolder {
  /** 当前允许修改的相对路径（与工具 path 入参同口径，正斜杠） */
  authorized: Set<string>
  /** 显式受保护路径（拒绝任何扩大申请；如 prd.json/宿主文件） */
  protectedPaths: Set<string>
  /** 扩大申请记录（含裁决结果；审计与 bench 可见） */
  expansions: Array<{ issue_id?: string; paths: string[]; reason: string; at: string; decision: 'approved' | 'denied'; note?: string }>
  /** 受阻报告（F5 升级链路的结构化输入） */
  blockers: Array<{ reason: string; evidence?: string; at: string }>
}

export function createWriteScope(authorizedPaths: string[], protectedPaths: string[] = []): WriteScopeHolder {
  return {
    authorized: new Set(authorizedPaths.map((p) => p.replace(/\\/g, '/'))),
    protectedPaths: new Set(protectedPaths.map((p) => p.replace(/\\/g, '/'))),
    expansions: [],
    blockers: [],
  }
}

export function buildAgentTools(options: BuildAgentToolsOptions): AgentLoopTool[] {
  const editFormat = options.editFormat ?? 'diff'
  const projectId = options.projectId
  // P1-06 收尾：项目根经 kernel 覆盖解析——worktree 隔离模式下子会话的读写落独立工作树（
  // 覆盖缺省=主目录，行为零变化）
  const projectRoot = (): string => resolveProjectRoot(projectId, () => findProject(projectId).root_path)
  const role = options.role ?? 'parent'
  // W3：真实脚手架变体——PR4c 改由调用方注入（去域依赖；缺省 false=旧路径字节级）
  const realVariant = options.realFullstackVariant ?? false

  /**
   * 测试失败后的修复预算门（edit-after-test-failure ≤ 3，PR3 §4.4 口径，同构旧
   * test_repair_count）：只拦真实写入尝试（路径/参数已校验过），无效调用不烧预算。
   */
  /**
   * W4-F2：修改授权边界门——仅修复轮传入 writeScope 时生效（缺省无 holder=现状）。
   * 越界返回 blocked + next_actions（恢复路径引导，不诱导改用其他文件绕权限）。
   */
  const guardWriteScope = (rel: string): ToolOutcome | undefined => {
    const scope = options.writeScope
    if (!scope || scope.authorized.has(rel)) return undefined
    const listing = [...scope.authorized].slice(0, 8).join('、') || '（空）'
    return {
      output:
        `WRITE_SCOPE_DENIED：${rel} 不在本轮修改授权内（当前授权：${listing}）。` +
        '若根因确在授权外文件，调用 repair_control（action=request_scope_expansion，带 issue_id/requested_paths/reason/change_intent）申请扩大授权；' +
        '批准前不要在卡内文件上做替代实现硬绕根因。',
      isError: true,
      detail: {
        code: 'WRITE_SCOPE_DENIED',
        path: rel,
        next_actions: [{ action: 'request_scope_expansion', required: ['issue_id', 'requested_paths', 'reason', 'change_intent'] }],
      },
    }
  }

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

  /** 落盘前统一护栏：路径沙箱 + 可写范围 + 语法/结构校验 + 修复预算门 + meta CSP 剥离 + 依赖白名单拦截。 */
  const validateAndWrite = async (root: string, rel: string, content: string, ctx: ToolContext, expectedRevision?: string): Promise<ToolOutcome> => {
    if (!isWritablePath(rel, realVariant)) return { output: notWritableError(rel, realVariant), isError: true }
    if (extname(rel).toLowerCase() === '.html') {
      const structureError = checkHtmlStructure(content)
      if (structureError) return { output: `${structureError}\n请修正后重新提交完整内容。`, isError: true }
      // 注入点⑥工具层拦截（周计划 §6：loop 引白名单外包→工具层拦截）：外部 CDN
      // script/link 引用拒绝写入（模板依赖白名单禁外部资源；开关关闭时不拦，行为=现状）
      const cdnViolation = externalResourceViolation(content)
      if (cdnViolation) return { output: `${cdnViolation}\n模板依赖白名单禁止外部资源（内联实现或本地文件）；请去除外链后重新提交。`, isError: true }
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
    // P1-06（2026-09-26 运行审计）：提交点写入原语——CAS 版本校验（收窄 TOCTOU：
    // 语法校验 await 之后、写盘之前；基准取显式传入或会话读写的版本，宿主强制）
    // + 写租约临界区互斥（并行写者冲突拒绝并教育；单会话零影响；TTL 兜底）。
    const committed = commitFileWrite({
      projectId: ctx.projectId,
      root,
      rel,
      finalContent,
      ctx,
      ...(expectedRevision ? { expectedRevision } : {}),
    })
    if (!committed.ok) {
      return { output: committed.output, isError: true, detail: { code: committed.code, path: rel } }
    }
    // project-map（Graft 模式，r69）：PR4c 改回调注入（去域依赖；缺省不刷新）
    try {
      options.onProjectFilesChanged?.(root)
    } catch {
      /* 地图刷新失败静默，不影响写盘结果 */
    }
    const stripped = finalContent !== content
    return {
      output: `已写入 ${rel}（${Buffer.byteLength(finalContent, 'utf8')} 字节）${stripped ? '；已剥离与平台 CSP 冲突的 meta 标签' : ''}`,
      detail: { path: rel, bytes: Buffer.byteLength(finalContent, 'utf8') },
    }
  }

  const read_file: AgentLoopTool = {
    name: 'read_file',
    // P1-2（2026-09-08）：只读无共享态，声明 parallelSafe 可同轮并发（上限 4，见 agent-loop executeTurnToolCalls）
    parallelSafe: true,
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
    execute: async (toolInput, ctx) => {
      const project = findProject(projectId)
      const resolved = resolveInsideProject(projectRoot(), toolInput.path)
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
      // D4a（咨询 D）：记录/返回文件版本戳（mtime+size 十六进制）——edit_file 的
      // expected_revision 校验与 write_file 守卫共用；纯追加信息，无行为变化。
      const revision = fileRevisionOf(resolved.abs)
      fileRevisionsOf(ctx).set(resolved.rel, revision)
      return {
        output: `（${resolved.rel} 共 ${total} 行，显示第 ${offset}~${offset + slice.length - 1} 行｜文件版本 ${revision}）\n${body}`,
      }
    },
  }

  const list_files: AgentLoopTool = {
    name: 'list_files',
    parallelSafe: true,
    description: '列出项目内文件（相对路径，深度 ≤4，最多 200 条）。参数：path（要列出的子目录，可选，缺省整个项目）。',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '子目录相对路径（缺省列出整个项目）' } },
    },
    execute: async (toolInput) => {
      const project = findProject(projectId)
      let subDir = ''
      if (typeof toolInput.path === 'string' && toolInput.path.trim()) {
        const resolved = resolveInsideProject(projectRoot(), toolInput.path)
        if (!resolved.ok) return { output: resolved.error, isError: true }
        subDir = resolved.rel
      }
      const files = collectProjectFiles(projectRoot(), subDir)
      // R0.2（2026-09-19 狗粮 7601e5ae）：平台托管目录不再伪装成「空目录」——模型据
      // 「目录为空」误判 express 未 vendor、白白零依赖重写；如实说明托管与供货保证。
      const topDir = subDir.split('/')[0]
      if (topDir && SKIPPED_DIRS.has(topDir)) {
        const managed = topDir === 'node_modules'
          ? 'node_modules 由平台托管（vendor 供货已保证 express 等依赖可用），不在产物清单中，也不允许直接修改'
          : `${topDir}/ 是平台基础设施目录，不在产物清单中`
        return { output: `${managed}。不要据此判断依赖缺失：判断依赖声明请读 package.json（如存在）。` }
      }
      if (files.length === 0) return { output: `目录为空（${subDir || '项目根目录'}）。` }
      const shown = files.slice(0, LIST_ENTRY_LIMIT)
      const head = subDir ? `${subDir}/ 下` : '项目文件清单'
      const truncation = files.length > shown.length ? `\n（共 ${files.length} 个文件，仅显示前 ${LIST_ENTRY_LIMIT} 个）` : ''
      return { output: `${head}（${files.length} 个文件）：\n${shown.join('\n')}${truncation}`, detail: { count: files.length } }
    },
  }

  const grep: AgentLoopTool = {
    name: 'grep',
    parallelSafe: true,
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
        return { output: '缺少 pattern 参数（要搜索的正则或字面文本，如 "localStorage" 或 "api/records"）。', isError: true }
      }
      let regex: RegExp
      try {
        regex = new RegExp(toolInput.pattern, 'i')
      } catch (error) {
        return { output: `正则表达式无效：${toolInput.pattern}（${error instanceof Error ? error.message : String(error)}）`, isError: true }
      }
      const glob = typeof toolInput.glob === 'string' && toolInput.glob.trim() ? toolInput.glob.trim().replace(/^\*/, '') : ''
      const hits: string[] = []
      for (const rel of collectProjectFiles(projectRoot())) {
        if (glob && !rel.endsWith(glob)) continue
        let content: string
        try {
          content = readFileSync(join(projectRoot(), rel), 'utf8')
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
      // 费用守卫 Hook 3（usage-guard，2026-08-28）：超大单次写入预拦截——整文件覆盖语义下
      // 一次写 16k+ token 内容通常意味着失控（上下文爆掉才失败的预防线），当场引导分块。
      const estTokens = estimateTokenCount(toolInput.content)
      if (decideWrite(toolInput.content) === 'chunk') {
        return {
          output: `单次写入内容过大（约 ${estTokens} tokens，阈值 16000）。请拆分为多次写入：先写骨架文件，再用 edit_file 逐段补充内容。`,
          isError: true,
          detail: { est_tokens: estTokens, threshold: 16000 },
        }
      }
      const project = findProject(projectId)
      const resolved = resolveInsideProject(projectRoot(), toolInput.path)
      if (!resolved.ok) return { output: resolved.error, isError: true }
      // W4-F2：授权边界门（仅修复轮传入 writeScope 时生效；主 loop 无 holder 零变化）
      const writeScopeBlocked = guardWriteScope(resolved.rel)
      if (writeScopeBlocked) return writeScopeBlocked
      // D4a：write 守卫——覆盖「本轮未读过的既有文件」拦截（R-FILE-01 工具化；
      // 2026-10-02 全链路审查 P1-4 无条件化：缺省 on，BLOMA_WRITE_GUARD=0/false 逃生口）。
      // 新建文件不受影响；**本来就禁止写的路径跳过守卫**直接走边界拒绝——对只读/
      // 系统路径提示「先读再写」是错误指引（边界优先，2026-10-02）。
      if (isWritablePath(resolved.rel, realVariant) && existsSync(resolved.abs) && !fileRevisionsOf(ctx).has(resolved.rel)) {
        if (writeGuardEnabled()) {
          return {
            output: `目标文件已存在且本轮未读取过：${resolved.rel}。先 read_file 获取当前内容（R-FILE-01），再决定 edit_file 精确修改或基于读取结果重写；禁止盲覆盖。`,
            isError: true,
            detail: { code: 'WRITE_UNREAD_TARGET', path: resolved.rel },
          }
        }
      }
      // 修复预算门在 validateAndWrite 内（校验通过后才烧预算）
      return validateAndWrite(projectRoot(), resolved.rel, toolInput.content, ctx)
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
        expected_revision: { type: 'string', description: '（可选，D4a）read_file 返回的文件版本；提供时若文件已被修改过会返回 STALE_READ 拒绝执行，需重新 read_file' },
      },
      required: editFormat === 'whole' ? ['path'] : ['path', 'old_string', 'new_string'],
    },
    execute: async (toolInput, ctx) => {
      const project = findProject(projectId)
      const resolved = resolveInsideProject(projectRoot(), toolInput.path)
      if (!resolved.ok) return { output: resolved.error, isError: true }
      // W4-F2：授权边界门（仅修复轮传入 writeScope 时生效；主 loop 无 holder 零变化）
      const writeScopeBlocked = guardWriteScope(resolved.rel)
      if (writeScopeBlocked) return writeScopeBlocked

      // D4a：版本前置校验（可选参数，提供即校验——把 R-FILE-01 从「prompt 劝说」
      // 升级为「工具强制」；不传零变化，向后兼容）。文件不存在时跳过（后续分支自有报错）。
      if (
        typeof toolInput.expected_revision === 'string' &&
        existsSync(resolved.abs)
      ) {
        const currentRev = fileRevisionOf(resolved.abs)
        if (currentRev !== toolInput.expected_revision) {
          return {
            output: `STALE_READ：${resolved.rel} 在你读取后已被修改（读时版本 ${toolInput.expected_revision}，当前 ${currentRev}）。请重新 read_file 后再编辑，禁止凭旧内容修改。`,
            isError: true,
            detail: { code: 'STALE_READ', path: resolved.rel },
          }
        }
      }

      // whole 模式：无 old_string，走整文件重写（弱渠道能力位）。
      // m-11：与 write_file 同口径的 16k 预拦截——整文件重写语义与 write_file 同构，
      // 绕过预拦截会让费用守卫在弱渠道（whole 模式）上失效
      if (typeof toolInput.old_string !== 'string') {
        if (typeof toolInput.content !== 'string') {
          return { output: '缺少参数：diff 模式需要 old_string + new_string，whole 模式需要 content。', isError: true }
        }
        const estTokens = estimateTokenCount(toolInput.content)
        if (decideWrite(toolInput.content) === 'chunk') {
          return {
            output: `单次写入内容过大（约 ${estTokens} tokens，阈值 16000）。请拆分为多次写入：先写骨架文件，再分段替换补充内容。`,
            isError: true,
            detail: { est_tokens: estTokens, threshold: 16000 },
          }
        }
        return validateAndWrite(projectRoot(), resolved.rel, toolInput.content, ctx)
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
      const replacement = replaceUniqueText(current, toolInput.old_string, toolInput.new_string)
      if (!replacement.ok) {
        return { output: replacement.matches === 0
          ? `old_string 在 ${resolved.rel} 中未命中。请先 read_file 定点（注意空白与引号须逐字一致）。`
          : `old_string 在 ${resolved.rel} 中命中 ${replacement.matches} 处，不唯一。请扩大上下文使片段唯一。`, isError: true }
      }
      const next = replacement.content
      // P1-06：模型显式 expected_revision 优先；未传时用本会话读到的版本作提交点校验基准
      const revisionBasis = typeof toolInput.expected_revision === 'string' ? toolInput.expected_revision : undefined
      return validateAndWrite(projectRoot(), resolved.rel, next, ctx, revisionBasis)
    },
  }

  // 子 agent（委派子会话）专属：向主 agent 挂起提问（M3 冒泡）。主 agent 用 answer_delegation_question 代答。

  /** W2（Phase 10，同步 Proma CompactContext）：显式压缩——模型完成大阶段后主动交接口收缩窗口。
 *  只置位请求标志（不直接动 messages——压缩必须在 loop 的安全点执行，与自动压缩同路径
 *  同语义：交接 LLM/keep-recent/检查点恢复头/观测埋点全部复用）；不占修复预算与写入预算。 */
  const compact_context: AgentLoopTool = {
    name: 'compact_context',
    description:
      '主动压缩上下文：把已完成的工作交接成一段摘要并重置对话窗口（保留近期原文与未闭环失败信息）。适合刚完成一个大阶段、或察觉上下文过长影响跟踪时调用；本轮工具结果落盘后立即生效。',
    input_schema: { type: 'object', properties: {} },
    execute: async (_toolInput, ctx) => {
      const used = ctx.state.explicit_compactions ?? 0
      if (used >= MAX_EXPLICIT_COMPACTIONS) {
        return {
          output: `显式压缩已达上限（${MAX_EXPLICIT_COMPACTIONS} 次）。请基于当前上下文继续工作，或直接输出完成总结。`,
          isError: true,
        }
      }
      if (ctx.state.compact_requested) {
        return { output: '已登记一次压缩，请勿重复调用；本轮结束后立即生效。' }
      }
      ctx.state.compact_requested = true
      return {
        output: `已登记压缩（第 ${used + 1}/${MAX_EXPLICIT_COMPACTIONS} 次显式压缩）：本轮工具结果落盘后立即执行，窗口重置为任务+交接文档+近期保留，未闭环失败会进恢复头。下一轮请依据恢复头继续。`,
        detail: { registered: true },
      }
    },
  }

  /** W3（Phase 10，同步 Proma find）：glob 文件名搜索——list_files 看目录、grep 挖内容，
   *  find 按模式定位文件（星号单段、双星跨目录，如所有 js 或 game-前缀模块）。只读并行五件套同档。 */
  const find: AgentLoopTool = {
    name: 'find',
    parallelSafe: true,
    description:
      '按 glob 模式搜索项目文件名（如 "src/**/*.js"、"*.css"），返回相对路径（最多 100 条）。支持 * 单段通配与 ** 跨目录通配；路径匹配不区分大小写（Windows 语义）。',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式，如 src/**/*.js 或 *.html' },
        path: { type: 'string', description: '限定搜索的子目录（可选，缺省全项目）' },
      },
      required: ['pattern'],
    },
    execute: async (toolInput) => {
      const project = findProject(projectId)
      const pattern = String(toolInput.pattern ?? '').trim()
      if (!pattern) return { output: '缺少 pattern 参数（glob 模式，如 src/**/*.js）。', isError: true }
      let subDir = ''
      if (typeof toolInput.path === 'string' && toolInput.path.trim()) {
        const resolved = resolveInsideProject(projectRoot(), toolInput.path)
        if (!resolved.ok) return { output: resolved.error, isError: true }
        subDir = resolved.rel
      }
      const matcher = globToRegExp(pattern)
      const hits = collectProjectFiles(projectRoot(), subDir).filter((rel) => matcher.test(rel))
      if (hits.length === 0) {
        // R0.2：命中不了平台托管目录（node_modules 等）时如实说明，防「找不到 = 不存在」误判
        const targetsManaged = [pattern, subDir].some((seg) => seg && seg.split('/').includes('node_modules'))
        const managedNote = targetsManaged
          ? '\n注：node_modules 由平台托管（vendor 供货已保证 express 等依赖可用），不出现在文件清单中——无匹配不等于依赖缺失，请勿据此改用零依赖实现。'
          : ''
        return { output: `无匹配文件（模式 ${pattern}${subDir ? `，目录 ${subDir}/` : ''}）。可用 list_files 查看实际文件清单。${managedNote}` }
      }
      const shown = hits.slice(0, FIND_ENTRY_LIMIT)
      const truncation = hits.length > shown.length ? `\n（共 ${hits.length} 个匹配，仅显示前 ${FIND_ENTRY_LIMIT} 个）` : ''
      return { output: `匹配 ${hits.length} 个文件：\n${shown.join('\n')}${truncation}`, detail: { count: hits.length } }
    },
  }

  if (role === 'explore' || role === 'research') {
    // 只读角色：探索/调研不需要写文件或跑测试，但可查公网资料、可向主 agent 冒泡提问
    return [read_file, list_files, find, grep, buildWebFetch(), ...buildDelegationTools(role)]
  }
  // W2（Phase 10，显式压缩）：仅主 loop 注册（BLOMA_COMPACT_TOOL 缺省 off）
  const compactTools = compactToolEnabled() ? [compact_context] : []

  if (role === 'review') {
    // 审查角色（m-12）：话术承诺「不直接修改」，工具面同步收窄——去掉 write_file/
    // edit_file（物理只读与话术一致，防提示词层面被诱导后真的落盘）；可跑预览/测试/
    // 扫描验证怀疑点，但不改产物
    return [read_file, list_files, find, grep, buildWebFetch(), ...buildDelegationTools(role)]
  }
  if (role !== 'parent') {
    // 子 agent（implement/custom）：通用件+ask 冒泡；领域验证面由 buildDomainTools 拼接（PR4c）
    return [
      read_file,
      list_files,
      find,
      grep,
      buildWebFetch(),
      write_file,
      edit_file,
      ...buildDelegationTools(role),
    ]
  }
  return [
    read_file,
    list_files,
    find,
    grep,
    buildWebFetch(),
    write_file,
    edit_file,
    ...compactTools,
    ...buildDelegationTools('parent'),
    buildWebResearch(projectId),
  ]
}


export function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 可选毫秒数：非有效数字返回 undefined（让 waitForDelegations 用内置缺省超时）。 */
/** 委派摘要的可读列表（模型视角）：id / role / status，completed 附结果摘要前 200 字，失败附错误。 */
