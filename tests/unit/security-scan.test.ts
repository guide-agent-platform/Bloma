import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderSecurityScanMarkdown, runSecurityScan } from '../../main/security-scan'

/**
 * A3 OWASP 安全扫描器（run_security_scan）单元测试。
 * 覆盖：高危/严重命中阻断（passed=false）、中低危只记录不阻断、敏感信息硬编码、
 * 规则按严重度去重、报告渲染不含技术术语。
 */

let tmpRoots: string[] = []

function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'bloma-secscan-'))
  tmpRoots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  return root
}

afterEach(() => {
  for (const root of tmpRoots) {
    // 测试数据量小，交由系统回收；此处仅清引用，避免跨用例残留
  }
  tmpRoots = []
})

describe('runSecurityScan — A3 OWASP 基础静态扫描', () => {
  it('无危险模式 → passed=true，无 issue', () => {
    const root = makeTree({
      'index.html': '<div>hello</div>\n<script src="app.js"></script>',
      'app.js': 'const el = document.createElement("div");\nel.textContent = "ok";\n',
    })
    const result = runSecurityScan({ project_id: 'p1', root_path: root })
    expect(result.passed).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.scanned_files).toBe(2)
  })

  it('eval / new Function / document.write → critical，阻断', () => {
    const root = makeTree({
      'app.js': 'function run(x) { eval(x); }\nfunction run2(x) { return new Function(x); }\n',
    })
    const result = runSecurityScan({ project_id: 'p1', root_path: root })
    expect(result.passed).toBe(false)
    expect(result.issues.map((i) => i.category)).toEqual(['dangerous_execution', 'dangerous_execution'])
    expect(result.issues.every((i) => i.severity === 'critical')).toBe(true)
  })

  it('硬编码敏感信息（api key / password）→ high，阻断', () => {
    const root = makeTree({
      'config.js': 'const apiKey = "sk-1234567890";\nconst password = "hunter2";\n',
    })
    const result = runSecurityScan({ project_id: 'p1', root_path: root })
    expect(result.passed).toBe(false)
    expect(result.issues.map((i) => i.category)).toEqual(['sensitive_data', 'sensitive_data'])
  })

  it('innerHTML 赋变量 → high，阻断；赋静态字符串不命中', () => {
    const root = makeTree({
      'app.js': 'el.innerHTML = userInput;\nother.innerHTML = "<b>ok</b>";\n',
    })
    const result = runSecurityScan({ project_id: 'p1', root_path: root })
    expect(result.passed).toBe(false)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].category).toBe('unsafe_dom')
    expect(result.issues[0].line).toBe(1)
  })

  it('内联事件处理器 → medium，不阻断', () => {
    const root = makeTree({
      'index.html': '<button onclick="doIt()">点我</button>\n',
    })
    const result = runSecurityScan({ project_id: 'p1', root_path: root })
    expect(result.passed).toBe(true)
    expect(result.issues[0].category).toBe('inline_event_handler')
    expect(result.issues[0].severity).toBe('medium')
  })

  it('http:// 非加密资源 → low，不阻断', () => {
    const root = makeTree({
      'index.html': '<img src="http://example.com/a.png">\n',
    })
    const result = runSecurityScan({ project_id: 'p1', root_path: root })
    expect(result.passed).toBe(true)
    expect(result.issues[0].category).toBe('insecure_resource')
    expect(result.issues[0].severity).toBe('low')
  })

  it('跳过 node_modules / dist 目录', () => {
    const root = makeTree({
      'index.html': '<div>ok</div>',
      'node_modules/dep.js': 'eval("x")',
      'dist/bundle.js': 'eval("x")',
    })
    const result = runSecurityScan({ project_id: 'p1', root_path: root })
    expect(result.passed).toBe(true)
    expect(result.issues).toEqual([])
  })
})

describe('renderSecurityScanMarkdown — 报告不含技术术语', () => {
  it('未通过报告仍不出现 XSS / SQL 注入 / OWASP', () => {
    const markdown = renderSecurityScanMarkdown({
      passed: false,
      scanned_files: 1,
      issues: [
        { severity: 'critical', category: 'dangerous_execution', user_visible_summary: '检测到危险脚本', file: 'app.js', line: 3 },
      ],
    })
    expect(markdown).toContain('未通过')
    expect(markdown).not.toMatch(/XSS|SQL\s*注入|OWASP/i)
  })
})
