import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { softwareProcessIssues } from './software-process-check'

/**
 * A3 OWASP 安全扫描器（api-spec §12.9 `run_security_scan`）。
 *
 * 对生成的产物（HTML / JS / CSS / Python）做确定性的 OWASP Top 10 基础静态扫描，检测：
 * - 动态代码执行（eval / new Function / document.write / Python eval・exec）—— XSS 高危向量；
 * - Python 进程生成硬红线（os.system / os.popen / subprocess shell=True）—— 桌面线 driver
 *   与骨架在本机真实 spawn 执行，注入向量必须静态拦截（全链路审查 P0-2，2026-10-01）；
 * - 硬编码敏感信息（api key / password / secret / token）—— 敏感数据暴露；
 * - 不安全的 DOM 写入（innerHTML 赋变量）—— XSS 注入点；
 * - 内联事件处理器（onclick/onerror/onload=）—— 脚本注入面；
 * - 非加密网络资源引用（http://）—— 传输层不安全。
 *
 * 只读扫描，不改产物；`passed=false` 表示存在 high/critical 命中，由调用方接入
 * security_error 修复（loop 内化：Agent Loop 收到未过报告后自行 edit_file 修复重扫，
 * 7992edc 废旧管道转正后 repair-engine 已删）。所有面向用户的
 * 摘要文案不含 XSS / SQL 注入等技术术语（self-healing-judge @S2-JUDGE-008）。
 */

export type SecuritySeverity = 'low' | 'medium' | 'high' | 'critical'

export type SecurityIssueCategory =
  | 'dangerous_execution'
  | 'sensitive_data'
  | 'unsafe_dom'
  | 'inline_event_handler'
  | 'insecure_resource'
  | 'external_resource'

export interface SecurityIssue {
  severity: SecuritySeverity
  category: SecurityIssueCategory
  /** 面向用户的摘要，不含 XSS / SQL 注入等技术术语 */
  user_visible_summary: string
  file: string
  line: number
}

export interface SecurityScanResult {
  passed: boolean
  issues: SecurityIssue[]
  scanned_files: number
}

export interface SecurityScanInput {
  project_id: string
  root_path: string
  /** Host-selected workflow context; never accepted from generated files. */
  profile?: 'web-sandbox' | 'local-software'
}

interface ScanRule {
  category: SecurityIssueCategory
  severity: SecuritySeverity
  pattern: RegExp
  summary: string
  /** W5（2026-09-18 真实脚手架）：仅产物服务器代码生效（server.js 与 server/ 子树）——
   *  前端 fetch('/api/...') 合法，不能按全局行规则误杀；真实工程后端权力变大，
   *  扫描面同步扩到进程生成/出网两类硬红线。 */
  serverOnly?: boolean
  /** 仅 .py 文件生效（P0-2，2026-10-01）：Python 语法与 JS 同形词不互扰（如 JS regex.exec/execSync 不命中 Python exec 规则）。 */
  pyOnly?: boolean
  nonPyOnly?: boolean
}

/** 扫描规则：按严重度从高到低排列，同一行命中首个规则即止（避免重复上报）。 */
const SCAN_RULES: ScanRule[] = [
  {
    category: 'dangerous_execution',
    severity: 'critical',
    pattern: /\beval\s*\(|new\s+Function\s*\(|document\.write(?:ln)?\s*\(/,
    nonPyOnly: true,
    summary: '检测到一段可被外部内容改变行为的脚本，建议改写成更安全的实现方式',
  },
  // ---- Python 危险调用（桌面线 driver/scaffold 在本机真实执行，全链路审查 P0-2） ----
  {
    category: 'dangerous_execution',
    severity: 'critical',
    pyOnly: true,
    pattern: /\bos\.system\s*\(|\bos\.popen\s*\(|\bsubprocess\.[A-Za-z_]+\s*\([^)]*shell\s*=\s*True/,
    summary: 'Python 代码里存在直接执行系统命令的写法，存在被拼接恶意命令的风险，请改用参数列表形式或移除',
  },
  {
    category: 'dangerous_execution',
    severity: 'high',
    pyOnly: true,
    pattern: /(?:^|[^.\w])\b(?:eval|exec)\s*\(/,
    summary: 'Python 代码里存在动态执行字符串的写法，建议改写成固定的显式逻辑',
  },
  {
    category: 'sensitive_data',
    severity: 'high',
    pattern: /(?:api[_-]?key|password|passwd|secret|token|access[_-]?key)\s*[:=]\s*["'][^"']{4,}["']/i,
    summary: '页面里似乎写死了一段敏感信息（如密码或密钥），建议移除或改为安全存储',
  },
  {
    category: 'unsafe_dom',
    severity: 'high',
    // `[^\s"']`：等号后首个非空白字符既不是引号也不是空白，才视为「赋变量/表达式」。
    // 静态字符串（innerHTML = "<b>ok</b>"）是安全写法，不命中（否则会误报引发无效修复循环）。
    pattern: /\.innerHTML\s*=\s*[^\s"']/,
    summary: '页面用了一种可能被注入额外内容的显示方式，建议改为更安全的内容写入方式',
  },
  {
    category: 'external_resource',
    severity: 'high',
    // M-10：HTML 静态外链拦截（agent-tools）只覆盖 .html 文件；.js 内动态加载
    // （createElement('script')+外网 src / 动态 import 外网模块 / .css @import 外网）
    // 全盲，且导出产物脱离沙箱 CSP 后只剩这道防线——升 high 阻断交付。
    pattern: /createElement\s*\(\s*['"]script['"]\s*\)|\bimport\s*\(\s*['"]https?:\/\/|@import\s+(?:url\s*\()\s*['"]?https?:\/\//i,
    summary: '检测到动态加载外部资源的代码，沙箱与导出产物都不允许联网加载，请改为本地内联实现',
  },
  {
    category: 'inline_event_handler',
    severity: 'medium',
    pattern: /\son(?:click|error|load|mouseover|submit|change)\s*=/i,
    summary: '页面把一些动作直接写在了元素标签里，建议集中管理以便统一防护',
  },
  {
    category: 'insecure_resource',
    severity: 'low',
    pattern: /(?:src|href|url)\s*[:=]\s*["']http:\/\//i,
    summary: '页面引用了一个不够安全的网络资源链接，建议换成加密的安全链接',
  },
  // ---- W5：产物服务器硬红线（serverOnly——前端同款写法合法，不进全局面） ----
  {
    category: 'dangerous_execution',
    severity: 'critical',
    serverOnly: true,
    pattern: /\brequire\s*\(\s*['"]child_process['"]\s*\)|\bfrom\s+['"]child_process['"]|\bspawnSync\s*\(|\bexecSync\s*\(/,
    summary: '产物服务器代码调用了进程生成能力（child_process/exec/spawn），不在产物能力面内，请移除',
  },
  {
    category: 'external_resource',
    severity: 'high',
    serverOnly: true,
    // fetch('https://…') 直连外网（同源 '/api/…' 相对路径合法不命中）；
    // axios/https.request/net.connect 同类。真实外部服务应走同源代理模式。
    pattern: /\bfetch\s*\(\s*['"]https?:\/\/|\baxios\b|\bhttps?\s*\.\s*request\s*\(|\bnet\s*\.\s*connect\s*\(/,
    summary: '产物服务器代码重连外网服务；外部能力应走同源代理或平台 /api/llm 渠道，请移除直连',
  },
]

/** 参与扫描的产物扩展名（静态前端产物 + 桌面线 Python：driver/scaffold 在本机真实执行，P0-2）。 */
const SCAN_EXTENSIONS = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.css', '.py'])

/** venv 标志文件（2026-10-05 安全门误报根治）：目录含此文件即 venv，整棵剪枝——
 *  不管叫 .venv / .venv-probe / venv / env（狗粮 256001d0 实证：子会话自发建
 *  .venv-probe，名字法穿透，pip 自带源码的 eval/exec/shell=True 命中红线 14 处，
 *  verify 安全门误拒收且拒因笼统，模型按错误线索空转三轮）。标记法优于竞品
 *  Proma-Easy 的纯名字排除（他们同样挡不住异名 venv）。 */
export function isVenvDirectory(dir: string): boolean {
  try {
    return existsSync(join(dir, 'pyvenv.cfg'))
  } catch {
    return false
  }
}

/** 递归收集目录下的可扫描文件（跳过 node_modules / .git / dist 等非产物目录）。 */
function collectFiles(dir: string, out: string[]): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'dist-main') continue
      // venv/缓存目录（2026-10-05 迁移批+误报根治）：名字集吸收 Proma-Easy（venv/env/
      // .tox/.mypy_cache/.pytest_cache/.gradle）+ pyvenv.cfg 标记法兑底异名 venv；
      // 第三方依赖代码不进产物扫描（性能+误报面），供应链扫描深化挂账，当前口径=只扫自产源码
      if (['.venv', 'venv', 'env', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox', '.gradle'].includes(entry.name)) continue
      const childDir = join(dir, entry.name)
      if (isVenvDirectory(childDir)) continue
      collectFiles(childDir, out)
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.')
      if (dot >= 0 && SCAN_EXTENSIONS.has(entry.name.slice(dot).toLowerCase())) out.push(join(dir, entry.name))
    }
  }
}

export function runSecurityScan(input: SecurityScanInput): SecurityScanResult {
  const files: string[] = []
  collectFiles(input.root_path, files)

  const issues: SecurityIssue[] = []
  for (const file of files) {
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lines = content.split('\n')
    // W5：serverOnly 规则只在产物服务器代码上生效（server.js 与 server/ 子树）
    const rel = relative(input.root_path, file).replace(/\\/g, '/')
    const isServerFile = rel === 'server.js' || rel.startsWith('server/')
    const isPyFile = rel.endsWith('.py')
    if (input.profile === 'local-software' && /\.(?:[cm]?js|[jt]sx?)$/i.test(rel)) issues.push(...softwareProcessIssues(content, rel))
    const pythonCode = isPyFile ? maskPythonStringsAndComments(content).split('\n') : []
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      for (const rule of SCAN_RULES) {
        if (input.profile === 'local-software' && rule.serverOnly) continue
        if (input.profile === 'local-software' && rule.nonPyOnly && /\.(?:[cm]?js|[jt]sx?)$/i.test(rel)) continue // syntax-aware software execution checks above
        if (rule.serverOnly && !isServerFile) continue
        if (rule.pyOnly && !isPyFile) continue
        if (rule.nonPyOnly && isPyFile) continue
        // Execution rules inspect Python code, not docstrings/comments or
        // quoted examples. Sensitive literal values retain their own rules.
        const candidate = isPyFile && rule.category === 'dangerous_execution'
          ? pythonCode[index].replace(/\bdef\s+(?:eval|exec)(?=\s*\()/g, 'def callable') : line
        if (rule.pattern.test(candidate)) {
          issues.push({
            severity: input.profile === 'local-software' && rule.category === 'external_resource' ? 'medium' : rule.severity,
            category: rule.category,
            user_visible_summary: input.profile === 'local-software' && rule.category === 'external_resource' ? '代码动态加载资源，请核对来源和离线需求；联网能力本身不阻断本机软件交付' : rule.summary,
            file: rel,
            line: index + 1,
          })
          break
        }
      }
    }
  }

  // 只有 high / critical 才阻断（PRD §8.1「OWASP 无高危漏洞」）；low/medium 只记录不改阻断。
  const passed = !issues.some((issue) => issue.severity === 'high' || issue.severity === 'critical')
  return { passed, issues, scanned_files: files.length }
}

/** Preserve newlines for evidence locations; this is lexical masking, not a
 * claim of full Python security analysis. */
function maskPythonStringsAndComments(source: string): string {
  return source.replace(/(?:'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\[\s\S]|[^'\\\n])*'|"(?:\\[\s\S]|[^"\\\n])*"|#[^\n]*)/g,
    (token) => token.replace(/[^\n]/g, ' '))
}

const SEVERITY_LABEL: Record<SecuritySeverity, string> = {
  critical: '严重',
  high: '高危',
  medium: '中危',
  low: '低危',
}

/** 渲染安全扫描报告（写 documents/security-scan.md，随文档面板可见）。 */
export function renderSecurityScanMarkdown(result: SecurityScanResult): string {
  const header = `# 安全扫描报告

> 状态：${result.passed ? '通过（无高危/严重问题）' : '未通过（存在高危/严重问题）'}
> 扫描文件数：${result.scanned_files}

## 结论

${result.passed ? '产物未发现高危或严重的安全问题。' : '产物存在高危或严重的安全问题，已进入自动修复流程。'}

## 问题清单

`
  const body =
    result.issues.length === 0
      ? '- 未发现问题\n'
      : result.issues
          .map((issue) => `- [${SEVERITY_LABEL[issue.severity]}] ${issue.file}:${issue.line} — ${issue.user_visible_summary}`)
          .join('\n')
  return `${header}${body}\n`
}
