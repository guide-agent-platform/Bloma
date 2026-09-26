// agent-collaboration 拆分（R7）：迁出块删除 + import + runChildLoop 改造
const fs = require('fs')
const p = 'main/agent/delegation/agent-collaboration.ts'
const raw = fs.readFileSync(p, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'
let s = raw.replace(/\r\n/g, '\n')

function cut(startMark, endMarkInclusive, label) {
  const i = s.indexOf(startMark)
  if (i < 0) { console.error('CUT start MISS:', label); process.exit(1) }
  const j = s.indexOf(endMarkInclusive, i)
  if (j < 0) { console.error('CUT end MISS:', label); process.exit(1) }
  s = s.slice(0, i) + s.slice(j + endMarkInclusive.length)
  console.log('cut', label)
}

// A. 类型定义块
cut('/** 子运行上下文（P1-06 收尾）：worktree 隔离等由 coding 层实现、agent 层只认接口。 */', '}) => ChildRunContext | undefined', 'child-run-context types')
// B. provider 变量
cut('\nlet childRunContextProvider: ChildRunContextProvider | undefined', '', 'provider var')
// C. setChildRunContextProvider 函数 → re-export
cut('/** 注册子运行上下文提供者（coding 层注入 worktree 隔离；未注册=零变化）。 */', 'export function setChildRunContextProvider(provider: ChildRunContextProvider): void {\n  childRunContextProvider = provider\n}', 'provider setter')
// D. worktreeNoteOf
cut('/** P1-06：worktree 隔离结果如实注记（父会话在结果摘要里可见合并/冲突/丢弃）。 */', "  return `\\n[worktree 隔离] 分支 ${wt.branch} 未并入（${wt.merge_reason ?? '未知原因'}）`\n}", 'worktreeNoteOf')
// E. summarizeChildResult
cut('function summarizeChildResult(result: AgentLoopResult): string {', "  return truncateText(full, DELEGATION_RESULT_CHAR_LIMIT)\n}", 'summarizeChildResult')

// F. import + re-export
const impAnchor = "import { runWithProjectRootOverride } from '../../../shared/project-root-override'"
if (!s.includes(impAnchor)) { console.error('import anchor MISS'); process.exit(1) }
s = s.replace(
  impAnchor,
  [
    "import {",
    "  ISOLATION_NOTE,",
    "  acquireChildRunContext,",
    "  formatWorktreeNote,",
    "  invokeChildLoopWithContext,",
    "  summarizeChildResult,",
    "  type ChildRunContext,",
    "  type ChildRunContextProvider,",
    "} from './child-run-context'",
    "",
    "/** P1-06：子运行上下文接口 re-export（coding 层 worktree 隔离经此注入）。 */",
    "export { setChildRunContextProvider } from './child-run-context'",
  ].join('\n'),
)

// G. runChildLoop 改造（用 acquire + ISOLATION_NOTE + invokeChildLoopWithContext）
const oldRun = [
  "  // P1-06 收尾：子运行上下文（worktree 隔离）；provider 未注册/开关 off → 零变化",
  "  const runContext = childRunContextProvider?.({ projectId: parent.projectId, delegationId: record.delegationId, childSessionId: record.childSessionId, role })",
  "  const isolationNote = runContext?.rootOverride",
  "    ? '\\n\\n【隔离工作模式】你在独立分支的工作树上实现（改动不直接进项目主目录）；本会话不提供预览/测试/安全验证工具——验证由父会话在合并后统一执行，请专注于实现与逻辑自检。'",
  "    : ''",
].join('\n')
if (!s.includes(oldRun)) { console.error('runChildLoop head MISS'); process.exit(1) }
s = s.replace(
  oldRun,
  [
    "  // P1-06 收尾：子运行上下文（worktree 隔离）；provider 未注册/开关 off → 零变化",
    "  const runContext = acquireChildRunContext({ projectId: parent.projectId, delegationId: record.delegationId, childSessionId: record.childSessionId, role })",
    "  const isolationNote = runContext?.rootOverride ? ISOLATION_NOTE : ''",
  ].join('\n'),
)

const oldTail = [
  "  let result: AgentLoopResult",
  "  try {",
  "    result = runContext?.rootOverride ? await runWithProjectRootOverride(runContext.rootOverride, invoke) : await invoke()",
  "  } catch (error) {",
  "    const meta = runContext?.onFinish?.('failed')",
  "    if (meta) record.worktreeMeta = { ...(record.worktreeMeta ?? {}), ...meta }",
  "    throw error",
  "  }",
  "  const outcome = result.status === 'cancelled' ? 'aborted' : 'completed'",
  "  const meta = runContext?.onFinish?.(outcome)",
  "  if (meta) record.worktreeMeta = { ...(record.worktreeMeta ?? {}), ...meta }",
  "  return result",
  "}",
].join('\n')
if (!s.includes(oldTail)) { console.error('runChildLoop tail MISS'); process.exit(1) }
s = s.replace(
  oldTail,
  [
    "  const { result, meta } = await invokeChildLoopWithContext(runContext, invoke)",
    "  if (meta) record.worktreeMeta = { ...(record.worktreeMeta ?? {}), ...meta }",
    "  return result",
    "}",
  ].join('\n'),
)

// H. settle 路径：摘要/注记走新模块；异常路径从 error 上取 meta
s = s.replace(
  "  record.resultSummary = summarizeChildResult(result) + worktreeNoteOf(record)",
  "  record.resultSummary = summarizeChildResult(result, DELEGATION_RESULT_CHAR_LIMIT) + formatWorktreeNote(record.worktreeMeta)",
)
s = s.replace(
  "  record.error = errorMessage(error) + worktreeNoteOf(record)",
  [
    "  const carriedMeta = (error as { childWorktreeMeta?: Record<string, unknown> } | undefined)?.childWorktreeMeta",
    "  if (carriedMeta) record.worktreeMeta = { ...(record.worktreeMeta ?? {}), ...carriedMeta }",
    "  record.error = errorMessage(error) + formatWorktreeNote(record.worktreeMeta)",
  ].join('\n'),
)

fs.writeFileSync(p, s.split('\n').join(eol), 'utf8')
console.log('agent-collaboration refactored; lines =', s.split('\n').length)
