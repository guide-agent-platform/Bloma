// P1-06 收尾重构（依赖倒置 + R7 拆解）：类型下沉 shared、提示词纯函数与包裹逻辑归位
const fs = require('fs')

function readNorm(p) {
  const raw = fs.readFileSync(p, 'utf8')
  return { text: raw.replace(/\r\n/g, '\n'), eol: raw.includes('\r\n') ? '\r\n' : '\n' }
}
function writeNorm(p, text, eol) {
  fs.writeFileSync(p, text.split('\n').join(eol), 'utf8')
}
/** 从 [startMark, 顶层 '\n}') 区间剪切并返回被剪内容（不含结尾 '\n}'） */
function cutFn(text, startMark, label) {
  const i = text.indexOf(startMark)
  if (i < 0) { console.error('CUT start MISS:', label); process.exit(1) }
  const j = text.indexOf('\n}', i)
  if (j < 0) { console.error('CUT end MISS:', label); process.exit(1) }
  return { rest: text.slice(0, i) + text.slice(j + 2), cut: text.slice(i, j) }
}

// ---------- 1. child-run-context.ts：改 import shared、迁入提示词纯函数 ----------
{
  const p = 'main/agent/delegation/child-run-context.ts'
  const { text, eol } = readNorm(p)
  let s = text
  s = s.replace(
    [
      "import type { AgentLoopResult } from '../loop/agent-loop'",
      "import { runWithProjectRootOverride } from '../../../shared/project-root-override'",
      "import type { DelegationRole } from './agent-collaboration'",
    ].join('\n'),
    [
      "import type { AgentLoopResult } from '../loop/agent-loop'",
      "import { runWithProjectRootOverride } from '../../../shared/project-root-override'",
      "import type { ChildRunContext, ChildRunContextProvider, DelegationRunRole } from '../../../shared/delegation-run-context'",
    ].join('\n'),
  )
  // 删本地类型定义（已下沉 shared），改 re-export
  const typeStart = s.indexOf('/** 委派运行上下文：worktree 隔离等由 coding 层实现、agent 层只认接口。 */')
  if (typeStart < 0) { console.error('child types MISS'); process.exit(1) }
  const providerEnd = s.indexOf('}) => ChildRunContext | undefined', typeStart)
  if (providerEnd < 0) { console.error('child provider end MISS'); process.exit(1) }
  s = s.slice(0, typeStart) + '/** 契约类型 re-export（定义在 shared/delegation-run-context：跨层依赖倒置）。 */\nexport type { ChildRunContext, ChildRunContextProvider } from \'../../../shared/delegation-run-context\'' + s.slice(providerEnd + '}) => ChildRunContext | undefined'.length)
  // acquireChildRunContext 的 role 参数类型改 DelegationRunRole
  s = s.replace('  role: DelegationRole\n}): ChildRunContext | undefined {', '  role: DelegationRunRole\n}): ChildRunContext | undefined {')
  // 末尾追加迁入的提示词纯函数
  s += `

// =========================================================================
// 子会话提示词纯函数（自 agent-collaboration 迁入：R7 行数纪律）
// =========================================================================

const ROLE_INSTRUCTIONS: Record<DelegationRunRole, string> = {
  explore: '职责：探索代码库——梳理文件结构、定位相关实现、报告事实性发现。只读操作，不做修改。',
  research: '职责：调研——阅读相关代码与文档，形成结论或对比方案。只读操作，不做修改。',
  implement: '职责：实现——编写/修改项目文件完成子任务。遵循平台工具护栏（路径沙箱、语法校验、可写范围）。',
  review: '职责：审查——阅读代码指出问题（正确性/可维护性/安全隐患），给出文件定位与建议，不直接修改。',
  custom: '职责：按主 agent 在任务里给出的具体指令工作。',
}

/** 子 agent system prompt：父背板 system + role 行为说明 + 委派边界规则。 */
export function buildChildSystemPrompt(parentSystem: string, role: DelegationRunRole): string {
  return \`\${parentSystem}

<delegation_context>
你是主 agent 委派的一名协作子 agent（role=\${role}）。
\${ROLE_INSTRUCTIONS[role]}
边界：
- 只负责完成本任务；完成后用纯文本输出结果摘要，不要输出「我将…」式的过程承诺。
- 你不能再委派其他子 agent（深度限制）；需要额外信息时用现有工具自行获取。
- 不向用户提问；确实受阻时，如实说明阻塞原因并输出当前进展。
</delegation_context>\`
}

export function buildDelegationPrompt(opts: {
  role: DelegationRunRole
  task: string
  expectedOutput?: string
}): string {
  const expected = opts.expectedOutput
    ? \`期望输出：\${opts.expectedOutput}\\n（最终回复请以一行「结论:」开头的标记句总结关键信息——标记句会被上下文压缩保留，格式：结论: <要点>）\`
    : '完成后用简洁文本输出结果摘要（关键发现/完成清单/未完成项与原因）。最终回复以一行「结论:」开头的标记句总结（会被上下文压缩保留）。'
  return \`协作子任务（role=\${opts.role}）：\\n\${opts.task}\\n\\n\${expected}\`
}
`
  writeNorm(p, s, eol)
  console.log('child-run-context updated; lines =', s.split('\n').length)
}

// ---------- 2. agent-collaboration：删迁出块 + re-export + import 调整 ----------
{
  const p = 'main/agent/delegation/agent-collaboration.ts'
  const { text, eol } = readNorm(p)
  let s = text
  // 2.1 DelegationRole 定义 → 从 shared 引（re-export 保持外部路径）
  const roleDef = "export type DelegationRole = 'explore' | 'research' | 'implement' | 'review' | 'custom'"
  if (!s.includes(roleDef)) { console.error('DelegationRole def MISS'); process.exit(1) }
  s = s.replace(roleDef, "export type { DelegationRunRole as DelegationRole } from '../../../shared/delegation-run-context'")
  // 2.2 删 ROLE_INSTRUCTIONS + buildChildSystemPrompt（cutFn）
  {
    const r = cutFn(s, 'const ROLE_INSTRUCTIONS: Record<DelegationRole, string> = {', 'ROLE_INSTRUCTIONS')
    s = r.rest
  }
  {
    const r = cutFn(s, '/** 子 agent system prompt：父背板 system + role 行为说明 + 委派边界规则。 */\nexport function buildChildSystemPrompt(', 'buildChildSystemPrompt')
    s = r.rest
  }
  {
    const r = cutFn(s, 'export function buildDelegationPrompt(opts: {', 'buildDelegationPrompt')
    s = r.rest
  }
  // 2.3 re-export 提示词纯函数（测试 import 路径零改动）
  s = s.replace(
    "/** P1-06：子运行上下文接口 re-export（coding 层 worktree 隔离经此注入）。 */\nexport { setChildRunContextProvider } from './child-run-context'",
    [
      "/** P1-06：子运行上下文接口 re-export（coding 层 worktree 隔离经此注入）。 */",
      "export { setChildRunContextProvider } from './child-run-context'",
      "/** 提示词纯函数 re-export（R7 拆出后保持既有 import 路径）。 */",
      "export { buildChildSystemPrompt, buildDelegationPrompt } from './child-run-context'",
    ].join('\n'),
  )
  // 2.4 import 提示词纯函数（内部使用）
  s = s.replace(
    "} from './child-run-context'",
    [
      "  buildChildSystemPrompt,",
      "  buildDelegationPrompt,",
      "} from './child-run-context'",
    ].join('\n'),
  )
  writeNorm(p, s, eol)
  console.log('agent-collaboration updated; lines =', s.split('\n').length)
}

