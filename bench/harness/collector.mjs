/**
 * bench 离线采集器（P0a，2026-09-09）。
 *
 * 只读采集平台已落盘证据，供离线基准 scan 与 seed 抽取使用。
 * 数据源见 bench/README.md「数据源映射」。零外部依赖；ESM。
 *
 * 纪律：
 *  - 只读，绝不写 ~/.proma；
 *  - 会话抽取仅取 user 需求轮与 decision-card 澄清选项，不含系统提示/工具载荷；
 *  - 路径常量可用 BLOMA_PROMA_HOME 覆盖（默认 ~/.proma）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const WORKSPACE_SLUG = 'default-software-builder'

export function findProjHome() {
  return process.env.BLOMA_PROMA_HOME || join(homedir(), '.proma')
}

export const paths = (home = findProjHome()) => ({
  home,
  workspace: join(home, 'agent-workspaces', WORKSPACE_SLUG),
  sessions: join(home, 'agent-sessions'),
  projectsJson: join(home, 'projects.json'),
})

function readJsonLines(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l) } catch { return null }
    })
    .filter(Boolean)
}

/** projects.json → [{id,name,stage,created}] */
export function readProjectIndex(home = findProjHome()) {
  const file = paths(home).projectsJson
  if (!existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return (Array.isArray(raw) ? raw : raw.projects || []).map((p) => ({
      id: String(p.project_id || p.id || ''),
      name: p.name || p.title || '',
      stage: p.current_stage || p.stage || '',
      created: p.created_at || p.createdAt || '',
    })).filter((p) => p.id)
  } catch { return [] }
}

/** 找 project 的主 session id：优先 events/<pid>.jsonl 的 sketch_decision/session_id，回退 analytics 索引。 */
export function findSessionId(projectId, analyticsByProject = new Map(), home = findProjHome()) {
  const { workspace, sessions } = paths(home)
  const eventsFile = join(workspace, 'events', `${projectId}.jsonl`)
  for (const e of readJsonLines(eventsFile)) {
    if (e.session_id) return e.session_id
    if (e.payload?.session_id) return e.payload.session_id
  }
  const fromAnalytics = analyticsByProject.get(projectId)
  if (fromAnalytics?.length) return fromAnalytics[0].session_id
  // 最后回退：agent-sessions 索引文件名猜测不可靠，只列出存在会话供人工指定
  void sessions
  return null
}

/** agent-sessions/<sid>.jsonl → 会话摘要（user 文本 + decision-card 选项 + assistant 澄清）。 */
export function collectSession(sessionId, home = findProjHome()) {
  const file = join(paths(home).sessions, `${sessionId}.jsonl`)
  const out = { sessionId, userMessages: [], decisionCards: [], assistantLines: [] }
  if (!sessionId || !existsSync(file)) return out
  for (const e of readJsonLines(file)) {
    const role = e.role || ''
    const content = Array.isArray(e.content) ? e.content : []
    const text = content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('\n')
    if (role === 'user') {
      // 跳过内部/决策合成轮与平台注入轮（如「目标：实现…输出完成总结」的 loop 任务指令、
      // <session-recall> 跨会话检索注入、<current_stage> 状态段），只留真实用户输入
      const synthetic =
        text.startsWith('[') ||
        text.startsWith('<') ||
        text.startsWith('## ') ||
        /^目标：实现「/.test(text) ||
        text.includes('按系统提示里的项目锚') ||
        text.includes('run_gwt_tests')
      if (text.trim() && !synthetic) {
        out.userMessages.push({ text, timestamp: e.timestamp || 0 })
      }
    } else if (role === 'assistant') {
      const dcs = content
        .map((c) => (c?.type === 'text' && typeof c.text === 'string' && c.text.startsWith('[decision-card]') ? c.text : null))
        .filter(Boolean)
      out.decisionCards.push(...dcs)
      if (text && !text.startsWith('[')) out.assistantLines.push(text.slice(0, 300))
    } else if (role === 'system') {
      // 澄清卡片通常以 system 轮落盘：[decision-card] 裸文本 或 [decision] JSON 内 detail.options
      const dcs = content
        .map((c) => (c?.type === 'text' && typeof c.text === 'string' && c.text.startsWith('[decision-card]') ? c.text : null))
        .filter(Boolean)
      out.decisionCards.push(...dcs)
      for (const c of content) {
        const t = c?.type === 'text' && typeof c.text === 'string' ? c.text : ''
        if (!t.startsWith('[decision]')) continue
        try {
          const inner = JSON.parse(t.slice('[decision]'.length))
          const detail = inner.detail || {}
          if (Array.isArray(detail.options)) out.decisionCards.push(`[decision-card] ${inner.title || ''}｜选项：${detail.options.join('｜')}`)
        } catch { /* 非 JSON 决策行跳过 */ }
      }
    }
  }
  return out
}

/** documents/<pid>/ → PRD/测试/文档证据。 */
export function collectDocuments(projectId, home = findProjHome()) {
  const dir = join(paths(home).workspace, 'documents', projectId)
  const ev = { projectId, hasDocsDir: existsSync(dir), prd: null, testReport: null, docs: {} }
  if (!ev.hasDocsDir) return ev
  for (const name of readdirSync(dir)) ev.docs[name] = true
  const prdFile = join(dir, 'prd.json')
  if (existsSync(prdFile)) {
    try {
      const prd = JSON.parse(readFileSync(prdFile, 'utf8'))
      ev.prd = {
        name: prd.name || '',
        positioning: String(prd.positioning || '').slice(0, 200),
        requirementCount: (prd.requirements || []).length,
        requirements: (prd.requirements || []).map((r) => ({
          id: r.id,
          description: String(r.description || '').slice(0, 160),
          priority: r.priority || '',
        })),
        hasInterfaceSpec: !!prd.interface_spec,
        interfaceSpecCount: Array.isArray(prd.interface_spec?.endpoints || prd.interface_spec) ? (prd.interface_spec.endpoints || prd.interface_spec).length : null,
        hasAcceptance: !!prd.acceptance,
        hasGdd: !!prd.gdd,
        userConfirmed: !!prd.user_confirmed_at,
      }
    } catch { ev.prd = { parseError: true } }
  }
  const trFile = join(dir, 'test-report.json')
  if (existsSync(trFile)) {
    try {
      const tr = JSON.parse(readFileSync(trFile, 'utf8'))
      // 实测 schema：{total_count, passed_count, failed_count, failure_summary}
      ev.testReport = {
        total: tr.total_count ?? tr.total ?? tr.summary?.total ?? null,
        failed: tr.failed_count ?? tr.failed ?? tr.summary?.failed ?? null,
        passed: tr.passed_count ?? tr.passed ?? tr.summary?.passed ?? null,
        failureSummary: Array.isArray(tr.failure_summary) ? tr.failure_summary.map((f) => (typeof f === 'string' ? f : JSON.stringify(f)).slice(0, 160)) : null,
        rawKeys: Object.keys(tr).slice(0, 12),
      }
    } catch { ev.testReport = { parseError: true } }
  }
  return ev
}

/** 聚合 analytics.jsonl 中某项目的 loop 事件（在 scan 层一次读入后传入子集更高效）。 */
export function summarizeAnalytics(events, projectId) {
  const verdicts = events.filter((e) => e.event_type === 'judge_verdict')
  const testCompleted = events.filter((e) => e.event_type === 'test_completed')
  const lastTest = testCompleted[testCompleted.length - 1]
  const loopCompleted = events.filter((e) => e.event_type === 'agent_loop_completed')
  const repairs = events.filter((e) => e.event_type === 'self_repair_triggered' || e.event_type === 'repair_round_completed')
  const judge = events.filter((e) => e.event_type === 'judge_verdict' || String(e.event_type || '').includes('judge'))
  const gwtRuns = loopCompleted.reduce((s, e) => s + (e.payload?.tool_distribution?.run_gwt_tests || 0), 0)
  const loopTurns = events.filter((e) => e.event_type === 'agent_loop_turn')
  const lastLoop = loopCompleted[loopCompleted.length - 1]
  return {
    projectId,
    loopCompletedCount: loopCompleted.length,
    lastLoopStatus: lastLoop?.payload?.status || null,
    lastLoopTurns: lastLoop?.payload?.turns ?? null,
    totalToolCalls: lastLoop?.payload?.total_tool_calls ?? null,
    durationMs: lastLoop?.payload?.duration_ms ?? null,
    repairRounds: repairs.filter((e) => e.event_type === 'repair_round_completed').length,
    repairAttempts: repairs.filter((e) => e.event_type === 'self_repair_triggered').length,
    judgeEvents: judge.length,
    judgePass: verdicts.filter((e) => e.payload?.verdict === 'pass').length,
    judgeFail: verdicts.filter((e) => e.payload?.verdict !== 'pass').length,
    gwtRuns,
    testCompletedRounds: testCompleted.map((e) => e.payload?.round || '?'),
    testCompleted: lastTest
      ? {
          round: lastTest.payload?.round || null,
          total: lastTest.payload?.total_count ?? null,
          failed: lastTest.payload?.failed_count ?? null,
          failures: Array.isArray(lastTest.payload?.failures) ? lastTest.payload.failures.slice(0, 10) : [],
        }
      : null,
    mvpDelivered: events.some((e) => e.event_type === 'mvp_delivered'),
    turnTokens: loopTurns.map((e) => ({ turns: e.payload?.turn, in: e.payload?.input_tokens, out: e.payload?.output_tokens })),
    inputTokensTotal: loopTurns.reduce((s, e) => s + (Number(e.payload?.input_tokens) || 0), 0),
    outputTokensTotal: loopTurns.reduce((s, e) => s + (Number(e.payload?.output_tokens) || 0), 0),
  }
}

/** 产物源码特征扫描（P0 指标扩容：首次约束违规/核心能力保留的确定性口径）。
 *  只读产物目录（root_path），文本文件限 512KB/目录总量 8MB，返回命中特征计数而非原文。 */
export function collectArtifacts(projectRoot) {
  const out = { root: projectRoot, files: 0, bytes: 0, hits: {
    localStorage: 0, serverRoutes: 0, apiLlm: 0, aiMock: 0, secretPattern: 0,
  }, sourceSample: '' }
  if (!projectRoot || !existsSync(projectRoot)) return out
  const TEXT_EXT = /\.(js|mjs|cjs|html|css|json|md)$/i
  let budget = 8 * 1024 * 1024
  const patterns = [
    ['localStorage', /localStorage\.(get|set|remove)Item|window\.localStorage/g],
    ['serverRoutes', /server\/routes|\/api\/[a-z][\w-]*/g],
    ['apiLlm', /\/api\/llm|BLOMA_APP_LLM/g],
    ['aiMock', /\?mock=1|mock:\s*true|模拟\s*AI|模拟智能/g],
    ['secretPattern', /sk-[A-Za-z0-9]{16,}|api[_-]?key\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"]/gi],
  ]
  const walk = (dir) => {
    if (budget <= 0) return
    for (const name of readdirSync(dir)) {
      if (budget <= 0) return
      if (name === 'node_modules' || name === '.git' || name === 'dist') continue
      const abs = join(dir, name)
      const st = statSync(abs)
      if (st.isDirectory()) { walk(abs); continue }
      if (!TEXT_EXT.test(name) || st.size > 512 * 1024) continue
      out.files += 1
      out.bytes += st.size
      budget -= st.size
      const text = readFileSync(abs, 'utf8')
      for (const [key, re] of patterns) {
        const m = text.match(re)
        if (m) out.hits[key] += m.length
      }
      if (out.sourceSample.length < 4000 && /\.(js|html)$/.test(name)) {
        out.sourceSample += `
/* ${name} */
` + text.slice(0, 1200)
      }
    }
  }
  try { walk(projectRoot) } catch { /* 产物目录读取异常不阻断采集 */ }
  out.sourceSample = out.sourceSample.slice(0, 4000)
  return out
}

/** 助手轮完整性扫描（P0 指标扩容：协议泄漏率/空正文率的确定性口径）。
 *  - protocolLeak：正文含工具调用协议原文/内部标记（<tool_calls> 字面、DSML 竖线标记、裸 JSON 工具协议块）
 *  - emptyText：无任何 text 块且无 tool_use（思考耗尽/空响应特征；纯工具轮不算）
 *  与 learnings 脏数据过滤（8ebee31）、output-integrity（7d93f1e）的检测词表同源。 */
export function collectAssistantIntegrity(sessionId, home = findProjHome()) {
  const file = join(paths(home).sessions, `${sessionId}.jsonl`)
  const out = { sessionId, assistantTurns: 0, protocolLeakTurns: 0, emptyTextTurns: 0, degenerateTurns: 0, leakSamples: [] }
  if (!sessionId || !existsSync(file)) return out
  for (const e of readJsonLines(file)) {
    if (e.role !== 'assistant') continue
    out.assistantTurns += 1
    const blocks = Array.isArray(e.content) ? e.content : []
    const texts = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text)
    const hasToolUse = blocks.some((b) => b?.type === 'tool_use')
    const joined = texts.join('')
    if (/<![a-z_]*tool[_ ]?call|<｜|tool_use\s*:\s*\{|"name"\s*:\s*"write_file"\s*,\s*"input"/.test(joined)) {
      out.protocolLeakTurns += 1
      if (out.leakSamples.length < 3) out.leakSamples.push(joined.slice(0, 160))
    }
    if (!joined.trim() && !hasToolUse) out.emptyTextTurns += 1
    // 退行重复（stream-collapse 同源特征：单元 ≤8 字符连续重复 ≥8 次）
    const unit = joined.length > 0 ? joined.slice(0, 8) : ''
    if (unit && unit.repeat(8).length <= joined.length && joined.split(unit).length > 9) out.degenerateTurns += 1
  }
  return out
}
