// dogfood-resume.mjs（批10 2026-10-07）：续跑既有项目单——打开指定项目 → 发续跑消息 →
// 自动应答门卡（MVP P0=0 确认交付）→ 权威交付检测 → 读 PQ 双轴与 mvp-review 报告。
// 复用 dogfood-run.mjs 驾驶原语（CDP/TYPE_AND_SEND/卡锚点），差异：不做 fresh start，
// 从项目历史打开目标项目；交付检测只认目标 project_id 的存储终态。
// 用法：node scripts/dogfood-resume.mjs --project-id <id> --message-file <path> [--timeout-min 45]
import { execSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const opt = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const PROJECT_ID = opt('project-id')
const MESSAGE_FILE = opt('message-file')
const TIMEOUT_MIN = Number(opt('timeout-min', '45'))
const REPO = process.cwd()
/** 运行产物统一目录（2026-10-08 治理：报告不再散落仓库根） */
const REPORT_DIR = join(REPO, 'run-artifacts')
mkdirSync(REPORT_DIR, { recursive: true })

if (!PROJECT_ID || !MESSAGE_FILE) {
  console.error('用法：node scripts/dogfood-resume.mjs --project-id <id> --message-file <path> [--timeout-min 45]')
  process.exit(2)
}
const MESSAGE = readFileSync(MESSAGE_FILE, 'utf8').trim()

const ELECTRON = join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')
if (!existsSync(ELECTRON)) throw new Error(`electron 缺失：${ELECTRON}`)

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
  console.error(`[resume] Bloma 已在运行（pid=${runningPid}）——先关闭再续跑。`)
  process.exit(3)
}

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
        // 尚未就绪
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

const PAGE_STATE = `JSON.stringify({
  hasTextarea: !!document.querySelector('textarea'),
  textareaPlaceholder: (document.querySelector('textarea')?.placeholder ?? ''),
  stopButton: !!document.querySelector('button[aria-label="停止本轮制作"]'),
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
  tail: ((document.body && document.body.innerText) || '').slice(-450),
})`

const TYPE_AND_SEND = `(async (text) => {
  const ta = document.querySelector('textarea')
  if (!ta) return { ok: false, err: 'no-textarea' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, text)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 300))
  if (ta.value !== text) {
    return { ok: false, err: 'value-mismatch', got_len: ta.value.length, expect_len: text.length }
  }
  const btn = document.querySelector('button[aria-label="发送消息"]')
  if (btn && !btn.disabled) {
    btn.click()
    await new Promise((r) => setTimeout(r, 600))
    return { ok: true, via: 'button', residue: ta.value.slice(0, 40) }
  }
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

// 项目历史里点击目标项目卡片：行主体是无 data-ai-id 的内层 button（onClick=onResume）；
// 排除带 data-ai-id 的操作按钮（归档/重命名等），避免命中外层 div 容器。
const CLICK_PROJECT_CARD = `(nameFragment) => {
  const buttons = Array.from(document.querySelectorAll('button'))
  const hit = buttons.find((b) => !b.hasAttribute('data-ai-id') && ((b.textContent || '').includes(nameFragment)))
  if (!hit) return { ok: false, err: 'not-found' }
  if (hit.disabled) return { ok: false, err: 'disabled' }
  hit.click()
  return { ok: true, label: (hit.textContent || '').trim().slice(0, 80) }
}`

function readProjectRecord(projectId) {
  try {
    const parsed = JSON.parse(readFileSync(join(homedir(), '.proma', 'projects.json'), 'utf8'))
    const items = Array.isArray(parsed) ? parsed : (parsed.projects ?? [])
    return items.find((p) => p.project_id === projectId) ?? null
  } catch {
    return null
  }
}

function readP0Findings(projectDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(projectDir, '00_VERIFY', 'drive-findings.json'), 'utf8'))
    const findings = Array.isArray(parsed.findings) ? parsed.findings : []
    const seen = new Set()
    const titles = []
    for (const f of findings.filter((x) => x.severity === 'P0')) {
      const t = String(f.title ?? '').slice(0, 80)
      if (!seen.has(t)) { seen.add(t); titles.push(t) }
    }
    return titles
  } catch {
    return []
  }
}

/** 最新纠错会话元信息（correction-session 落盘 meta.json，批11.7）。 */
function readCorrectionMeta(projectDir) {
  try {
    const base = join(projectDir, '00_CORRECTION')
    if (!existsSync(base)) return null
    const dirs = readdirSync(base)
      .map((n) => join(base, n))
      .filter((d) => { try { return statSync(d).isDirectory() } catch { return false } })
      .sort()
    for (const d of [...dirs].reverse()) {
      const metaPath = join(d, 'meta.json')
      if (existsSync(metaPath)) {
        try { return { ...JSON.parse(readFileSync(metaPath, 'utf8')), sessionDir: d } } catch { /* 试更早的 */ }
      }
    }
  } catch {
    // 无会话目录
  }
  return null
}

/** drive-port /eval（独立纠错实例操控通道，批11.7 修复后可靠）。 */
async function driveEval(port, js, timeoutMs = 8000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/eval`, { method: 'POST', body: JSON.stringify({ js }), signal: ctrl.signal })
    return await resp.json()
  } finally {
    clearTimeout(t)
  }
}

/** MVP 点点看后置流程（批11.7 移植）：等实例就绪→程序化点选×2+done→picks 落盘校验。 */
async function runPickFlow(projectDir) {
  const startedAt = Date.now()
  let meta = null
  while (Date.now() - startedAt < 45_000) {
    const m = readCorrectionMeta(projectDir)
    if (m && Date.now() - new Date(m.startedAt).getTime() < 10 * 60_000) { meta = m; break }
    await sleep(1500)
  }
  if (!meta) return { ok: false, error: 'correction-meta-not-found（修改预览实例未在 45s 内就绪）' }
  let simOk = false
  for (let i = 0; i < 20 && !simOk; i++) {
    const r = await driveEval(meta.drivePort, 'window.CorrectionSimulate ? 1 : 0').catch(() => null)
    if (r && r.ok && r.result === 1) simOk = true
    else await sleep(1500)
  }
  if (!simOk) return { ok: false, error: 'CorrectionSimulate-not-ready', drivePort: meta.drivePort }
  const pickDefs = [
    { kind: 'visual', note: '自动验收：这里不够醒目' },
    { kind: 'function', note: '自动验收：操作反馈不够明显' },
  ]
  const selectors = ['.w-row', 'button', '.w-banner', '.w-card', 'input', '.w-chip']
  const picks = []
  for (const def of pickDefs) {
    for (const sel of selectors) {
      const r = await driveEval(meta.drivePort, `JSON.stringify(window.CorrectionSimulate ? CorrectionSimulate.pick(document.querySelector(${JSON.stringify(sel)}), {kind:${JSON.stringify(def.kind)}, note:${JSON.stringify(def.note)}}) : {ok:false})`).catch(() => null)
      let parsed = null
      try { parsed = r && r.ok ? JSON.parse(r.result) : null } catch { parsed = null }
      if (parsed && parsed.ok) { picks.push({ selector: sel, ...parsed }); break }
    }
  }
  await driveEval(meta.drivePort, 'CorrectionSimulate.done(); "done"').catch(() => null)
  await sleep(1500)
  let persisted = null
  try {
    const raw = readFileSync(join(meta.sessionDir, 'picks.jsonl'), 'utf8')
    const lines = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    persisted = { picks: lines.filter((l) => l.type === 'pick').length, done: lines.some((l) => l.type === 'done') }
  } catch {
    // 未落盘
  }
  return { ok: picks.length >= 1 && Boolean(persisted && persisted.done), picks, persisted, drivePort: meta.drivePort, sessionDir: meta.sessionDir }
}

const report = {
  run_id: randomUUID().slice(0, 8),
  project_id: PROJECT_ID,
  started_at: new Date().toISOString(),
  message: MESSAGE,
  timeline: [],
  cards_answered: [],
  outcome: 'unknown',
}

function log(line) {
  report.timeline.push({ t: new Date().toISOString(), line })
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`)
}

let electronChild = null
let cdp = null

async function cleanup() {
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

try {
  const rec0 = readProjectRecord(PROJECT_ID)
  if (!rec0) throw new Error(`projects.json 无此项目：${PROJECT_ID}`)
  const projectDir = rec0.root_path
  const projectName = rec0.name ?? ''
  log(`目标项目：${projectName}（${rec0.current_stage} / ${rec0.desktop_phase}）`)

  const port = 9600 + Math.floor(Math.random() * 190)
  log(`启动 Bloma（CDP port=${port}）`)
  // 主进程 stdio 落盘（批11.8）：传输层警告留痕（同 dogfood-run）
  const mainLog = openSync(join(REPORT_DIR, 'bloma-main.log'), 'a')
  electronChild = spawn(ELECTRON, ['.', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`], {
    cwd: REPO,
    stdio: ['ignore', mainLog, mainLog],
    detached: false,
  })
  cdp = await Cdp.connect(port, 40_000)
  log('CDP 已连接渲染页')

  let state = null
  for (let i = 0; i < 40; i += 1) {
    state = JSON.parse((await cdp.eval(PAGE_STATE)) ?? '{}')
    if (state.hasTextarea || (state.tail ?? '').includes('项目')) break
    await sleep(1000)
  }

  if (state.upgradeDialog) {
    await cdp.eval(`(() => { const b = document.querySelector('[data-ai-id="upgrade-cancel"]'); if (b) { b.click(); return true } return false })()`)
    log('已关闭升级弹窗')
  }

  // 进入项目历史 → 打开目标项目
  let opened = false
  for (let i = 0; i < 10 && !opened; i += 1) {
    await cdp.eval(`(${CLICK_BUTTON_BY_TEXT})(${JSON.stringify('所有项目')})`)
    await sleep(1500)
    const nameFragment = projectName
    const r = await cdp.eval(`(${CLICK_PROJECT_CARD})(${JSON.stringify(nameFragment)})`)
    if (r?.ok) {
      opened = true
      log(`已打开项目卡片（${r.label}）`)
    } else {
      log(`项目卡片未命中（尝试 ${i + 1}/10，fragment=${nameFragment}）——页面尾迹：${(state.tail ?? '').slice(-120)}`)
    }
    state = JSON.parse((await cdp.eval(PAGE_STATE)) ?? '{}')
    if (state.hasTextarea && state.tail && state.tail.length > 100 && !state.tail.includes('新建项目')) {
      // 已在项目工作区
      break
    }
  }
  if (!opened) throw new Error('未能打开目标项目卡片')

  // 等聊天输入框就绪（项目工作区）
  for (let i = 0; i < 30; i += 1) {
    state = JSON.parse((await cdp.eval(PAGE_STATE)) ?? '{}')
    if (state.hasTextarea) break
    await sleep(1000)
  }
  if (!state?.hasTextarea) throw new Error(`项目工作区输入框未就绪：${(state?.tail ?? '').slice(-400).split(String.fromCharCode(10)).join(' | ')}`)
  await sleep(2500)
  log('项目工作区就绪')

  // 发续跑消息（权威验证：会话 JSONL 含消息尾句）
  const sentAt = Date.now()
  let sent = false
  for (let attempt = 1; attempt <= 3 && !sent; attempt += 1) {
    const r = await cdp.eval(`(${TYPE_AND_SEND})(${JSON.stringify(MESSAGE)})`)
    log(`发送续跑消息（第 ${attempt} 次）：${JSON.stringify(r)}`)
    if (!r?.ok) { await sleep(2000); continue }
    const tail = MESSAGE.slice(-14)
    for (let probe = 0; probe < 10; probe += 1) {
      await sleep(1200)
      try {
        const dir = join(homedir(), '.proma', 'agent-sessions')
        for (const name of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
          const full = join(dir, name)
          const { statSync } = await import('node:fs')
          if (statSync(full).mtimeMs < sentAt) continue
          if (readFileSync(full, 'utf8').includes(tail)) {
            log(`会话落盘验证 OK（${name}）`)
            sent = true
            break
          }
        }
      } catch { /* 重试 */ }
      if (sent) break
    }
    if (!sent) log('消息未落盘，重试')
  }
  if (!sent) throw new Error('续跑消息发送失败（未落盘）')

  // 主循环：应答卡 + 等交付
  const deadline = Date.now() + TIMEOUT_MIN * 60_000
  const cooldown = new Map()
  let mvpRound = 0
  /* MVP 点点看轮（批11.7 移植自 dogfood-run）：只走一轮 */
  let pickRoundDone = false
  let blockedLastLog = 0
  // 假阳性防护（批10.5 审查C P1-2）：目标项目续跑前可能已是 completed（既降级单回炉后
  // 重验场景）——发消息到链路真正接管（状态离开 completed）之间的窗口里，首轮轮询
  // 会命中旧终态假报 delivered。仅当「初始非 completed」或「本轮见过非 completed」
  // 后的 completed 才算真交付（状态跃迁制）。
  const wasInitiallyCompleted = rec0.status === 'completed' && rec0.current_stage === 'completed'
  let seenActive = false

  while (Date.now() < deadline) {
    await sleep(3000)
    state = JSON.parse((await cdp.eval(PAGE_STATE)) ?? '{}')

    if (state.upgradeDialog) {
      await cdp.eval(`(() => { const b = document.querySelector('[data-ai-id="upgrade-cancel"]'); if (b) { b.click(); return true } return false })()`)
      log('关闭升级弹窗')
      continue
    }

    const rec = readProjectRecord(PROJECT_ID)
    if (rec && rec.status !== 'completed') seenActive = true
    if (rec && rec.status === 'completed' && rec.current_stage === 'completed' && (!wasInitiallyCompleted || seenActive)) {
      log(`交付检测命中（权威存储终态）：${PROJECT_ID}`)
      report.outcome = 'delivered'
      // PQ 双轴 + mvp-review 读取
      try {
        const q = JSON.parse(readFileSync(join(projectDir, '00_VERIFY', 'llm-qualification.json'), 'utf8'))
        report.llm_qualification = q
        log(`PQ 结果：executed=${q.executed} qualified=${q.qualified} calls=${q.calls}${q.skipped_reason ? ` skipped=${q.skipped_reason}` : ''}${(q.findings ?? []).length ? ` findings=${JSON.stringify(q.findings).slice(0, 200)}` : ''}`)
      } catch {
        report.llm_qualification = null
        log('llm-qualification.json 不存在（如实记录）')
      }
      try {
        const html = readFileSync(join(projectDir, '00_VERIFY', 'mvp-review.html'), 'utf8')
        report.mvp_review_has_three_sections = ['本版本已确认能做', '目前限制', '给你的建议'].every((kw) => html.includes(kw))
        report.mvp_review_has_shape = html.includes('这是一个')
        log(`mvp-review 三段结构=${report.mvp_review_has_three_sections} 形状段=${report.mvp_review_has_shape}`)
      } catch {
        log('mvp-review.html 不存在（quick 单不生成——如实记录）')
      }
      break
    }
    if (rec && rec.status === 'blocked_for_user_decision' && Date.now() - blockedLastLog > 30_000) {
      blockedLastLog = Date.now()
      log(`项目 blocked（${rec.desktop_phase ?? ''}）——尾迹：${(state.tail ?? '').slice(-140).split(String.fromCharCode(10)).join(' ')}`)
    }

    const enabled = (state.options ?? []).filter((o) => !o.disabled)
    const pick = (id) => enabled.find((o) => o.id === id)
    const overlays = state.overlays ?? {}

    let action = null
    if (overlays.review) {
      const reviewAuto = enabled.find((o) => o.kind === 'review' && (o.id === 'prd_review_delegate_all' || /全部交给|你帮我/.test(o.label)))
      action = { id: '__review_auto', raw: reviewAuto ? reviewAuto.raw : 'review-choice-global-prd_review_delegate_all', why: '内审定夺委托' }
    } else if (overlays.prdConfirm) {
      action = { id: '__prd_submit', raw: 'prd-confirm-submit', why: 'PRD 确认（自动）' }
    } else if (overlays.requirementConfirm) {
      action = { id: '__requirement_submit', raw: 'requirement-confirm-submit', why: '需求清单确认（自动）' }
    } else if (overlays.clarification) {
      const clarifyAuto = enabled.find((o) => o.kind === 'clarify' && (o.id === 'auto' || /你帮我|全部交给/.test(o.label)))
      action = { id: '__clarify_auto', raw: clarifyAuto ? clarifyAuto.raw : 'clarification-option-auto', why: '澄清委托' }
    } else if (pick('ux_confirm_go')) {
      action = { id: 'ux_confirm_go', why: 'UX 草图确认（自动）' }
    } else if (pick('ux_delegate')) {
      action = { id: 'ux_delegate', why: 'UX 委托开工（自动）' }
    } else if (pick('mvp_pick') && !pickRoundDone) {
      pickRoundDone = true
      mvpRound += 1
      log(`MVP 点点看轮（程序化点选链验证）`)
      action = { id: 'mvp_pick', why: 'MVP 点点看（点选纠错链验证轮）', pickFlow: true }
    } else if (pick('mvp_confirm_go') || pick('mvp_adjust')) {
      const p0 = readP0Findings(projectDir)
      if (p0.length === 0) {
        action = { id: 'mvp_confirm_go', why: 'MVP 确认（findings P0=0）' }
      } else if (mvpRound === 0) {
        mvpRound += 1
        action = { id: 'mvp_adjust', why: `MVP 回炉（P0×${p0.length}）`, feedback: `修复探索发现的 P0 问题：${p0.join('；')}。修完重新走验收。` }
        log(`P0×${p0.length} 回炉：${p0.join('；')}`)
      } else {
        report.outcome = 'p0-persisted'
        report.p0_titles = p0
        log(`二轮仍有 P0（${p0.length} 项）——停住出报告`)
        break
      }
    } else {
      const delegate = enabled.find((o) => /你帮我|帮我定|按建议|你定/.test(o.label))
      const chosen = delegate ?? enabled[0]
      if (chosen) action = { id: chosen.id, raw: chosen.raw, why: `卡应答（${delegate ? '委托' : '首选项'}：${chosen.label}）` }
    }

    if (action) {
      const cooldownKey = action.raw ?? action.id
      if (Date.now() - (cooldown.get(cooldownKey) ?? 0) < 12_000) continue
      const clicked = action.raw
        ? await cdp.eval(`(${CLICK_RAW_ANCHOR})(${JSON.stringify(action.raw)})`)
        : await cdp.eval(`(${CLICK_OPTION})(${JSON.stringify(action.id)})`)
      if (clicked?.ok) {
        cooldown.set(cooldownKey, Date.now())
        report.cards_answered.push({ t: new Date().toISOString(), ...action })
        log(`卡应答：${cooldownKey}（${action.why}）`)
        if (action.pickFlow) {
          const flow = await runPickFlow(projectDir)
          report.pick_flow = flow
          if (flow.ok) {
            log(`程序化点选完成：${flow.picks.length} 处，picks.jsonl=${JSON.stringify(flow.persisted)}（drivePort=${flow.drivePort}）`)
            await sleep(4000)
            const fb = await cdp.eval(`(${TYPE_AND_SEND})(${JSON.stringify('点选之外再补一句：标题字号调大一点，整体更清爽。')})`)
            log(`点选后补充反馈发送：${JSON.stringify(fb)}`)
            report.pick_flow.feedback_sent = fb?.ok === true
          } else {
            log(`点选链未就绪（${flow.error}）——退化为纯文字反馈回炉`)
            await sleep(4000)
            await cdp.eval(`(${TYPE_AND_SEND})(${JSON.stringify('把标题字号调大一点，整体更清爽一些。')})`)
          }
          continue
        }
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
    log(`超时（${TIMEOUT_MIN}min）`)
  }
  report.log_tail = state?.tail ?? ''
  report.finished_at = new Date().toISOString()
  writeFileSync(join(REPORT_DIR, 'dogfood-resume-report.json'), JSON.stringify(report, null, 2), 'utf8')
  log(`报告已写 ${join(REPORT_DIR, 'dogfood-resume-report.json')}（outcome=${report.outcome}）`)
  await cleanup()
  process.exit(report.outcome === 'delivered' ? 0 : 1)
} catch (error) {
  log(`致命错误：${error instanceof Error ? error.message : String(error)}`)
  report.outcome = 'error'
  report.error = String(error instanceof Error ? error.message : error)
  report.finished_at = new Date().toISOString()
  try {
    writeFileSync(join(REPORT_DIR, 'dogfood-resume-report.json'), JSON.stringify(report, null, 2), 'utf8')
  } catch {
    // ignore
  }
  await cleanup()
  process.exit(2)
}
