#!/usr/bin/env node
/**
 * task-orchestrator.mjs — 经验库持续工作流调度器（事件驱动状态机，2026-09-07 用户终裁）
 *
 * 形态：由 Proma 定时任务每 15 分钟唤醒一次（单次运行 <10s，非守护进程）。
 * 队列：仓库根 tasks.json（运行时状态，gitignore）；审计 ~/.proma/audit-log.jsonl。
 * 任务类型与角色：
 *   run_full_scan / run_targeted_scan  → TestRunner：detached 起 scheduled-grayscale（绝不阻塞唤醒）
 *   analyze_false_positives            → Analyzer：同步跑（纯统计 <10s），误报打标 + 报告
 *   propose_new_sample / apply_semantic_fix → Agent 接管型：orchestrator 只喊 NEED_AGENT，
 *                                            由定时任务的 Proma Agent 执行智能 SOP 后回写队列
 * 流转：full_scan→analyze→(误报>3)apply_semantic_fix[blocked 48h 过期作废，绝不自动放行]
 *       apply 完成→targeted_scan 验证；>12h 无全量自动补排 run_full_scan。
 * 并发保护：orchestrator 自身锁文件；running 任务以 run-task 包装器 pid 存活判定。
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, openSync, statSync, rmSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync as rfs } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const TASKS_FILE = join(REPO, 'tasks.json')
const LOCK = join(homedir(), '.proma', 'bloma-orchestrator.lock')
const AUDIT = join(homedir(), '.proma', 'audit-log.jsonl')
const LOGS = join(REPO, 'logs')
const now = () => new Date().toISOString()
const log = (...a) => console.log(`[orch ${now().slice(11, 19)}]`, ...a)

function audit(event) {
  try { appendFileSync(AUDIT, JSON.stringify({ ts: now(), ...event }) + '\n', 'utf8') } catch {}
}
function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

// 0. 自身锁（10 分钟新鲜且 pid 活 → 让位）
if (existsSync(LOCK)) {
  try {
    const l = JSON.parse(rfs(LOCK, 'utf8'))
    if (pidAlive(l.pid) && Date.now() - l.ts < 600_000) { log('另一 orchestrator 在跑，让位'); process.exit(0) }
  } catch {}
}
writeFileSync(LOCK, JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf8')

// 1. 队列载入
if (!existsSync(TASKS_FILE)) { log('tasks.json 不存在——初始化空队列'); writeFileSync(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }, null, 1)) }
const store = JSON.parse(rfs(TASKS_FILE, 'utf8'))
const tasks = store.tasks
const save = () => writeFileSync(TASKS_FILE, JSON.stringify(store, null, 1))
const push = (t) => { tasks.push({ id: `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, created_at: now(), started_at: null, completed_at: null, artifacts: null, retries: 0, max_retries: 3, status: 'pending', priority: 50, ...t }); return tasks[tasks.length - 1] }
const hasPendingOrRunning = (type) => tasks.some((t) => t.type === type && ['pending', 'running'].includes(t.status))

// 2. running 收口
for (const t of tasks.filter((x) => x.status === 'running')) {
  const marker = join(LOGS, `task-${t.id}.exit`)
  if (pidAlive(t.pid) && !existsSync(marker)) {
    // 僵尸判定（用户风险①）：pid 可能被 OS 复用/包装器假活——日志 mtime 是心跳
    // （scheduled-grayscale 每 60s 打心跳行；断流 45min 视为僵尸，杀并走重试）
    const logPath = join(LOGS, `task-${t.id}.log`)
    const logIdleMin = existsSync(logPath) ? (Date.now() - statSync(logPath).mtimeMs) / 60_000 : (Date.now() - new Date(t.started_at).getTime()) / 60_000
    if (logIdleMin > 45) {
      try { process.kill(t.pid) } catch {}
      t.retries += 1
      t.status = t.retries < t.max_retries ? 'pending' : 'failed'
      t.artifacts = { error: `ZOMBIE_LOG_IDLE_${Math.round(logIdleMin)}MIN` }
      audit({ event: 'zombie_killed', id: t.id, type: t.type, idle_min: Math.round(logIdleMin) })
      log(`僵尸判定：${t.id}(${t.type}) 日志断流 ${Math.round(logIdleMin)}min → ${t.status}`)
      continue
    }
    if (Date.now() - new Date(t.started_at).getTime() > 2 * 3600_000) {
      try { process.kill(t.pid) } catch {}
      t.status = 'failed'; t.artifacts = { error: 'TIMEOUT_2H' }; t.retries = t.max_retries
      audit({ event: 'task_timeout', id: t.id, type: t.type })
      log(`任务 ${t.id}(${t.type}) 超 2h，杀并判 failed`)
    } else { log(`running 中：${t.id}(${t.type}) pid=${t.pid}，本轮不启动新任务`); save(); process.exit(0) }
  } else if (existsSync(marker)) {
    const code = parseInt(rfs(marker, 'utf8').trim(), 10)
    t.completed_at = now()
    if (code === 0) { t.status = 'completed'; followUp(t) }
    else {
      t.retries += 1
      t.status = t.retries < t.max_retries ? 'pending' : 'failed'
      t.artifacts = { exit_code: code }
      audit({ event: 'task_failed', id: t.id, type: t.type, retries: t.retries })
    }
    log(`收口 ${t.id}(${t.type}) exit=${code} → ${t.status}`)
  } else {
    t.retries += 1
    t.status = t.retries < t.max_retries ? 'pending' : 'failed'
    t.artifacts = { error: 'RUNNER_DIED_NO_MARKER' }
    audit({ event: 'runner_died', id: t.id, type: t.type })
    log(`runner 消失无 marker：${t.id} → ${t.status}`)
  }
}

// 3. blocked 过期（决策二：作废+提醒，绝不自动放行）
for (const b of tasks.filter((x) => x.status === 'blocked' && x.expires_at && new Date(x.expires_at) < new Date())) {
  b.status = 'expired'
  b.artifacts = { ...(b.artifacts || {}), note: '48h 未获批准，作废（误报信号仍在账本积累，可再生成）' }
  audit({ event: 'blocked_expired', id: b.id, type: b.type })
  log(`blocked 过期作废：${b.id}(${b.type})`)
}

// 4. 新鲜度兜底：>12h 无全量扫描 → 自动补排
const lastFull = tasks.filter((t) => t.type === 'run_full_scan' && t.status === 'completed').sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''))[0]
const staleFull = !lastFull || Date.now() - new Date(lastFull.completed_at).getTime() > 12 * 3600_000
if (staleFull && !hasPendingOrRunning('run_full_scan')) push({ type: 'run_full_scan', priority: 60 })

// 5. 取最高优先级 pending 执行
const pending = tasks.filter((t) => t.status === 'pending').sort((a, b) => b.priority - a.priority)
const AGENT_TYPES = new Set(['propose_new_sample', 'apply_semantic_fix'])
let claimed = false
for (const t of pending) {
  if (claimed) break
  if (AGENT_TYPES.has(t.type)) {
    // Agent 接管型：30 分钟内不重复喊（防刷屏）；喊话由唤醒方 Proma Agent 消费
    if (!t.last_need_agent_ts || Date.now() - new Date(t.last_need_agent_ts).getTime() > 1800_000) {
      t.last_need_agent_ts = now()
      console.log(`NEED_AGENT ${t.id} ${t.type} ${t.blocked_reason || ''}`)
      audit({ event: 'need_agent', id: t.id, type: t.type })
      claimed = true // 每轮只喊一个
    }
    continue
  }
  claimed = true
  if (t.type === 'analyze_false_positives') {
    // 同步快任务（纯统计 <10s）
    t.status = 'running'; t.started_at = now(); save()
    try {
      const out = spawnSyncNode('analyze-false-positives.mjs').trim()
      const summary = out.split('\n').filter(Boolean).pop() || ''
      t.status = 'completed'; t.completed_at = now(); t.artifacts = { stdout: summary }
      followUp(t)
      log('analyze 完成:', summary)
    } catch (e) {
      t.retries += 1; t.status = t.retries < t.max_retries ? 'pending' : 'failed'; t.artifacts = { error: String(e).slice(0, 200) }
    }
  } else if (t.type === 'run_full_scan' || t.type === 'run_targeted_scan') {
    mkdirSync(LOGS, { recursive: true })
    const samples = t.type === 'run_full_scan'
      ? Object.keys(JSON.parse(rfs(join(REPO, 'scripts', 'grayscale-samples.json'), 'utf8')).samples).join(',')
      : (t.params?.samples || '')
    if (!samples) { t.status = 'failed'; t.artifacts = { error: 'no samples' }; continue }
    const marker = join(LOGS, `task-${t.id}.exit`)
    const out = join(LOGS, `task-${t.id}.log`)
    // 启动前必须清旧 marker（2026-09-12 本体 bug）：同一 id 重试时旧 marker 仍在，
    // 下一轮醒来会走 existsSync(marker) 分支把**仍在跑的任务**误判为已收口（按旧退出码
    // 处理并再启一份 → 重复扫描）。
    rmSync(marker, { force: true })
    const fd = openSync(out, 'a')
    const child = spawn(process.execPath, [join(REPO, 'scripts', 'run-task.mjs'), marker, '--', process.execPath, join(REPO, 'scripts', 'scheduled-grayscale.mjs'), '--samples', samples, '--budget-min', '300'], { stdio: ['ignore', fd, fd], detached: true, cwd: REPO })
    child.unref()
    t.status = 'running'; t.started_at = now(); t.pid = child.pid
    log(`启动 ${t.id}(${t.type}) samples=${samples.length > 40 ? samples.slice(0, 40) + '…' : samples} pid=${child.pid}`)
  } else {
    t.status = 'failed'; t.artifacts = { error: `未知任务类型 ${t.type}` }
  }
}

function followUp(t) {
  if (t.type === 'run_full_scan' || t.type === 'run_targeted_scan') {
    if (!hasPendingOrRunning('analyze_false_positives')) push({ type: 'analyze_false_positives', priority: 90 })
  } else if (t.type === 'analyze_false_positives') {
    const m = /total_cases=(\d+)/.exec(String(t.artifacts?.stdout || ''))
    if (m && Number(m[1]) > 3 && !tasks.some((x) => x.type === 'apply_semantic_fix' && ['pending', 'running', 'blocked'].includes(x.status))) {
      // 冷却去重（用户风险④）：过期/被拒提案案例数未增长 → 不再重复生成同款提案刷屏
      const lastDead = tasks.filter((x) => x.type === 'apply_semantic_fix' && ['expired', 'failed'].includes(x.status)).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0]
      const lastCount = Number(lastDead?.params?.proposal_case_count || 0)
      if (lastDead && Number(m[1]) <= lastCount) {
        log(`提案冷却：案例数 ${m[1]} 未超上次已过期提案的 ${lastCount}，跳过重复生成`)
      } else {
        push({ type: 'apply_semantic_fix', priority: 80, status: 'blocked', params: { proposal_case_count: Number(m[1]) }, blocked_reason: `误报案例 ${m[1]} 个：批准=改 pending（Agent 将生成同义词补丁建议 PR 草稿，不自动改产品）`, expires_at: new Date(Date.now() + 48 * 3600_000).toISOString() })
        log(`误报 ${m[1]} 例 → apply_semantic_fix 已入队 blocked（等你批准）`)
      }
    }
  } else if (t.type === 'apply_semantic_fix') {
    if (t.params?.verify_samples && !hasPendingOrRunning('run_targeted_scan')) push({ type: 'run_targeted_scan', priority: 85, params: { samples: t.params.verify_samples } })
  } else if (t.type === 'propose_new_sample') {
    if (t.params?.new_ids && !hasPendingOrRunning('run_targeted_scan')) push({ type: 'run_targeted_scan', priority: 70, params: { samples: t.params.new_ids } })
  }
}

function spawnSyncNode(script) {
  return execFileSync(process.execPath, [join(REPO, 'scripts', script)], { cwd: REPO, encoding: 'utf8', timeout: 60_000 })
}

save()
const counts = {}
for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1
log(`队列 ${tasks.length}：`, JSON.stringify(counts))
const blocked = tasks.filter((t) => t.status === 'blocked')
if (blocked.length) log('待你审核:', blocked.map((b) => `${b.id}(${b.type}) 至 ${b.expires_at?.slice(0, 16)}`).join(', '))
try { writeFileSync(LOCK, JSON.stringify({ pid: 0, ts: Date.now() }), 'utf8') } catch {}
