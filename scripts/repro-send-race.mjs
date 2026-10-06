#!/usr/bin/env node
/**
 * repro-send-race — 会话消息截断/改写竞态复现器（2026-10-06 测试工作链 v2 组件）。
 *
 * 事故（当日四次狗粮三次实锤）：完整需求经 UI 发送后，会话 JSONL 里的 user 消息
 * 只剩第一个空格前的片段（「做一个」）；其中一次发送后 3 秒文件里还有全文、随后
 * 消失——疑似持久化后被改写。会话写入路径（appendSessionMessage）是 append-only，
 * 代码考古找不到改写者——本脚本用仪器复现：盯住 agent-sessions 每次字节级变化。
 *
 * 流程：启动 Bloma(CDP) → 新建项目(深度) → 3s 稳定 → 发送带标记消息 →
 * 45s 内每 200ms 快照全部 mtime>sentAt 的会话文件（大小/行数/首条 user 长度/
 * 尾标记命中）→ 打印写入序列与判定。不答卡（只测消息链路）。
 *
 * 用法：node scripts/repro-send-race.mjs [轮次序号]
 */

import { spawn, execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const REPO = 'C:/Users/17359/OneDrive/Desktop/guide-agent-platform-sprint0'
const SESSIONS_DIR = join(homedir(), '.proma', 'agent-sessions')
const ROUND = process.argv[2] ?? '1'
const MARKER = `MARKER${Date.now().toString(36).toUpperCase()}`
// 与事故同型的消息：短首段 + 半角空格 + 长尾
const MESSAGE = `做一个 Windows 桌面健身训练记录器（单机版，数据存本地，标记${MARKER}）：管理训练动作库（名称/部位/器械），支持增删改查和搜索；制定周训练计划（按天安排动作与目标组数）；记录每次训练的实际完成情况（动作/组数/次数/重量），录入时选择动作自动带出计划目标；统计视图：按周和按月查看总训练量与各部位训练分布，显示连续训练天数；支持 CSV 导入导出全部数据；所有数据本地持久化${MARKER}END`
const PORT = 9800 + Math.floor(Math.random() * 100)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
const log = (line) => console.log(`[${ts()}] ${line}`)

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
            const timer = setTimeout(() => rej(new Error('ws-timeout')), 5_000)
            ws.addEventListener('open', () => { clearTimeout(timer); res() })
            ws.addEventListener('error', () => { clearTimeout(timer); rej(new Error('ws-error')) })
          })
          return new Cdp(ws)
        }
      } catch { /* 未就绪 */ }
      await sleep(700)
    }
    throw new Error(`CDP 连接超时 port=${port}`)
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
    return result?.result?.value
  }
}

const PAGE_STATE = `(() => ({
  hasTextarea: !!document.querySelector('textarea'),
  hasHistoryEntry: !!document.querySelector('[data-ai-id="project-history-entry"]'),
  hasNewButton: !!document.querySelector('[data-ai-id="new-project-button"]'),
  tail: (document.body.innerText || '').slice(-200),
}))()`
const CLICK = (sel) => `(() => { const el = document.querySelector('${sel}'); if (el) { el.click(); return true } return false })()`

/** 会话文件快照：每行 {file, size, lines, firstUserLen, markerHit}。 */
function snapshotSessions(sinceMs) {
  const snaps = []
  try {
    for (const name of readdirSync(SESSIONS_DIR).filter((n) => n.endsWith('.jsonl'))) {
      const full = join(SESSIONS_DIR, name)
      const st = statSync(full)
      if (st.mtimeMs < sinceMs) continue
      let lines = 0
      let firstUserLen = -1
      let markerHit = false
      try {
        const raw = readFileSync(full, 'utf8')
        lines = raw.split('\n').filter(Boolean).length
        markerHit = raw.includes(MARKER)
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            if (msg.role === 'user') {
              const text = typeof msg.content === 'string' ? msg.content
                : Array.isArray(msg.content) ? msg.content.filter((b) => b && typeof b.text === 'string').map((b) => b.text).join(' ') : ''
              firstUserLen = text.length
              break
            }
          } catch { /* 坏行 */ }
        }
      } catch { /* 读取竞态 */ }
      snaps.push({ name: name.slice(0, 8), size: st.size, lines, firstUserLen, markerHit })
    }
  } catch { /* 目录读取竞态 */ }
  return snaps
}

const snapKey = (snaps) => snaps.map((s) => `${s.name}:${s.size}:${s.lines}:${s.firstUserLen}:${s.markerHit ? 1 : 0}`).join(' | ')

let electronChild = null
try {
  // 双开守卫
  try {
    const out = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'electron.exe\'\\" | Where-Object { $_.CommandLine -like \'*guide-agent-platform-sprint0*\' } | Select-Object -ExpandProperty ProcessId"', { encoding: 'utf8' })
    if (out.trim()) { console.error('[repro] Bloma 已在运行，先关闭'); process.exit(3) }
  } catch { /* 无实例 */ }

  log(`轮次 ${ROUND} · 标记 ${MARKER} · 启动 Bloma（port=${PORT}）`)
  electronChild = spawn(join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${PORT}`], { cwd: REPO, stdio: 'ignore', detached: false })
  const cdp = await Cdp.connect(PORT, 40_000)
  log('CDP 已连接')

  // 等驾驶面
  let state = null
  for (let i = 0; i < 40; i++) {
    state = await cdp.eval(PAGE_STATE)
    if (i % 5 === 0) log(`页面状态：${JSON.stringify(state)?.slice(0, 200)}`)
    if (state?.hasTextarea) break
    await sleep(1000)
  }
  if (!state?.hasTextarea) throw new Error('驾驶面未就绪')
  log('驾驶面就绪')

  // fresh start（与 dogfood-run 同款选择器）：所有项目 → 新建项目 → 深度项目卡
  const CLICKByText = `(text) => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const hit = buttons.find((b) => (b.textContent || '').trim() === text) || buttons.find((b) => ((b.textContent || '').trim()).includes(text))
    if (!hit) return { ok: false, err: 'not-found' }
    if (hit.disabled) return { ok: false, err: 'disabled' }
    hit.click()
    return { ok: true }
  }`
  for (let i = 0; i < 10; i += 1) {
    const r = await cdp.eval(`(${CLICKByText})(${JSON.stringify('所有项目')})`)
    if (r?.ok) { log('已进入项目历史页'); break }
    await sleep(1000)
  }
  await sleep(1500)
  let freshOk = false
  for (let i = 0; i < 8; i += 1) {
    const r = await cdp.eval(`(${CLICKByText})(${JSON.stringify('新建项目')})`)
    if (r?.ok) { freshOk = true; log('已点「新建项目」'); break }
    await sleep(1000)
  }
  if (!freshOk) log('「新建项目」未找到（可能已在新会话，继续）')
  await sleep(2000)
  let modeClicked = false
  for (let i = 0; i < 8; i += 1) {
    const r = await cdp.eval(`(() => { const el = document.querySelector('[data-ai-id="mode-card-longterm"]'); if (!el) return { ok: false, err: 'not-found' }; el.click(); return { ok: true } })()`)
    if (r?.ok) { modeClicked = true; log('已选「深度项目」'); break }
    await sleep(1000)
  }
  if (!modeClicked) throw new Error('模式卡未找到——不发消息（防止误发进旧项目）')
  await sleep(3000)
  // 新会话 textarea 就绪
  for (let i = 0; i < 20; i++) {
    state = await cdp.eval(PAGE_STATE)
    if (state?.hasTextarea) break
    await sleep(1000)
  }
  if (!state?.hasTextarea) throw new Error('新会话未就绪')
  log('聊天视图就绪（3s 稳定等待完成）')

  // 发送（与 driver 同法：原生 setter + input + 回读 + 按钮）
  // 对照实验（2026-10-06 差异锁定）：狗粮失败轮都在发送后点过卡——点一次卡看会不会触发改写
  const sentAt = Date.now()
  const sendResult = await cdp.eval(`(async (text) => {
    const ta = document.querySelector('textarea')
    if (!ta) return { ok: false, err: 'no-textarea' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 300))
    if (ta.value !== text) return { ok: false, err: 'value-mismatch', got: ta.value.length }
    const btn = document.querySelector('button[aria-label="发送消息"]')
    if (btn && !btn.disabled) { btn.click(); await new Promise((r) => setTimeout(r, 400)); return { ok: true, via: 'button' } }
    return { ok: false, err: 'no-button' }
  })(${JSON.stringify(MESSAGE)})`)
  log(`发送：${JSON.stringify(sendResult)}`)

  // DOM 侧乐观渲染检查（发送后 1s）
  await sleep(1000)
  const domCheck = await cdp.eval(`(() => ({ transcriptHasMarker: (document.body.innerText||'').includes(${JSON.stringify(MARKER)}), taValue: (document.querySelector('textarea')?.value ?? '').slice(0, 20) }))()`)
  log(`DOM 乐观渲染：${JSON.stringify(domCheck)}`)

  // 对照实验 + 仪器观测（交错单循环，90s）：每 500ms 快照；在 t≈8/25/45s 各点一张卡
  // （复刻狗粮连点序列：卡委托 + 澄清×2——怀疑澄清流 enrichment 触发 user 消息改写）
  let lastKey = ''
  let transitions = 0
  const finalStates = new Map()
  const cardAt = [16, 50, 90]
  let cardDone = 0
  for (let i = 0; i < 180; i += 1) {
    if (cardDone < cardAt.length && i >= cardAt[cardDone]) {
      const r = await cdp.eval(`(() => { const b = document.querySelector('[data-ai-id="card-option-auto"], [data-ai-id="clarification-option-auto"]'); if (b && !b.disabled) { b.click(); return { ok: true, id: b.getAttribute('data-ai-id') } } return { ok: false } })()`)
      log(`卡应答 #${cardDone + 1}：${JSON.stringify(r)}`)
      cardDone += 1
    }
    const snaps = snapshotSessions(sentAt - 2000)
    const key = snapKey(snaps)
    if (key !== lastKey) {
      transitions += 1
      log(`会话快照 #${transitions}：${snaps.length ? snapKey(snaps) : '（无新会话）'}`)
      lastKey = key
    }
    for (const s of snaps) finalStates.set(s.name, s)
    await sleep(500)
  }

  // 判定
  const verdicts = [...finalStates.values()].map((s) => `${s.name} lines=${s.lines} firstUserLen=${s.firstUserLen} marker=${s.markerHit ? 'HIT' : 'MISS'}`)
  log(`=== 判定（轮次 ${ROUND}）===`)
  verdicts.forEach((v) => console.log('  ' + v))
  const anyHit = [...finalStates.values()].some((s) => s.markerHit)
  const truncated = [...finalStates.values()].some((s) => s.firstUserLen >= 0 && s.firstUserLen < 10 && !s.markerHit)
  console.log(`  结论：${anyHit ? '全文保住' : truncated ? '截断（首段丢失）' : '未见会话/未定'} · 转移次数 ${transitions}`)
  await Promise.race([cdp.send('Browser.close'), sleep(3000)])
} catch (error) {
  console.error(`[repro] 失败：${error?.message ?? error}`)
  process.exitCode = 1
} finally {
  await sleep(1200)
  if (electronChild?.pid) {
    try { execSync(`taskkill /PID ${electronChild.pid} /T /F`, { stdio: 'ignore' }) } catch { /* 已退出 */ }
  }
}
