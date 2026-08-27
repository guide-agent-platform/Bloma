import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * A3 OWASP 安全扫描器（api-spec §12.9 `run_security_scan`）。
 *
 * 对生成的产物（HTML / JS / CSS）做确定性的 OWASP Top 10 基础静态扫描，检测：
 * - 动态代码执行（eval / new Function / document.write）—— XSS 高危向量；
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
}

interface ScanRule {
  category: SecurityIssueCategory
  severity: SecuritySeverity
  pattern: RegExp
  summary: string
}

/** 扫描规则：按严重度从高到低排列，同一行命中首个规则即止（避免重复上报）。 */
const SCAN_RULES: ScanRule[] = [
  {
    category: 'dangerous_execution',
    severity: 'critical',
    pattern: /\beval\s*\(|new\s+Function\s*\(|document\.write(?:ln)?\s*\(/,
    summary: '检测到一段可被外部内容改变行为的脚本，建议改写成更安全的实现方式',
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
]

/** 参与扫描的产物扩展名（生成 MVP 的静态前端产物）。 */
const SCAN_EXTENSIONS = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.css'])

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
      collectFiles(join(dir, entry.name), out)
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
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      for (const rule of SCAN_RULES) {
        if (rule.pattern.test(line)) {
          issues.push({
            severity: rule.severity,
            category: rule.category,
            user_visible_summary: rule.summary,
            file: relative(input.root_path, file).replace(/\\/g, '/'),
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
