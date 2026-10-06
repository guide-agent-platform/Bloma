#!/usr/bin/env node
/**
 * dogfood-run — 狗粮自动驾驶（2026-10-05 拍板：agent 顶替用户推测试）。
 *
 * 通道：CDP 远程调试驾驶真实 Bloma（真实 home/渠道/项目）——electron-startup-smoke
 * 同款模式。驾驶面：textarea + button[aria-label=发送消息] + 确认卡稳定锚点
 * [data-ai-id="card-option-<id>"]（PRD prd_confirm_confirm / UX ux_confirm_go /
 * MVP mvp_confirm_go|mvp_adjust / 澄清卡按「你帮我定」优先）。
 *
 * 门策略（用户拍板 findings 驱动）：PRD/UX 自动过；MVP 门读项目
 * 00_VERIFY/drive-findings.json——P0=0 自动确认交付，P0>0 自动回炉一轮（点
 * mvp_adjust 并发送修复指令），二轮仍有 P0 停住出报告。
 *
 * 用法：
 *   node scripts/dogfood-run.mjs --request "做一个简单的倒计时器" [--timeout-min 25] [--mode quick|longterm]
 *   node scripts/dogfood-run.mjs --probe-only        # 只拉起+dump 驾驶面状态即退
 *   node scripts/dogfood-run.mjs --keep-open          # 结束后不关 app（人工接管看现场）
 * 输出：stdout 时间线 + <repo>/dogfood-run-report.json
 */
import { spawn, execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const REPO = resolve(opt('repo', '.'))
const REQUEST = opt('request', '')
const TIMEOUT_MIN = Number(opt('timeout-min', '25'))
const MODE = opt('mode', 'quick')
if (!['quick', 'longterm'].includes(MODE)) {
  console.error(`--mode 仅支持 quick|longterm，收到：${MODE}`)
  process.exit(2)
}
const PROBE_ONLY = flag('probe-only')
const KEEP_OPEN = flag('keep-open')

if (!PROBE_ONLY && !REQUEST) {
  console.error('用法：node scripts/dogfood-run.mjs --request "需求文本" | --probe-only')
  process.exit(2)
}

const ELECTRON = join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')
if (!existsSync(ELECTRON)) throw new Error(`electron 缺失：${ELECTRON}（npm ci）`)

// ── 双开守卫：同仓库实例已在跑 → 放弃（双实例共享 ~/.proma 有竞态风险）──
function findRunningInstance() {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='electron.exe'\\" | Where-Object { $_.CommandLine -like '*guide-agent-platform-sprint0*' } | Select-Object -First 1 -ExpandProperty ProcessId"`,
      { encoding: 'utf8' },
    )
    const pid = Number(String(out).trim())
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}
const runningPid = findRunningInstance()
if (runningPid) {
  console.error(`[dogfood] 检测到 Bloma 已在运行（pid=${runningPid}）——双实例共享 ~/.proma 有竞态风险。请先关闭它再跑自动驾驶。`)
  process.exit(3)
}

// ── CDP 客户端（node 22 全局 WebSocket）──
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`))
        else resolve(msg.result)
      }
    })
    this.closed = new Promise((resolveClose) => ws.addEventListener('close', resolveClose))
  }

  static async connect(port, deadlineMs) {
    const deadline = Date.now() + deadlineMs
    while (Date.now() < deadline) {
      try {
        const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
        const page = pages.find((p) => p.type === 'page' && /dist\/index\.html/.test(p.url))
        if (page) {
          const ws = new WebSocket(page.webSocketDebuggerUrl)
          await new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('ws-timeout')), 5_000)
            ws.addEventListener('open', () => { clearTimeout(t); res() })
            ws.addEventListener('error', (e) => { clearTimeout(t); rej(e.error ?? new Error('ws-error')) })
          })
          return new Cdp(ws)
        }
      } catch {
        // 尚未就绪，继续轮询
      }
      await sleep(700)
    }
    throw new Error(`CDP 连接超时（port=${port}）`)
  }

  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(`page-eval: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description?.slice(0, 300) ?? ''}`)
    return result.result?.value
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 页面驾驶原语 ──
const PAGE_STATE = `JSON.stringify({
  hasTextarea: !!document.querySelector('textarea'),
  textareaPlaceholder: (document.querySelector('textarea')?.placeholder ?? ''),
  stopButton: !!document.querySelector('button[aria-label="停止本轮制作"]'),
  sendEnabled: (() => { const b = document.querySelector('button[aria-label="发送消息"]'); return !!b && !b.disabled })(),
  upgradeDialog: !!document.querySelector('[data-ai-id="upgrade-confirm-dialog"]'),
  overlays: {
    review: !!document.querySelector('[data-ai-id="review-choices-overlay"]'),
    prdConfirm: !!document.querySelector('[data-ai-id="prd-confirm-overlay"]'),
    requirementConfirm: !!document.querySelector('[data-ai-id="requirement-confirm-overlay"]'),
    clarification: !!document.querySelector('[data-ai-id="clarification-card-overlay"]'),
  },
  options: Array.from(document.querySelectorAll('button[data-ai-id^="card-option-"], button[data-ai-id^="clarification-option-"], button[data-ai-id^="review-choice-"]')).map((b) => {
    const raw = b.getAttribute('data-ai-id')
    const kind = raw.startsWith('clarification-') ? 'clarify' : raw.startsWith('review-') ? 'review' : 'card'
    return { id: raw.replace(/^(card-option-|clarification-option-|review-choice-)/, ''), kind, raw, label: (b.textContent || '').trim().slice(0, 48), disabled: b.disabled }
  }),
  tail: (document.body.innerText || '').slice(-450),
})`

const TYPE_AND_SEND = `(async (text) => {
  const ta = document.querySelector('textarea')
  if (!ta) return { ok: false, err: 'no-textarea' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, text)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 150))
  const btn = document.querySelector('button[aria-label="发送消息"]')
  if (btn && !btn.disabled) { btn.click(); return { ok: true, via: 'button' } }
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  await new Promise((r) => setTimeout(r, 300))
  return { ok: ta.value === '', via: 'enter', residue: ta.value.slice(0, 40) }
})`

const CLICK_OPTION = `(id) => {
  const b = document.querySelector('[data-ai-id="card-option-' + id + '"]')
  if (!b) return { ok: false, err: 'not-found' }
  if (b.disabled) return { ok: false, err: 'disabled' }
  b.click()
  return { ok: true, label: (b.textContent || '').trim().slice(0, 60) }
}`

const CLICK_RAW_ANCHOR = `(anchor) => {
  const b = document.querySelector('[data-ai-id="' + anchor + '"]')
  if (!b) return { ok: false, err: 'not-found' }
  if (b.disabled) return { ok: false, err: 'disabled' }
  b.click()
  return { ok: true, label: (b.textContent || '').trim().slice(0, 60) }
}`

const CLICK_BUTTON_BY_TEXT = `(text) => {
  const buttons = Array.from(document.querySelectorAll('button'))
  const hit = buttons.find((b) => (b.textContent || '').trim() === text) ||
              buttons.find((b) => ((b.textContent || '').trim()).includes(text))
  if (!hit) return { ok: false, err: 'not-found' }
  if (hit.disabled) return { ok: false, err: 'disabled' }
  hit.click()
  return { ok: true }
}`

// ── 项目发现（交付检测 / findings 读取）──
function findWorkspaceProjectsRoots() {
  const base = join(homedir(), '.proma', 'agent-workspaces')
  try {
    return readdirSync(base)
      .filter((name) => existsSync(join(base, name, 'generated-projects')))
      .map((name) => join(base, name, 'generated-projects'))
  } catch {
    return []
  }
}

function findActiveProject(startedAtMs) {
  let best = null
  for (const root of findWorkspaceProjectsRoots()) {
    for (const name of readdirSync(root)) {
      const dir = join(root, name)
      try {
        const stat = statSync(dir)
        if (stat.mtimeMs < startedAtMs - 60_000) continue
        if (!existsSync(join(dir, 'LAUNCH.json'))) continue
        if (!best || stat.mtimeMs > best.mtimeMs) best = { dir, mtimeMs: stat.mtimeMs, id: name }
      } catch {
        // ignore
      }
    }
  }
  return best
}

function readP0Findings(projectDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(projectDir, '00_VERIFY', 'drive-findings.json'), 'utf8'))
    const findings = Array.isArray(parsed.findings) ? parsed.findings : []
    return findings.filter((f) => f.severity === 'P0').map((f) => String(f.title ?? '').slice(0, 80))
  } catch {
    return []
  }
}


function readProjectRecord(projectId) {
  try {
    const parsed = JSON.parse(readFileSync(join(homedir(), '.proma', 'projects.json'), 'utf8'))
    const items = Array.isArray(parsed) ? parsed : (parsed.projects ?? [])
    return items.find((p) => p.project_id === projectId) ?? null
  } catch {
    return null
  }
}

// ── 主流程 ──
const report = {
  run_id: randomUUID().slice(0, 8),
  started_at: new Date().toISOString(),
  request: REQUEST,
  port: 9600 + Math.floor(Math.random() * 190),
  timeline: [],
  cards_answered: [],
  outcome: 'unknown',
  project: null,
  p0_titles: [],
  log_tail: '',
}

function log(line) {
  report.timeline.push({ t: new Date().toISOString(), line })
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`)
}

let electronChild = null

async function cleanup() {
  if (KEEP_OPEN) {
    log(`KEEP_OPEN：app 保留运行（pid=${electronChild?.pid ?? '?'}），不清理`)
    return
  }
  try {
    await Promise.race([
      cdp?.send('Browser.close') ?? Promise.resolve(),
      new Promise((r) => setTimeout(r, 3_000)),
    ])
    await sleep(1_500)
  } catch {
    // ignore
  }
  if (electronChild?.pid) {
    try {
      execSync(`taskkill /PID ${electronChild.pid} /T /F`, { stdio: 'ignore' })
    } catch {
      // ignore
    }
  }
}

let cdp = null

try {
  log(`启动 Bloma（CDP port=${report.port}，真实 home）`)
  electronChild = spawn(ELECTRON, ['.', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${report.port}`], {
    cwd: REPO,
    stdio: 'ignore',
    detached: false,
  })
  cdp = await Cdp.connect(report.port, 40_000)
  log('CDP 已连接渲染页')

  // 等驾驶面就绪
  let state = null
  for (let i = 0; i < 40; i += 1) {
    state = JSON.parse((await cdp.eval(PAGE_STATE)) ?? '{}')
    if (state.hasTextarea) break
    await sleep(1000)
  }
  if (!state?.hasTextarea) throw new Error(`驾驶面未就绪：${JSON.stringify(state).slice(0, 200)}`)
  log(`驾驶面就绪（placeholder="${state.textareaPlaceholder.slice(0, 30)}"）`)
  if (/还没有连接 AI 模型/.test(state.textareaPlaceholder)) throw new Error('渠道未配置（自动驾驶需要可用渠道）')

  if (PROBE_ONLY) {
    log('PROBE_ONLY：dump 驾驶面状态后退出')
    console.log(JSON.stringify(state, null, 2))
    report.outcome = 'probe-ok'
    await cleanup()
    process.exit(0)
  }

  // 关掉可能挡路的升级弹窗
  if (state.upgradeDialog) {
    await cdp.eval(`(() => { const b = document.querySelector('[data-ai-id="upgrade-cancel"]'); if (b) { b.click(); return true } return false })()`)
    log('已关闭升级弹窗')
  }

  // ── fresh start：新开一单（避免续接旧项目对话）──
  log('fresh start：进入项目历史 → 新建项目')
  for (let i = 0; i < 10; i += 1) {
    const r = await cdp.eval(`(${CLICK_BUTTON_BY_TEXT})(${JSON.stringify('所有项目')})`)
    if (r?.ok) {
      log('已进入项目历史页')
      break
    }
    await sleep(1_000)
  }
  await sleep(1_500)
  let freshOk = false
  for (let i = 0; i < 8; i += 1) {
    const r = await cdp.eval(`(${CLICK_BUTTON_BY_TEXT})(${JSON.stringify('新建项目')})`)
    if (r?.ok) {
      freshOk = true
      log('已点「新建项目」')
      break
    }
    await sleep(1_000)
  }
  if (!freshOk) log('「新建项目」未找到（可能已在新会话，继续）')
  await sleep(2_000)
  // 两道门：模式卡是 div[data-ai-id=mode-card-quick|mode-card-longterm]（非 button）
  const MODE_LABEL = MODE === 'longterm' ? '深度项目' : '快速尝鲜'
  let modeClicked = false
  for (let i = 0; i < 8; i += 1) {
    const r = await cdp.eval(`(() => { const el = document.querySelector('[data-ai-id="mode-card-${MODE}"]'); if (!el) return { ok: false, err: 'not-found' }; el.click(); return { ok: true } })()`)
    if (r?.ok) {
      modeClicked = true
      log(`已选「${MODE_LABEL}」模式（--mode ${MODE}）`)
      break
    }
    await sleep(1_000)
  }
  if (!modeClicked) log('模式卡未出现（可能已直达工作区，继续）')
  await sleep(1_500)
  for (let i = 0; i < 25; i += 1) {
    state = JSON.parse((await cdp.eval(PAGE_STATE)) ?? '{}')
    if (state.hasTextarea && (state.tail ?? '').length < 900) break
    await sleep(1_000)
  }
  if (!state?.hasTextarea) throw new Error(`新会话未就绪：${JSON.stringify(state).slice(0, 200)}`)

  // 发送需求
  const sentAt = Date.now()
  let sendResult = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    sendResult = await cdp.eval(`(${TYPE_AND_SEND})(${JSON.stringify(REQUEST)})`)
    log(`发送需求（第 ${attempt} 次）：${JSON.stringify(sendResult)}`)
    if (sendResult?.ok) break
    await sleep(2000)
  }
  if (!sendResult?.ok) throw new Error(`需求发送失败：${JSON.stringify(sendResult)}`)

  // 主循环：应答卡 + 等交付
  const deadline = Date.now() + TIMEOUT_MIN * 60_000
  const cooldown = new Map()
  let mvpRound = 0
  let lastTail = ''
  let quietTicks = 0
  let blockedLastLog = 0

  while (Date.now() < deadline) {
    await sleep(3000)
    state = JSON.parse((await cdp.eval(PAGE_STATE)) ?? '{}')
    if (state.tail !== lastTail) {
      quietTicks = 0
      lastTail = state.tail
    } else {
      quietTicks += 1
    }

    if (state.upgradeDialog) {
      await cdp.eval(`(() => { const b = document.querySelector('[data-ai-id="upgrade-cancel"]'); if (b) { b.click(); return true } return false })()`)
      log('关闭升级弹窗')
      continue
    }

    // 交付检测（权威）：只认 projects.json 存储终态（陷阱 3——DELIVERY.md 出现≠交付，
    // 第一版误判把 implement 截杀在半路）。发现新项目后每轮查记录。
    const project = findActiveProject(sentAt)
    if (project) {
      report.project = { id: project.id, dir: project.dir }
      const rec = readProjectRecord(project.id)
      if (rec && rec.status === 'completed' && rec.current_stage === 'completed') {
        log(`交付检测命中（权威存储终态）：项目 ${project.id}`)
        report.outcome = 'delivered'
        break
      }
      if (rec && rec.status === 'blocked_for_user_decision' && Date.now() - (blockedLastLog ?? 0) > 30_000) {
        blockedLastLog = Date.now()
        log(`项目 blocked_for_user_decision（${rec.desktop_phase ?? ''}）——页面尾迹：${(state.tail ?? '').slice(-160).split(String.fromCharCode(10)).join(' ')}`)
      }
    }

    // 卡应答（优先级：PRD 确认 > UX 确认 > MVP 策略 > 委托/澄清）
    const enabled = (state.options ?? []).filter((o) => !o.disabled)
    const pick = (id) => enabled.find((o) => o.id === id)
    const pickByLabel = (re) => enabled.find((o) => re.test(o.label))

    // 环节应对（overlay 模态优先于聊天卡；全量表见 2026-10-05 盘点）
    let action = null
    const overlays = state.overlays ?? {}
    const clarifyAuto = enabled.find((o) => o.kind === 'clarify' && (o.id === 'auto' || /你帮我|全部交给/.test(o.label)))
    const reviewAuto = enabled.find((o) => o.kind === 'review' && (o.id === 'prd_review_delegate_all' || /全部交给|你帮我/.test(o.label)))
    if (state.upgradeDialog) {
      action = { id: '__upgrade_cancel', raw: 'upgrade-cancel', why: '关升级弹窗' }
    } else if (overlays.review) {
      action = { id: '__review_auto', raw: reviewAuto ? reviewAuto.raw : 'review-choice-global-prd_review_delegate_all', why: `内审定夺委托（${reviewAuto?.label ?? '全部交给向导决定'}）` }
    } else if (overlays.prdConfirm) {
      action = { id: '__prd_submit', raw: 'prd-confirm-submit', why: 'PRD 确认（自动）' }
    } else if (overlays.requirementConfirm) {
      action = { id: '__requirement_submit', raw: 'requirement-confirm-submit', why: '需求清单确认（自动）' }
    } else if (overlays.clarification) {
      action = { id: '__clarify_auto', raw: 'clarification-option-auto', why: `澄清委托（${clarifyAuto?.label ?? '你帮我决定'}）` }
    } else if (pick('ux_confirm_go')) {
      action = { id: 'ux_confirm_go', why: 'UX 草图确认（自动）' }
    } else if (pick('ux_delegate')) {
      action = { id: 'ux_delegate', why: 'UX 委托开工（自动）' }
    } else if (pick('mvp_confirm_go') || pick('mvp_adjust')) {
      const p0 = project ? readP0Findings(project.dir) : []
      if (p0.length === 0) {
        action = { id: 'mvp_confirm_go', why: 'MVP 确认（findings P0=0）' }
      } else if (mvpRound === 0) {
        mvpRound += 1
        report.p0_titles = p0
        action = { id: 'mvp_adjust', why: `MVP 回炉（P0×${p0.length}：${p0[0]}）`, feedback: `修复探索发现的 P0 问题：${p0.join('；')}。修完重新走验收。` }
      } else {
        log(`二轮仍有 P0（${p0.length} 项）——停住出报告，等你拍板`)
        report.outcome = 'p0-persisted'
        report.p0_titles = p0
        break
      }
    } else {
      const delegate = enabled.find((o) => /你帮我|帮我定|按建议|你定/.test(o.label))
      const first = enabled[0]
      const chosen = delegate ?? first
      if (chosen) action = { id: chosen.id, raw: chosen.raw, why: `卡应答（${delegate ? '委托' : '首选项'}：${chosen.label}）` }
    }

    if (action) {
      const cooldownKey = action.raw ?? action.id
      const lastClick = cooldown.get(cooldownKey) ?? 0
      if (Date.now() - lastClick < 12_000) continue
      const clicked = action.raw
        ? await cdp.eval(`(${CLICK_RAW_ANCHOR})(${JSON.stringify(action.raw)})`)
        : await cdp.eval(`(${CLICK_OPTION})(${JSON.stringify(action.id)})`)
      if (clicked?.ok) {
        cooldown.set(cooldownKey, Date.now())
        report.cards_answered.push({ t: new Date().toISOString(), ...action, label: clicked.label })
        log(`卡应答：${cooldownKey}（${action.why}）`)
        if (action.feedback) {
          await sleep(4000)
          const fb = await cdp.eval(`(${TYPE_AND_SEND})(${JSON.stringify(action.feedback)})`)
          log(`回炉指令发送：${JSON.stringify(fb)}`)
        }
      }
    }
  }

  if (report.outcome === 'unknown') {
    report.outcome = 'timeout'
    log(`超时（${TIMEOUT_MIN}min）——保留现场 ${KEEP_OPEN ? '' : '（加 --keep-open 可留 app）'}`)
  }
  report.log_tail = lastTail
  report.finished_at = new Date().toISOString()
  writeFileSync(join(REPO, 'dogfood-run-report.json'), JSON.stringify(report, null, 2), 'utf8')
  log(`报告已写 ${join(REPO, 'dogfood-run-report.json')}（outcome=${report.outcome}）`)
  await cleanup()
  process.exit(report.outcome === 'delivered' ? 0 : 1)
} catch (error) {
  log(`致命错误：${error instanceof Error ? error.message : String(error)}`)
  report.outcome = 'error'
  report.error = String(error instanceof Error ? error.message : error)
  report.finished_at = new Date().toISOString()
  try {
    writeFileSync(join(REPO, 'dogfood-run-report.json'), JSON.stringify(report, null, 2), 'utf8')
  } catch {
    // ignore
  }
  await cleanup()
  process.exit(2)
}
