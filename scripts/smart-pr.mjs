#!/usr/bin/env node
/**
 * smart-pr.mjs — 智能提 PR（测试审查迭代之后自动提交推送建 PR）
 *
 * 流程（仅当质量门已通过时由调用方触发）：
 *  1. 收集改动：git status --short，按类型分类（代码改动 vs 工具脚本 vs 文档）
 *  2. 生成 commit message（遵循 Bloma 规范：feat/fix/test + 功能域 +（TDD））
 *  3. git add + commit（只提交允许的文件；默认排除 docs/03_ARCHITECTURE/pseudocode/ 等受保护项）
 *  4. git push 到当前分支
 *  5. 用 GitHub API 创建 PR（凭据从 git credential manager 读取，无需 gh CLI）
 *
 * 用法：
 *   node scripts/smart-pr.mjs --title "<PR 标题>" --body "<PR 描述文件>" [--base main] [--dry-run]
 *   node scripts/smart-pr.mjs --title "feat(sketch): 新增 xxx（TDD）" --body pr-body.md
 *
 * 安全边界：
 *  - 默认只提交 main/ renderer/ shared/ 下已跟踪文件的改动 + 新增测试（*.test.*）
 *  - 不提交：docs/ 原件、docs/03_ARCHITECTURE/pseudocode/、scripts/ 下工具脚本（除非 --include-tools）
 *  - 不 force push、不切换分支；失败即报错退出，不做部分提交
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const REPO = process.env.BLOMA_ROOT || process.cwd()
const EXCLUDE_PATTERNS = [
  'docs/03_ARCHITECTURE/pseudocode/',
  'undefined/',
  '*.log',
]
const TOOLS_GLOBS = ['scripts/multi-vendor-run.mjs', 'scripts/vision-diagnose.mjs', 'scripts/channel-key-reader.cjs', 'scripts/bloma-vision-mcp.cjs', 'scripts/_screenshot-worker.cjs', 'scripts/smart-pr.mjs']

function run(args, opts = {}) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf-8', windowsHide: true, ...opts }).trim()
}

function parseArgs(argv) {
  const args = { title: undefined, body: undefined, base: 'main', dryRun: false, includeTools: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--title') args.title = argv[++i]
    else if (a === '--body') args.body = argv[++i]
    else if (a === '--base') args.base = argv[++i]
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--include-tools') args.includeTools = true
  }
  return args
}

function isExcluded(file) {
  return EXCLUDE_PATTERNS.some((p) => file.startsWith(p) || file.endsWith(p.replace(/\/$/, '')))
}

function classifyChanges() {
  const status = run(['status', '--short']).split('\n').filter(Boolean)
  const codeChanges = []
  const toolChanges = []
  const excluded = []
  for (const line of status) {
    const file = line.slice(3).trim()
    if (isExcluded(file)) { excluded.push(file); continue }
    if (TOOLS_GLOBS.some((g) => file === g)) { toolChanges.push(file); continue }
    codeChanges.push(file)
  }
  return { codeChanges, toolChanges, excluded }
}

function collectFiles(changes, includeTools) {
  const files = [...changes.codeChanges]
  if (includeTools) files.push(...changes.toolChanges)
  return files
}

function currentBranch() {
  return run(['rev-parse', '--abbrev-ref', 'HEAD'])
}

async function getGitHubCredential() {
  const input = 'protocol=https\nhost=github.com\n\n'
  const out = execFileSync('git', ['credential', 'fill'], { cwd: REPO, input, encoding: 'utf-8', windowsHide: true })
  const lines = out.split('\n').filter(Boolean)
  const cred = {}
  for (const l of lines) {
    const [k, ...v] = l.split('=')
    if (k) cred[k] = v.join('=')
  }
  if (!cred.password) throw new Error('无法从 git credential manager 获取 GitHub 凭据')
  return cred
}

async function createPrViaApi({ title, body, head, base, dryRun }) {
  const cred = await getGitHubCredential()
  const repo = 'guide-agent-platform/Bloma'
  const payload = { title, head, base, body }
  if (dryRun) {
    return { ok: true, dryRun: true, repo, payload }
  }
  const resp = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cred.password}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`GitHub API ${resp.status}: ${text.slice(0, 300)}`)
  }
  const json = await resp.json()
  return { ok: true, url: json.html_url, number: json.number }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.title) {
    console.error('用法: node scripts/smart-pr.mjs --title "<PR 标题>" --body <描述文件> [--base main] [--dry-run] [--include-tools]')
    process.exit(1)
  }
  const branch = currentBranch()
  console.log('[smart-pr] 当前分支:', branch)
  console.log('[smart-pr] dry-run:', args.dryRun)

  const changes = classifyChanges()
  console.log('[smart-pr] 代码改动:', changes.codeChanges.length, '项')
  console.log('[smart-pr] 工具脚本:', changes.toolChanges.length, '项（', args.includeTools ? '包含' : '排除', '）')
  if (changes.excluded.length) console.log('[smart-pr] 已排除（受保护/忽略）:', changes.excluded.length, '项')

  const files = collectFiles(changes, args.includeTools)
  if (!files.length) {
    console.log('[smart-pr] 没有可提交的改动，跳过')
    process.exit(0)
  }

  const body = args.body && existsSync(args.body) ? readFileSync(args.body, 'utf-8') : (args.body || '')
  if (args.dryRun) {
    console.log('[smart-pr] (dry-run) 将提交文件:')
    for (const f of files) console.log('  +', f)
    console.log('[smart-pr] (dry-run) commit message:', args.title)
    const pr = await createPrViaApi({ title: args.title, body, head: branch, base: args.base, dryRun: true })
    console.log('[smart-pr] (dry-run) PR payload:', JSON.stringify(pr.payload, null, 2))
    return
  }

  run(['add', '--', ...files])
  try {
    run(['commit', '-m', args.title, '-m', body.slice(0, 5000)])
  } catch (e) {
    if (String(e.message).includes('nothing to commit')) {
      console.log('[smart-pr] 无新增改动，跳过 commit')
    } else throw e
  }

  console.log('[smart-pr] push 到 origin:', branch)
  run(['push', 'origin', branch])
  console.log('[smart-pr] push 完成')

  const pr = await createPrViaApi({ title: args.title, body, head: branch, base: args.base, dryRun: false })
  console.log('[smart-pr] PR 已创建:', pr.url || `#${pr.number}`)
  return pr
}

main().catch((e) => {
  console.error('[smart-pr] 失败:', e.message)
  process.exit(1)
})
