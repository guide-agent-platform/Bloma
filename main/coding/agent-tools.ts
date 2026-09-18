import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { rmSyncWithRetry } from '../fs-retry'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { findProject, readLastSketchRequirements } from '../project-service'
import { scheduleProjectMapRefresh } from '../project-map'
import { isInjectionEnabled } from '../template-injection'
import { getSandboxLogs, runSandbox } from '../platform-services'
import { readRealScaffoldVariant } from './preview-runtime'
import { rebuildRealFullstackDist } from './dist-rebuild'
import { runGwtScenarios } from '../gwt-service'
import { planScenarios, scenarioName } from '../gwt-runner'
import { decideWrite, estimateTokenCount } from '../usage-guard'
import { runSecurityScan } from '../security-scan'
import { checkApiContract } from './api-contract'
import { runArtifactUiGate } from './artifact-ui-gate'
import { getCachedStaticEvidence, setCachedStaticEvidence } from './evidence-cache'
import { readPrdBackplane } from '../document-engine'
import { withAbort, loopApiToolEnabled, toolEvidenceEnabled, writeGuardEnabled, preflightEnabled, compactToolEnabled, MAX_EXPLICIT_COMPACTIONS, type AgentLoopTool, type ToolContext, type ToolOutcome } from '../agent-loop'
import { browserToolsEnabled, buildPreviewBrowserTools } from './preview-browser'
import {
  NET_FETCH_DEFAULT_CHARS,
  NET_FETCH_MAX_BYTES,
  NET_FETCH_MAX_CHARS_LIMIT,
  NET_FETCH_TIMEOUT_MS,
  assertPublicHttpUrl,
  htmlToText,
} from '../net-guard'
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
  type StartDelegationResult,
} from '../agent-collaboration'

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
const WEB_RESEARCH_MAX_CHARS = 4000
/** web_research 调研子代理的收敛上限（毫秒）。 */
export const WEB_RESEARCH_TIMEOUT_MS = 90_000
let webResearchTimeoutMs = WEB_RESEARCH_TIMEOUT_MS

/** 测试 seam：缩短 web_research 等待上限（超时/取消用例不等真实 90s）。 */
export function setWebResearchTimeoutForTests(ms: number): void {
  webResearchTimeoutMs = ms
}

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
  if (!isInjectionEnabled('loop')) return null
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

/** D4a：文件版本戳 = mtimeMs+size 十六进制（同一 loop 内足够区分「读后已被改」）。 */
export function fileRevisionOf(absPath: string): string {
  try {
    const stat = statSync(absPath)
    return `${stat.mtimeMs.toString(16)}-${stat.size.toString(16)}`
  } catch {
    return 'unknown'
  }
}

/** D4a：state.file_revisions 惰性初始化（缺省 undefined = 功能未启用前的旧 state 兼容）。 */
function _fileRevisions(ctx: ToolContext): Map<string, string> {
  if (!ctx.state.file_revisions) ctx.state.file_revisions = new Map()
  return ctx.state.file_revisions
}

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
  return `\n验证状态：已通过=${done.length ? done.join('、') : '（无）'}；尚缺=${missing.join('、')}${loopApiToolEnabled() && !state.api_all_passed ? '（数据留存/接口类项目收口前必须 run_api_contract_tests 通过）' : ''}${preflightEnabled() && !state.preflight_passed ? '（收口前必须 run_preflight 全部通过）' : ''}。`
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
  const role = options.role ?? 'parent'
  // W3：真实脚手架变体（标记文件权威判定，骨架渲染时已落盘）——写边界/系统件集合/
  // 修复引导话术按变体分流；旧路径（无标记或项目缺席）false，行为字节级不变
  let realVariant = false
  try {
    realVariant = readRealScaffoldVariant(findProject(projectId).root_path) !== null
  } catch {
    realVariant = false
  }

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
  const validateAndWrite = async (root: string, rel: string, content: string, ctx: ToolContext): Promise<ToolOutcome> => {
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
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, finalContent, 'utf8')
    // D4a：写入成功后刷新版本快照（后续同文件 expected_revision 校验基準）
    _fileRevisions(ctx).set(rel, fileRevisionOf(abs))
    // project-map（Graft 模式，r69）：工程产物写盘后 fire-and-forget 刷新语义地图
    //（write_file / edit_file whole / edit_file diff 三路共用本写入点）；失败静默不影响返回
    try {
      scheduleProjectMapRefresh(findProject(projectId).workspace_slug, projectId, root)
    } catch {
      /* 项目索引缺失等：地图刷新放弃，写盘结果不受影响 */
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
      // D4a（咨询 D）：记录/返回文件版本戳（mtime+size 十六进制）——edit_file 的
      // expected_revision 校验与 write_file 守卫共用；纯追加信息，无行为变化。
      const revision = fileRevisionOf(resolved.abs)
      _fileRevisions(ctx).set(resolved.rel, revision)
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
        const resolved = resolveInsideProject(project.root_path, toolInput.path)
        if (!resolved.ok) return { output: resolved.error, isError: true }
        subDir = resolved.rel
      }
      const files = collectProjectFiles(project.root_path, subDir)
      // R0.2（2026-09-19 狗粮 7601e5ae）：平台托管目录不再伪装成「空目录」——模型据
      // 「目录为空」误判 express 未 vendor、白白零依赖重写；如实说明托管与供货保证。
      const topDir = subDir.split('/')[0]
      if (topDir && SKIPPED_DIRS.has(topDir)) {
        const managed = topDir === 'node_modules'
          ? 'node_modules 由平台托管（vendor 供货已保证 express 等依赖可用），不在产物清单中，也不允许直接修改'
          : `${topDir}/ 是平台基础设施目录，不在产物清单中`
        return { output: `${managed}。不要据此判断依赖缺失：判断后端可运行性请 run_preview，判断依赖声明请读 package.json。` }
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
    parallelSafe: true,
    description:
      '抓取公网网页/文档并转为纯文本（只查资料，不能修改任何东西）。参数：url（http/https 公网地址）、max_chars（返回文本上限，默认 12000，最大 50000）。内网/本机地址会被拒绝；例外：与当前预览地址同源的 URL 放行（可用于自查 /api 端点与页面实况）。HTML 只保留可见文本。',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的公网 http/https 地址' },
        max_chars: { type: 'number', description: '返回文本字符上限（默认 12000）' },
      },
      required: ['url'],
    },
    execute: async (toolInput, ctx) => {
      if (typeof toolInput.url !== 'string' || !toolInput.url.trim()) {
        return { output: '缺少 url 参数。', isError: true }
      }
      const rawUrl = toolInput.url.trim()
      // W3：预览 origin 放行（真实脚手架产物需要能探自己的 /api 与健康端点；仅限当前
      // 预览 origin——run_preview 已把地址放进 state；外域照走公网守卫不变）
      let previewOrigin: string | null = null
      try {
        previewOrigin = ctx.state.preview_url ? new URL(ctx.state.preview_url).origin : null
      } catch {
        previewOrigin = null
      }
      let localUrl: URL | null = null
      if (previewOrigin) {
        try {
          const candidate = new URL(rawUrl)
          if (candidate.origin === previewOrigin) localUrl = candidate
        } catch {
          /* 非法 URL 落回公网守卫拿规范报错 */
        }
      }
      const guarded = localUrl ? { ok: true as const, url: localUrl } : assertPublicHttpUrl(rawUrl)
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
      // 重定向终态复检：防公网 302 跳内网（redirect:'follow' 后 response.url 为终态）；
      // W3 补丁（2026-09-18 21:07 狗粮实锤）：预览 origin 内的响应（含同源重定向）放行——
      // 上批只改了初审，终态仍把 localhost 同源响应当「重定向到不允许的地址」拒掉，
      // 修复轮自查通路全断（模型只能读文件打转→noop→熔断白修）
      const finalRaw = response.url || guarded.url.toString()
      let finalOk: boolean
      if (previewOrigin) {
        try {
          finalOk = new URL(finalRaw).origin === previewOrigin
        } catch {
          finalOk = false
        }
        if (!finalOk) finalOk = assertPublicHttpUrl(finalRaw).ok
      } else {
        finalOk = assertPublicHttpUrl(finalRaw).ok
      }
      if (!finalOk) {
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
      const resolved = resolveInsideProject(project.root_path, toolInput.path)
      if (!resolved.ok) return { output: resolved.error, isError: true }
      // W4-F2：授权边界门（仅修复轮传入 writeScope 时生效；主 loop 无 holder 零变化）
      const writeScopeBlocked = guardWriteScope(resolved.rel)
      if (writeScopeBlocked) return writeScopeBlocked
      // D4a：write 守卫——覆盖「本轮未读过的既有文件」拦截（R-FILE-01 工具化：
      // 盲覆盖正式 BLOMA_WRITE_GUARD=on 才拦；off 零变化。新建文件不受影响）。
      if (existsSync(resolved.abs) && !_fileRevisions(ctx).has(resolved.rel)) {
        if (writeGuardEnabled()) {
          return {
            output: `目标文件已存在且本轮未读取过：${resolved.rel}。先 read_file 获取当前内容（R-FILE-01），再决定 edit_file 精确修改或基于读取结果重写；禁止盲覆盖。`,
            isError: true,
            detail: { code: 'WRITE_UNREAD_TARGET', path: resolved.rel },
          }
        }
      }
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
        expected_revision: { type: 'string', description: '（可选，D4a）read_file 返回的文件版本；提供时若文件已被修改过会返回 STALE_READ 拒绝执行，需重新 read_file' },
      },
      required: editFormat === 'whole' ? ['path'] : ['path', 'old_string', 'new_string'],
    },
    execute: async (toolInput, ctx) => {
      const project = findProject(projectId)
      const resolved = resolveInsideProject(project.root_path, toolInput.path)
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
        // D2：预览就绪只证明服务可访问，未验证行为——附一行证据边界防「预览绿=可交付」误读
        const evidence = toolEvidenceEnabled() ? '\n（预览就绪仅证明服务可访问；行为断言/ API 契约/安全均未验证。）' : ''
        // W2：成功态也回流最近服务日志（真实服务器下运行期堆栈/路由错误是一手调试证据，
        // 不等失败才可见；静态旧路径日志安静时零增加）
        const tail = getSandboxLogs(projectId).trim().slice(-1200)
        const logSection = tail ? `\n最近服务日志：\n${tail}` : ''
        return { output: `预览已启动：${sandbox.preview_url}${evidence}${logSection}`, detail: { preview_url: sandbox.preview_url } }
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
      // R0.1（2026-09-19 狗粮 7601e5ae）：模型侧测试与平台终验同口径——测试前确保
      // dist 是 src 最新构建（防「改完 src 测旧 bundle」的假红反馈回路；非 fullstack no-op）
      await rebuildRealFullstackDist({ projectId, sessionId: ctx.sessionId })
      const result = await runGwtScenarios({ project_id: projectId, session_id: ctx.sessionId, preview_url: ctx.state.preview_url })
      // W2-F4：执行计数无条件更新（终验 source 分类的确定性判据，与展示开关解耦）
      ctx.state.gwt_runs = (ctx.state.gwt_runs ?? 0) + 1
      if (result.failed_count > 0) {
        // 修复预算口径：每次失败运行 = 一个新修复回合（对应旧 test_repair_count +1）
        ctx.state.test_failed = true
        ctx.state.gwt_all_passed = false
        ctx.state.repair_round += 1
        options.onRepairRound?.(ctx.state.repair_round)
        // D3 轻量：对比上轮失败集标 [新增]/[持续]（防重复修同一失败），跑后更新快照。
        // W2-F4：快照更新改无条件（终验 source 分类需要；展示仍由开关控制）。
        const prev = new Set(ctx.state.last_gwt_failures ?? [])
        const failures = result.failure_summary
          .map((failure) => {
            const tag = toolEvidenceEnabled() ? (prev.has(failure.scenario) ? '[持续] ' : '[新增] ') : ''
            return `- ${tag}${failure.scenario}：${failure.reason}`
          })
          .join('\n')
        // W2-F4 修复比较（D4 稿：修 A 挂 B 可见，升级计数不靠模型自己数）：
        // resolved=上轮失败本轮已过 / persistent=两轮都挂 / new=本轮新挂。开关 on 才展示。
        const current = result.failure_summary.map((f) => f.scenario)
        const persistent = current.filter((s) => prev.has(s))
        const fresh = current.filter((s) => !prev.has(s))
        const resolved = [...prev].filter((s) => !current.includes(s))
        const comparison = toolEvidenceEnabled()
          ? `\n较上次：修复 ${resolved.length}${resolved.length > 0 ? `（${resolved.join('、')}）` : ''}｜持续 ${persistent.length}｜新增 ${fresh.length}${fresh.length > 0 ? '（修一处坏一处，先查共享影响）' : ''}`
          : ''
        ctx.state.last_gwt_failures = current
        const evidence = validationStateLine(ctx.state)
        return {
          output: `共 ${result.total_count} 个场景：通过 ${result.passed_count}、失败 ${result.failed_count}。\n失败场景：\n${failures}${comparison}${evidence}`,
          detail: { failed_count: result.failed_count, total_count: result.total_count },
        }
      }
      // 全过显式列出场景名（ACI：空结果显式反馈 + 可核对的通过清单）。
      // M-11：同时清零失败粘性——测试全过后 test_failed/edits_after_test_failure 复位，
      // 否则后续安全修复的 edit 仍计入旧测试失败的预算，连续 2 轮撞限即 budget_exhausted
      // 终止，高危漏洞未修进交付。
      ctx.state.gwt_all_passed = true
      ctx.state.test_failed = false
      ctx.state.edits_after_test_failure = 0
      // W2-F4：快照复位无条件（口径同上轮更新）
      ctx.state.last_gwt_failures = []
      const scenarioNames = planScenarios(readLastSketchRequirements(projectId)).map((scenario) =>
        scenarioName(scenario.item.id, scenario.assertion),
      )
      const nameList = scenarioNames.length > 0 ? `\n通过场景：${scenarioNames.join('、')}` : ''
      // D2：删旧「可以继续…或输出完成总结」收口暗示，换宿主维护的验证状态行
      // （单次 GWT 全绿不等于可交付——API 契约/安全可能未验）。off 分支保留原句（字节级现状）。
      const tail = toolEvidenceEnabled()
        ? validationStateLine(ctx.state)
        : '\n测试通过，可以继续 run_security_scan 或输出完成总结。'
      return {
        output: `全部通过（${result.passed_count}/${result.total_count} 个场景）。${nameList}${tail}`,
        detail: { passed_count: result.passed_count, total_count: result.total_count },
      }
    },
  }

  const run_security_scan: AgentLoopTool = {
    name: 'run_security_scan',
    description: '对项目产物做安全静态扫描。通过时明确说明；发现高危/严重问题时列出 file:line 与修复建议。',
    input_schema: { type: 'object', properties: {} },
    execute: async (_toolInput, ctx) => {
      const project = findProject(projectId)
      const result = runSecurityScan({ project_id: projectId, root_path: project.root_path })
      const blocking = result.issues.filter((issue) => issue.severity === 'high' || issue.severity === 'critical')
      if (result.passed) {
        ctx.state.security_all_passed = true
        const minor = result.issues.length - blocking.length
        // D2：通过返回附验证状态行（尚缺项由宿主维护）
        const evidence = validationStateLine(ctx.state)
        return {
          output: `安全扫描通过：无高危/严重问题（扫描 ${result.scanned_files} 个文件${minor > 0 ? `，另有 ${minor} 个低/中危提示` : ''}）。${evidence}`,
          detail: { passed: true, scanned_files: result.scanned_files },
        }
      }
      ctx.state.security_all_passed = false
      const listing = blocking.map((issue) => `- ${issue.file}:${issue.line} ${issue.user_visible_summary}`).join('\n')
      return {
        output: `安全扫描未通过（${blocking.length} 个高危/严重问题，扫描 ${result.scanned_files} 个文件）：\n${listing}\n请修复后重新扫描。`,
        detail: { passed: false, blocking: blocking.length },
      }
    },
  }

  // D1（咨询 D，2026-09-09）：API 契约验证进 loop——复用终验同款 checkApiContract，
  // 不新建判断标准；外部终验仍独立执行（共享实现 ≠ 共享判定权）。仅 BLOMA_API_TOOL=on 注册。
  const run_api_contract_tests: AgentLoopTool = {
    name: 'run_api_contract_tests',
    parallelSafe: true,
    description:
      '验证 PRD 接口契约（interface_spec）声明的后端 API 端点是否存活并应答（无参 GET 端点逐一探测；无参 POST 端点发空 JSON 体探挂载——404=未挂载计失活，400/422=校验拒绝不算失败；GET 5xx/超时=契约失活）。用途：收口前证明前后端契约真实生效；不验证业务逻辑正确性（那属于行为断言）。前置：需先 run_preview。无接口契约的项目返回豁免说明。',
    input_schema: { type: 'object', properties: {} },
    execute: async (_toolInput, ctx) => {
      if (!ctx.state.preview_url) {
        return { output: '还没有可用的预览地址。请先调用 run_preview 启动预览，再验证 API 契约。', isError: true }
      }
      const endpoints = readPrdBackplane(projectId)?.interface_spec ?? []
      // W2-F4：执行计数（有契约才计；豁免分支不算「验过」）
      if (endpoints.length > 0) ctx.state.api_contract_runs = (ctx.state.api_contract_runs ?? 0) + 1
      if (endpoints.length === 0) {
        ctx.state.api_all_passed = true
        return {
          output: '本项目无接口契约（interface_spec 为空，纯静态产物），API 契约验证豁免通过。',
          detail: { exempt: true, endpoints: 0 },
        }
      }
      const failures = await checkApiContract(ctx.state.preview_url, endpoints)
      ctx.state.api_all_passed = failures.length === 0
      if (failures.length === 0) {
        const listing = endpoints.map((ep) => `- ${ep.method ?? 'GET'} ${ep.endpoint}`).join('\n')
        const evidence = validationStateLine(ctx.state)
        return {
          output: `API 契约验证通过：${endpoints.length} 个声明端点全部应答正常。\n${listing}${evidence}`,
          detail: { passed: true, endpoints: endpoints.length },
        }
      }
      const listing = failures.map((f) => `- API 契约端点：${f.scenario} — ${f.reason}`).join('\n')
      const evidence = validationStateLine(ctx.state)
      // W3：失败输出附预览地址与服务日志尾部（真实服务器下运行期堆栈是一手证据；
      // 修复指引按变体分流——Express 项目指 server.js，旧路径指 server/routes/）
      const fixGuide = realVariant
        ? '请对照 server.js / server/ 下的路由实现修复后重验（Express：app.get/post 注册）。'
        : '请对照 server/routes/ 的路由实现修复后重验。'
      const logTail = getSandboxLogs(projectId).trim().slice(-SANDBOX_LOG_TAIL_LIMIT)
      const logSection = logTail ? `\n服务日志尾部：\n${logTail}` : ''
      return {
        output: `API 契约验证未通过（${failures.length}/${endpoints.length} 个端点失败；预览 ${ctx.state.preview_url}）：\n${listing}\n${fixGuide}${logSection}${evidence}`,
        detail: { passed: false, failed: failures.length, endpoints: endpoints.length, preview_url: ctx.state.preview_url },
      }
    },
  }

  // W3-D1（咨询 D2《验证分层与收口预检》）：收口预检宿主工具——一次调用按依赖顺序跑全部
  // 验证面（GWT 全量 → API 契约（有声明才验）→ 产物 UI 审计 → 安全扫描）。复用终验
  // 同款实现（规则同源、执行独立：终验仍对冻结候选独立取证）；构建门禁不在 v0 预检面
  // （需 skeleton 上下文，终验门禁保留）。收口判定消费 preflight_passed（agent-loop
  // wrapUp）；失败留在 loop 内修（D5）——不退出重建修复卡。仅 BLOMA_PREFLIGHT=on 注册。
  const run_preflight: AgentLoopTool = {
    name: 'run_preflight',
    description:
      '收口预检：一次调用按依赖顺序跑全部验证面（GWT 行为断言全量 → API 契约（声明了才验）→ 产物 UI 审计 → 安全扫描），给出收口判定与逐阶段失败清单。收口（输出完成总结）前必须通过本预检；失败就留在当前循环内修复后重跑，不要带病宣布完成。',
    input_schema: { type: 'object', properties: {} },
    execute: async (_toolInput, ctx) => {
      if (!ctx.state.preview_url) {
        return { output: '还没有可用的预览地址。请先调用 run_preview 启动预览，再运行收口预检。', isError: true }
      }
      const lines: string[] = []
      let allPassed = true

      // 阶段 1：GWT 全量（与 run_gwt_tests 同源；同步维护修复预算/失败快照口径）
      const gwt = await runGwtScenarios({ project_id: projectId, session_id: ctx.sessionId, preview_url: ctx.state.preview_url })
      ctx.state.gwt_runs = (ctx.state.gwt_runs ?? 0) + 1
      if (gwt.failed_count > 0) {
        ctx.state.test_failed = true
        ctx.state.gwt_all_passed = false
        ctx.state.repair_round += 1
        options.onRepairRound?.(ctx.state.repair_round)
        ctx.state.last_gwt_failures = gwt.failure_summary.map((f) => f.scenario)
        allPassed = false
        lines.push(`① GWT 行为断言：失败（${gwt.failed_count}/${gwt.total_count}）`)
        for (const failure of gwt.failure_summary.slice(0, 10)) lines.push(`  - ${failure.scenario}：${failure.reason}`)
      } else {
        ctx.state.gwt_all_passed = true
        ctx.state.test_failed = false
        ctx.state.edits_after_test_failure = 0
        ctx.state.last_gwt_failures = []
        lines.push(`① GWT 行为断言：通过（${gwt.passed_count}/${gwt.total_count}）`)
      }

      // 阶段 2：API 契约（无声明豁免；同 run_api_contract_tests 口径）
      const endpoints = readPrdBackplane(projectId)?.interface_spec ?? []
      if (endpoints.length === 0) {
        ctx.state.api_all_passed = true
        lines.push('② API 契约：豁免（interface_spec 为空）')
      } else {
        ctx.state.api_contract_runs = (ctx.state.api_contract_runs ?? 0) + 1
        const apiFailures = await checkApiContract(ctx.state.preview_url, endpoints)
        ctx.state.api_all_passed = apiFailures.length === 0
        if (apiFailures.length > 0) {
          allPassed = false
          lines.push(`② API 契约：失败（${apiFailures.length}/${endpoints.length}）`)
          for (const failure of apiFailures) lines.push(`  - ${failure.scenario}：${failure.reason}`)
        } else {
          lines.push(`② API 契约：通过（${endpoints.length} 个端点）`)
        }
      }

      // 阶段 3：产物 UI 审计（L0 探针；探针不可用不判败只留痕——终验 L1 视觉审计仍独立）
      try {
        const gate = await runArtifactUiGate({ previewUrl: ctx.state.preview_url })
        if (gate.failures.length > 0) {
          allPassed = false
          lines.push(`③ 产物 UI 审计：失败（${gate.failures.length}）`)
          for (const failure of gate.failures.slice(0, 10)) lines.push(`  - ${failure.scenario}：${failure.reason}`)
        } else if (gate.status === 'unavailable') {
          lines.push(`③ 产物 UI 审计：未执行（${gate.note ?? '探针失败'}）——终验仍会独立探测`)
        } else {
          lines.push('③ 产物 UI 审计：通过')
        }
      } catch {
        lines.push('③ 产物 UI 审计：未执行（探针异常）——终验仍会独立探测')
      }

      // 阶段 4：安全扫描（静态；同 run_security_scan；W6-D6 按产物指纹缓存复用，终验共享）
      const project = findProject(projectId)
      const cachedSecurity = getCachedStaticEvidence<ReturnType<typeof runSecurityScan>>(projectId, project.root_path, 'security-scan')
      const security = cachedSecurity ?? runSecurityScan({ project_id: projectId, root_path: project.root_path })
      if (!cachedSecurity) setCachedStaticEvidence(projectId, project.root_path, 'security-scan', security)
      ctx.state.security_all_passed = security.passed
      if (!security.passed) {
        allPassed = false
        lines.push(`④ 安全扫描：失败（${security.issues.length} 处命中）`)
        for (const issue of security.issues.slice(0, 10)) lines.push(`  - ${issue.severity} ${issue.file}:${issue.line}——${issue.user_visible_summary}`)
      } else {
        lines.push('④ 安全扫描：通过')
      }

      ctx.state.preflight_passed = allPassed
      const verdict = allPassed
        ? '收口预检通过：全部验证面通过，可以输出完成总结（外部终验仍会独立复核）。'
        : '收口预检未通过：留在当前循环内修复上述失败，修复后重新 run_preflight；不要带病宣布完成。'
      return {
        output: `【收口预检】\n${lines.join('\n')}\n${verdict}`,
        detail: { preflight_passed: allPassed, gwt_failed: gwt.failed_count, security_passed: security.passed },
      }
    },
  }

  // W4-F3（咨询 D4）：修复控制窄入口——判别联合四字段，宿主裁决（确定性规则，零 LLM）。
  // 「已申请≠已授权」：request_scope_expansion 返回 approved 才算扩权；受保护路径与
  // 全项目申请一律拒。仅修复轮传入 writeScope 时注册（主 loop 无此工具，面最小化）。
  const repair_control: AgentLoopTool = {
    name: 'repair_control',
    description:
      '修复控制窄入口（仅修复轮）：①action=request_scope_expansion——根因在授权外文件时申请扩大修改授权（必填 issue_id/requested_paths/reason/change_intent；申请绑定具体失败与文件，不能申请全项目可写）；②action=report_blocker——证据缺失/环境异常/授权不足时如实报告受阻。已申请≠已授权，以返回的裁决为准。',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['request_scope_expansion', 'report_blocker'] },
        issue_id: { type: 'string', description: '关联失败场景/断言 id（request_scope_expansion 必填）' },
        requested_paths: { type: 'array', items: { type: 'string' }, description: '申请扩大的项目内相对路径（request_scope_expansion 必填）' },
        reason: { type: 'string', description: '根因证据：为什么根因在这些文件（request_scope_expansion 必填）' },
        change_intent: { type: 'string', description: '改动意图：打算怎么改（request_scope_expansion 必填）' },
        blocker_reason: { type: 'string', description: 'report_blocker：受阻原因' },
        evidence: { type: 'string', description: 'report_blocker：证据引用（日志/断言原文/请求记录）' },
      },
      required: ['action'],
    },
    execute: async (toolInput) => {
      const scope = options.writeScope!
      const now = new Date().toISOString()
      if (toolInput.action === 'request_scope_expansion') {
        const issueId = typeof toolInput.issue_id === 'string' ? toolInput.issue_id : ''
        const reason = typeof toolInput.reason === 'string' ? toolInput.reason : ''
        const intent = typeof toolInput.change_intent === 'string' ? toolInput.change_intent : ''
        const paths = Array.isArray(toolInput.requested_paths) ? toolInput.requested_paths.filter((p): p is string => typeof p === 'string') : []
        if (!issueId || !reason || !intent || paths.length === 0) {
          return { output: '申请缺少必填字段（issue_id/requested_paths/reason/change_intent），补齐后重新申请。', isError: true }
        }
        // 裁决规则（D4 §三）：普通实现文件→自动批准；受保护/全项目/超量→拒
        if (paths.length > 8 || paths.some((p) => p.includes('*'))) {
          scope.expansions.push({ issue_id: issueId, paths, reason, at: now, decision: 'denied', note: 'wildcard-or-over-quota' })
          return { output: '拒绝：不能申请全项目可写（含通配符或单次超过 8 个路径）。申请必须绑定具体失败与具体文件。', isError: true }
        }
        const normalized = paths.map((p) => p.replace(/\\/g, '/'))
        const protectedHit = normalized.filter((p) => scope.protectedPaths.has(p))
        if (protectedHit.length > 0) {
          scope.expansions.push({ issue_id: issueId, paths: normalized, reason, at: now, decision: 'denied', note: 'protected-path' })
          return { output: `拒绝：${protectedHit.join('、')} 是受保护文件（权威契约/宿主产物），不因修复需求开放修改。若失败源于它们，请 report_blocker 说明。`, isError: true }
        }
        for (const p of normalized) scope.authorized.add(p)
        scope.expansions.push({ issue_id: issueId, paths: normalized, reason, at: now, decision: 'approved' })
        return {
          output:
            `已批准：${normalized.join('、')} 加入本轮修改授权（issue=${issueId}）。` +
            '继续前先 read_file 核对现状与文件版本；修复完成后必须完整重验（run_gwt_tests 或 run_preflight），不得凭旧证据交差。',
        }
      }
      if (toolInput.action === 'report_blocker') {
        const blockerReason = typeof toolInput.blocker_reason === 'string' ? toolInput.blocker_reason : ''
        if (!blockerReason) return { output: 'report_blocker 缺少 blocker_reason。', isError: true }
        const evidence = typeof toolInput.evidence === 'string' ? toolInput.evidence : undefined
        scope.blockers.push({ reason: blockerReason, ...(evidence ? { evidence } : {}), at: now })
        return {
          output:
            '受阻已记录（原因/证据进宿主账本，升级或让渡由宿主决定）。建议：①证据缺失先做区分性检查（能区分两种候选根因的那种）；' +
            '②测试环境异常如实标注，不硬判产品缺陷；③需要独立定位可 delegate_agent(role=research 只读) 诊断。',
        }
      }
      return { output: `未知 action：${String(toolInput.action)}。`, isError: true }
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

  // 委派化联网调研（闭环 PR5，随感 43「查资料 fork 出去」）：主 loop 上下文只进
  // ≤4000 字精干结论，原文抓取全部发生在 research 子代理（其工具面含 web_fetch）。
  const web_research: AgentLoopTool = {
    name: 'web_research',
    parallelSafe: true,
    description:
      '针对一个问题或一个 URL 派出只读调研子代理：抓取/检索后总结成精干结论返回（≤4000 字），' +
      '不占用当前上下文。适合查文档、找方案、比对做法；只需抓单页原文时用 web_fetch。' +
      '参数：question（要查清的问题，或直接给 URL）、focus（关注点，可选）。',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要查清的问题或目标 URL' },
        focus: { type: 'string', description: '重点关注哪方面（可选）' },
      },
      required: ['question'],
    },
    execute: async (toolInput, ctx) => {
      const question = String(toolInput.question ?? '').trim()
      if (!question) return { output: '缺少 question 参数。', isError: true }
      const focus = typeof toolInput.focus === 'string' && toolInput.focus.trim() ? toolInput.focus.trim() : undefined
      let started: StartDelegationResult | undefined
      try {
        started = startDelegation(ctx, {
          task:
            `联网调研并总结（你是只读调研子代理，不能修改任何文件）：\n问题：${question}` +
            `${focus ? `\n重点关注：${focus}` : ''}\n` +
            `要求：用 web_fetch 抓取必要页面后，输出不超过 2000 字的中文结论（要点+出处 URL），不要贴原文大段。`,
          role: 'research',
          expectedOutput: '≤2000 字中文结论 + 出处 URL',
        })
        // withAbort：主 loop 取消时立即解除等待（waitForDelegations 本体不监听外部
        // signal，见 abb1a19f 缺陷①的同类问题）；孤儿清理由 runMvpViaAgentLoop 的
        // finally disposeParentDelegationState 兑底。
        const summaries = await withAbort(
          waitForDelegations(ctx, { strategy: 'all', delegationIds: [started.delegation_id], timeout_ms: webResearchTimeoutMs }),
          ctx.signal,
        )
        const summary = summaries[0]
        if (!summary || summary.status === 'running') {
          stopDelegation(ctx.sessionId, started.delegation_id)
          // 子代理冒泡提问（审查 P1-3）：waitForDelegations 对 askSignal 提前返回，这不是超时；
          // 如实转述问题并建议改路，不得谎报「未收敛」击杀有进展的子代理
          if (summary?.pending_question) {
            return {
              output: `调研子代理中途需要澄清问题：「${summary.pending_question.slice(0, 200)}」。这类问题不适合委派调研：可把 question 拆得更具体后重试，或改用 web_fetch 直接抓取。`,
              isError: true,
            }
          }
          return {
            output: `调研子代理 ${Math.round(webResearchTimeoutMs / 1000)}s 内未收敛，已停止。请基于已有信息继续，或缩小问题后重试。`,
            isError: true,
          }
        }
        if (summary.status !== 'completed' || !summary.result_summary) {
          return { output: `调研子代理未成功（status=${summary.status}）。可改用 web_fetch 直接抓取。`, isError: true }
        }
        // 剥「子代理状态：」头行（同 review-delegation），内部运行指标不进模型上下文
        const body = summary.result_summary.split('\n').slice(1).join('\n').trim()
        // 空结论显式化（审查 P2-3）：完成但无产出不能假装成功，给重试/替代建议
        if (!body) {
          return { output: '调研子代理完成了任务但没有产出结论（可能空响应）。可重试一次，或改用 web_fetch 直接抓取。', isError: true }
        }
        return { output: `调研结论：\n${body.slice(0, WEB_RESEARCH_MAX_CHARS)}`, detail: { delegation_id: started.delegation_id } }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (ctx.signal.aborted || message.includes('AGENT_CANCELLED')) {
          return { output: `调研等待已随主任务取消中止（委派 ${started?.delegation_id ?? '未知'}，由平台收尾停止）。`, isError: true }
        }
        return { output: `调研委派失败：${message}。可改用 web_fetch 直接抓取。`, isError: true }
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
        const resolved = resolveInsideProject(project.root_path, toolInput.path)
        if (!resolved.ok) return { output: resolved.error, isError: true }
        subDir = resolved.rel
      }
      const matcher = globToRegExp(pattern)
      const hits = collectProjectFiles(project.root_path, subDir).filter((rel) => matcher.test(rel))
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
    return [read_file, list_files, find, grep, web_fetch, ask_delegation_question]
  }
  // D1：API 契约验证工具按开关注册（off=工具面与现状字节级一致）
  const apiTools = loopApiToolEnabled() ? [run_api_contract_tests] : []
  // W3-D1：收口预检按开关注册（主/实现角色；审查角色不收口不注入）
  const preflightTools = preflightEnabled() ? [run_preflight] : []
  // W4-F3：修复控制窄入口——仅修复轮传入 writeScope 时注册（主 loop 无此工具）
  const repairControlTools = options.writeScope ? [repair_control] : []
  // W1（Phase 10，预览浏览器工具族）：仅主 loop 注册（BLOMA_BROWSER_TOOLS 缺省 off）
  const browserTools = browserToolsEnabled() ? buildPreviewBrowserTools(projectId) : []
  // W2（Phase 10，显式压缩）：仅主 loop 注册（BLOMA_COMPACT_TOOL 缺省 off）
  const compactTools = compactToolEnabled() ? [compact_context] : []

  if (role === 'review') {
    // 审查角色（m-12）：话术承诺「不直接修改」，工具面同步收窄——去掉 write_file/
    // edit_file（物理只读与话术一致，防提示词层面被诱导后真的落盘）；可跑预览/测试/
    // 扫描验证怀疑点，但不改产物
    return [read_file, list_files, find, grep, web_fetch, run_preview, run_gwt_tests, run_security_scan, ...apiTools, ask_delegation_question]
  }
  if (role !== 'parent') {
    // 子 agent（implement/custom）：全量 9 工具 + ask 冒泡；无委派/代答/续跑工具（深度限制双保险）
    return [
      read_file,
      list_files,
      find,
      grep,
      web_fetch,
      write_file,
      edit_file,
      run_preview,
      run_gwt_tests,
      run_security_scan,
      ...apiTools,
      ...preflightTools,
      ask_delegation_question,
    ]
  }
  return [
    read_file,
    list_files,
    find,
    grep,
    web_fetch,
    write_file,
    edit_file,
    run_preview,
    run_gwt_tests,
    run_security_scan,
    ...apiTools,
    ...preflightTools,
    ...repairControlTools,
    ...browserTools,
    ...compactTools,
    delegate_agent,
    web_research,
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
