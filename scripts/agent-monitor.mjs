#!/usr/bin/env node
/**
 * agent-monitor.mjs — Agent 活动状态监视
 *
 * 读取 proma 的 agent-sessions.json，汇总所有 Agent / 协作子 Agent 的活动状态：
 * 角色（Attacker/Defender/Reviewer/explore/implement...）、模型、状态、耗时、
 * 父会话关联、自动化/委派来源。输出可读 Markdown 报告（stdout 或 --out 文件）。
 *
 * 用法：
 *   node scripts/agent-monitor.mjs                 # 输出全部会话汇总（Markdown）
 *   node scripts/agent-monitor.mjs --active        # 只显示活跃/未完成会话
 *   node scripts/agent-monitor.mjs --role attacker  # 只显示某角色
 *   node scripts/agent-monitor.mjs --json          # JSON 格式输出
 *   node scripts/agent-monitor.mjs --out report.md # 写文件
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const SESSIONS_PATH = process.env.AGENT_SESSIONS_PATH || join(os.homedir(), '.proma', 'agent-sessions.json')
const ROLE_LABELS = {
  attacker: '🔴 Attacker（攻击）',
  defender: '🟢 Defender（辩护）',
  reviewer: '🟡 Reviewer（裁决）',
  explore: '🔍 explore（探索）',
  research: '📚 research（调研）',
  implement: '🛠 implement（实现）',
  review: '🔎 review（审查）',
  custom: '⚙️ custom（自定义）',
  delegation: '🤝 委派',
  '主会话': '💬 主会话',
}

function loadSessions() {
  if (!existsSync(SESSIONS_PATH)) throw new Error(`会话索引不存在: ${SESSIONS_PATH}`)
  const d = JSON.parse(readFileSync(SESSIONS_PATH, 'utf-8'))
  let sessions = Array.isArray(d) ? d : d.sessions || d
  if (sessions && !Array.isArray(sessions) && Array.isArray(sessions.sessions)) sessions = sessions.sessions
  return Array.isArray(sessions) ? sessions : []
}

function roleOf(s) {
  const r = s.delegationRole || s.role || ''
  if (!r) return '主会话'
  if (r === 'custom' && (s.title || '').toLowerCase().includes('attacker')) return 'attacker'
  if (r === 'custom' && (s.title || '').toLowerCase().includes('defender')) return 'defender'
  if (r === 'custom' && (s.title || '').toLowerCase().includes('reviewer')) return 'reviewer'
  return r
}

function statusOf(s) {
  if (s.delegationStatus) return s.delegationStatus
  if (s.status) return s.status
  return 'unknown'
}

function durationMs(s) {
  const start = Number(s.createdAt || 0)
  const end = Number(s.updatedAt || 0)
  if (start && end && end >= start) return end - start
  return undefined
}

function fmtDuration(ms) {
  if (ms === undefined) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60000)
  const sec = Math.round((ms % 60000) / 1000)
  return `${m}m${sec}s`
}

function fmtTime(ts) {
  if (!ts) return '—'
  const d = new Date(Number(ts))
  if (Number.isNaN(d.getTime())) return String(ts)
  return d.toLocaleString('zh-CN', { hour12: false })
}

function buildReport(sessions, { activeOnly, roleFilter }) {
  const lines = []
  lines.push('# Agent 活动状态监视')
  lines.push('')
  lines.push(`> 生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`)
  lines.push(`> 数据源：${SESSIONS_PATH}`)
  lines.push('')

  // 统计
  const filtered = sessions.filter((s) => {
    if (activeOnly) {
      const st = statusOf(s)
      if (!['active', 'running', 'pending', 'queued'].includes(st)) return false
    }
    if (roleFilter) return roleOf(s) === roleFilter
    return true
  })

  lines.push(`## 总览（${filtered.length}/${sessions.length} 会话）`)
  lines.push('')
  lines.push('| 角色 | 数量 | 活跃 | 完成 |')
  lines.push('|---|---|---|---|')
  const byRole = {}
  for (const s of filtered) {
    const r = roleOf(s)
    byRole[r] = byRole[r] || { total: 0, active: 0, done: 0 }
    byRole[r].total++
    const st = statusOf(s)
    if (['active', 'running', 'pending', 'queued'].includes(st)) byRole[r].active++
    else if (['completed', 'success', 'done'].includes(st)) byRole[r].done++
  }
  for (const [r, c] of Object.entries(byRole).sort((a, b) => b[1].total - a[1].total)) {
    lines.push(`| ${ROLE_LABELS[r] || r} | ${c.total} | ${c.active} | ${c.done} |`)
  }
  lines.push('')

  // 详细列表（最近 20 个）
  const recent = [...filtered].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)).slice(0, 20)
  lines.push(`## 最近 ${recent.length} 个会话`)
  lines.push('')
  lines.push('| 时间 | 角色 | 模型 | 状态 | 耗时 | 标题 |')
  lines.push('|---|---|---|---|---|---|')
  for (const s of recent) {
    const r = roleOf(s)
    const st = statusOf(s)
    const emoji = ['active', 'running'].includes(st) ? '🟢' : ['completed', 'success', 'done'].includes(st) ? '✅' : st === 'cancelled' ? '⛔' : '⚪'
    lines.push(`| ${fmtTime(s.updatedAt)} | ${ROLE_LABELS[r] || r} | ${s.modelId || '—'} | ${emoji} ${st} | ${fmtDuration(durationMs(s))} | ${String(s.title || '').slice(0, 40)} |`)
  }
  lines.push('')

  // 关联信息
  const delegations = filtered.filter((s) => s.sourceDelegationId || s.sourceAutomationId)
  if (delegations.length) {
    lines.push(`## 委派/自动化来源（${delegations.length} 个）`)
    lines.push('')
    for (const s of delegations.slice(0, 10)) {
      lines.push(`- **${s.title || roleOf(s)}**：delegation=${String(s.sourceDelegationId || '—').slice(0, 8)}，automation=${String(s.sourceAutomationId || '—').slice(0, 8)}，状态=${statusOf(s)}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

function main() {
  const args = process.argv.slice(2)
  const activeOnly = args.includes('--active')
  const jsonOut = args.includes('--json')
  const roleFilter = (() => {
    const i = args.indexOf('--role')
    return i >= 0 ? args[i + 1] : undefined
  })()
  const out = (() => {
    const i = args.indexOf('--out')
    return i >= 0 ? args[i + 1] : undefined
  })()

  try {
    const sessions = loadSessions()
    if (jsonOut) {
      const filtered = sessions.filter((s) => {
        if (activeOnly && !['active', 'running', 'pending', 'queued'].includes(statusOf(s))) return false
        if (roleFilter && roleOf(s) !== roleFilter) return false
        return true
      })
      const payload = { generatedAt: new Date().toISOString(), total: sessions.length, filtered: filtered.length, sessions: filtered }
      const text = JSON.stringify(payload, null, 2)
      if (out) writeFileSync(out, text, 'utf-8')
      console.log(text)
      return
    }
    const report = buildReport(sessions, { activeOnly, roleFilter })
    if (out) writeFileSync(out, report, 'utf-8')
    console.log(report)
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }, null, 2))
    process.exit(1)
  }
}

main()
