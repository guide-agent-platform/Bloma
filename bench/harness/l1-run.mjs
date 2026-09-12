#!/usr/bin/env node
/**
 * bench L1 在线评测通道（P0 Phase 0.3，2026-09-09）。
 *
 * 目标：把 seed 任务卡驱动成「新项目 → 注入需求 → 澄清脚本应答 → PRD 门 → 草图确认
 * → MVP loop → 终态」的完整在线流水线，并采集运行档案（P0 稿 §3/§5）。
 *
 * 通道选择（P0 稿 §3 候选 1，已被 e2e 证明）：
 *  - 复用 tests/e2e/support/electron-fixture.ts 的模式——electron.launch + 独立临时
 *    PROMA_HOME + preload 白名单 window.electronAPI 真 IPC 驱动；
 *  - 断言以磁盘为准（projects.json current_stage / 会话 JSONL 决策行 / analytics.jsonl），
 *    与 real-channel-flow.e2e.ts 同一套判据；
 *  - 采集复用 collector.mjs / metrics.mjs（L0 同源指标，档案可对比）。
 *
 * 与灰度 harness（tests/experiments/grayscale-live.test.ts 直连 main 链）的差异：
 * L1 保留向导澄清/PRD 管线——澄清保真（如随心记蒸馏失败）正是被测对象。
 *
 * 用法：
 *   node bench/harness/l1-run.mjs --seed seed-b-crud-calculator \
 *     [--mode quick|longterm] [--timeout-min 40] [--label b0] [--keep-home] [--dry] [--probe]
 *
 * 环境要求：
 *  - 生产渠道配置 ~/.proma/bloma-channels.json（或 BENCH_CHANNELS 指定副本路径）；
 *    缺失时 fail-fast——降级模板对 L1 无意义。
 *  - 生产 category-routing.json 存在时一并拷入临时 home（M5 职责分工路由；缺失时平台回退
 *    getFirstEnabledChannel，但为保证 B0 与生产路由一致，默认随渠道文件同步拷贝）。
 *  - dist-main 为最新构建（线上跑 dist-main；跑前 npm run build，见架构记忆陷阱 41）。
 *
 * 纪律（bench/README.md）：
 *  - 独立临时 PROMA_HOME，绝不污染生产 ~/.proma；run 结束清理（--keep-home 保留排查）；
 *  - 渠道 key 只经拷贝进入临时 home，档案只记渠道指纹不记 key。
 */

import { _electron } from 'playwright'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectArtifacts, collectAssistantIntegrity, collectDocuments, collectSession, paths, readProjectIndex, summarizeAnalytics } from './collector.mjs'
import { computeExtendedMetrics, computeFlags, computeProjectMetrics } from './metrics.mjs'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const seedsDir = join(repoRoot, 'bench', 'tasks')
const runsRoot = join(repoRoot, 'bench', 'runs')

const TERMINAL_STAGES = new Set(['ready', 'completed'])
const POLL_INTERVAL_MS = 2_500

// ---------------------------------------------------------------- CLI ----

function parseArgs(argv) {
  const out = { seed: '', mode: 'quick', timeoutMin: 40, label: '', keepHome: false, dry: false, probe: false, promptsDir: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--seed') out.seed = argv[++i] ?? ''
    else if (a === '--mode') out.mode = argv[++i] ?? 'quick'
    else if (a === '--timeout-min') out.timeoutMin = Number(argv[++i] ?? 40)
    else if (a === '--label') out.label = argv[++i] ?? ''
    else if (a === '--keep-home') out.keepHome = true
    else if (a === '--dry') out.dry = true
    else if (a === '--probe') out.probe = true
    else if (a === '--prompts-dir') out.promptsDir = argv[++i] ?? ''
    else { console.error(`未知参数：${a}`); process.exit(2) }
  }
  if (!['quick', 'longterm'].includes(out.mode)) { console.error('--mode 仅支持 quick|longterm'); process.exit(2) }
  return out
}

// ---------------------------------------------------------------- seed ----

function loadSeed(seedId) {
  // seed-v0（主基准）+ seed-regress（Phase 1 回归案例）；都要求 frozen 才可作在线基准
  const decks = ['seed-v0.json', 'seed-regress.json']
    .map((name) => join(seedsDir, name))
    .filter(existsSync)
    .map((file) => JSON.parse(readFileSync(file, 'utf8')))
  for (const deck of decks) {
    const seed = deck.seeds.find((s) => s.id === seedId)
    if (!seed) continue
    if (!deck.frozen) { console.error(`${seedId} 所在任务卡未冻结（frozen!=true），不得作在线回归基准`); process.exit(2) }
    if (seed.manualOnly) { console.error(`${seedId} 标 manualOnly（迭代/人工场景），L1 不支持自动跑`); process.exit(2) }
    seed.script = (seed.clarificationPath || [])
      .map((line) => String(line).replace(/^user:\s*/, '').split('（')[0].trim())
      .filter(Boolean)
    return seed
  }
  console.error(`seed 不存在：${seedId}（可选：${decks.flatMap((d) => d.seeds.map((s) => s.id)).join(', ')}）`)
  process.exit(2)
}

// ------------------------------------------------------------ 会话轮询 ----

function readJsonLines(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean)
}

/**
 * 解析会话 JSONL 里的决策待办。以 [decision] JSON 行为权威（[decision-card] 裸文本行只是
 * 展示载体，如需求确认弹窗的行实为需求列表预览，不是选项）：
 *  - clarification_card → 澄清卡（options 从 detail.options 读）
 *  - prd_review / prd_confirm → PRD 审查退回 / 确认门
 *  - requirement_confirm_card / clarification_forced_confirm → 需求确认弹窗（独立 IPC confirmRequirements）
 * 其余 type（category_route/clarification_answer/…）为信息记录，不构成待办。
 */
function readPendingDecisions(sessionFile) {
  const cards = []
  for (const [index, entry] of readJsonLines(sessionFile).entries()) {
    if (entry.role !== 'system') continue
    for (const block of entry.content ?? []) {
      const text = block?.type === 'text' && typeof block.text === 'string' ? block.text : ''
      if (!text.startsWith('[decision] ')) continue
      let inner
      try { inner = JSON.parse(text.slice('[decision] '.length)) } catch { continue }
      const base = { line: index, timestamp: entry.timestamp || 0, fingerprint: `${inner.type}@${entry.timestamp || index}`, options: [] }
      if (inner.type === 'clarification_card') cards.push({ ...base, kind: 'clarification', options: Array.isArray(inner.detail?.options) ? inner.detail.options.map(String) : [] })
      else if (inner.type === 'enrichment_clarification_requested') {
        // 加厚追问（PRD 定稿前信息缺口，一次一道；requests[0].options 为 {id,label} 对象数组）
        const first = Array.isArray(inner.detail?.requests) ? inner.detail.requests[0] : null
        const labels = (Array.isArray(first?.options) ? first.options : [])
          .map((o) => (typeof o === 'string' ? o : String(o?.label ?? o?.description ?? '')).trim())
          .filter(Boolean)
        cards.push({ ...base, kind: 'enrichment_clarification', options: labels })
      }
      else if (inner.type === 'prd_review') cards.push({ ...base, kind: 'prd_review' })
      else if (inner.type === 'prd_confirm') cards.push({ ...base, kind: 'prd_confirm' })
      else if (inner.type === 'requirement_confirm_card' || inner.type === 'clarification_forced_confirm') cards.push({ ...base, kind: 'requirement_confirm' })
    }
  }
  return cards
}

/** 按 seed 脚本匹配澄清选项：互为子串/方向词命中；失配回退首个非让渡选项；耗尽选让渡。 */
function pickClarificationOption(card, script, scriptCursor) {
  if (scriptCursor < script.length) {
    const wanted = script[scriptCursor]
    const hit = card.options.find((label) => label.includes(wanted) || wanted.includes(label))
    if (hit && !hit.includes('帮我决定')) return { label: hit, mode: 'script-hit' }
    const first = card.options.find((label) => !label.includes('帮我决定'))
    if (first) return { label: first, mode: 'script-fallback' }
  }
  const auto = card.options.find((label) => label.includes('帮我决定'))
  return { label: auto ?? card.options[0] ?? '你帮我决定', mode: scriptCursor < script.length ? 'script-exhausted-auto' : 'auto' }
}

// ------------------------------------------------------------ 磁盘读取 ----

function readProject(promaHome, projectId) {
  const index = readProjectIndex(promaHome)
  return index.find((p) => p.id === projectId) ?? null
}

function findProjectRoot(promaHome, projectId) {
  const file = join(promaHome, 'projects.json')
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const entry = (Array.isArray(raw) ? raw : raw.projects || []).find((p) => p.project_id === projectId)
    return entry?.root_path ?? null
  } catch { return null }
}

function sha1File(file) {
  return createHash('sha1').update(readFileSync(file)).digest('hex').slice(0, 12)
}

/** 产物目录清单 + hash（P0 稿 §5 artifacts.sha；只记可判读证据，不复制内容）。 */
function hashArtifacts(root) {
  const out = []
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      const st = statSync(abs)
      if (st.isDirectory()) walk(abs, rel)
      else out.push({ path: rel, bytes: st.size, sha1: sha1File(abs) })
    }
  }
  walk(root, '')
  return out
}

// ------------------------------------------------------------ 采集落盘 ----

function buildEvidence(promaHome, projectId, sessionId) {
  const p = paths(promaHome)
  const analyticsEvents = readJsonLines(join(p.workspace, 'analytics.jsonl'))
    .filter((e) => e.project_id === projectId || e.payload?.project_id === projectId)
  const project = readProject(promaHome, projectId)
  const projectRoot = findProjectRoot(promaHome, projectId)
  // 与 scan.mjs 同构：analytics 为 collector 摘要对象（L0/L1 指标同口径）+ 指标扩容数据源
  return {
    project,
    session: collectSession(sessionId, promaHome),
    docs: collectDocuments(projectId, promaHome),
    analytics: summarizeAnalytics(analyticsEvents, projectId),
    artifacts: collectArtifacts(projectRoot),
    assistantIntegrity: collectAssistantIntegrity(sessionId, promaHome),
    analyticsEvents,
  }
}

function writeRunArchive(runDir, payload) {
  mkdirSync(runDir, { recursive: true })
  for (const [name, data] of Object.entries(payload)) {
    writeFileSync(join(runDir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
  }
}

// ------------------------------------------------------------ 渠道 key 注入 ----

/**
 * 在生产 userData（Roaming/bloma）上下文解密渠道 key（陷阱 45：safeStorage 密文绑定
 * userData 路径，L1 临时 userData 解不开生产密文）。复用 scripts/channel-key-reader.cjs
 * （独立 Electron 短进程，即刻退出）；明文只落临时文件，用后即删（seed-channel 纪律）。
 * 返回 Map<id前8位, apiKey>。
 */
function decryptProdChannelKeys(channelsSrc) {
  const prodUserData = process.env.BENCH_PROD_USER_DATA || join(process.env.APPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Roaming'), 'bloma')
  if (!existsSync(prodUserData)) {
    throw new Error(`生产 userData 不存在：${prodUserData}（可用 BENCH_PROD_USER_DATA 指定；密文需在生产上下文解密）`)
  }
  const keyFile = join(tmpdir(), `bloma-bench-keys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
  const electronBin = join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
  try {
    execSync(`"${electronBin}" scripts/channel-key-reader.cjs "${channelsSrc}" "${keyFile}" "${prodUserData}"`, { cwd: repoRoot, stdio: 'pipe', timeout: 60_000 })
  } catch (error) {
    throw new Error(`channel-key-reader 执行失败：${String(error.message).slice(0, 300)}`)
  }
  if (!existsSync(keyFile)) throw new Error('channel-key-reader 未产出 key 文件（解密全部失败？）')
  const raw = JSON.parse(readFileSync(keyFile, 'utf8'))
  rmSync(keyFile, { force: true })
  const byShortId = new Map()
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('id:') && value?.apiKey) byShortId.set(key.slice(3), value.apiKey)
  }
  if (byShortId.size === 0) throw new Error(`无渠道解密成功：${Object.keys(raw).join(', ')}（生产密文可能已失效，需在 Bloma 设置页重存）`)
  return byShortId
}

/** L1 实例内重存 key：updateChannel 对非空 api_key 会用当前进程 safeStorage 重新加密。 */
async function injectChannelKeys(page, keysByShortId) {
  const result = await page.evaluate(async (input) => {
    const api = window.electronAPI
    const list = await api.channels.list({ request_id: 'bench-l1-key-inject' })
    const channels = list.ok && list.data ? list.data : []
    const injected = []
    for (const c of channels) {
      const plain = input.keys[c.id.slice(0, 8)]
      if (!plain) { injected.push({ id: c.id, name: c.name, injected: false, reason: 'no-key' }); continue }
      const outer = await api.channels.update({ request_id: `bench-l1-key-${c.id.slice(0, 8)}`, channel_id: c.id, input: { api_key: plain } })
      injected.push({ id: c.id, name: c.name, injected: !!outer?.ok })
    }
    return injected
  }, { keys: Object.fromEntries(keysByShortId) })
  const failed = result.filter((r) => !r.injected)
  if (failed.length > 0) console.error(`[l1] 渠道 key 注入未遂：${failed.map((f) => f.name).join(', ')}`)
  return result.filter((r) => r.injected).length
}

// ------------------------------------------------------------ 单实例锁（2026-09-09 双跑事故根治）----
// 与 l1-batch 的进程检测互补：那是批跑器启动前拦，这是 l1-run 自身运行期锁
// （进程检测有盲区：非 node 子进程/权限差异；文件锁是底层保险）。
const LOCK_FILE = join(repoRoot, 'bench', 'runs', '.l1-lock')
const LOCK_STALE_MS = 50 * 60_000 // 40min 超时 + 余量；超过视为残留接管

function acquireL1Lock() {
  mkdirSync(dirname(LOCK_FILE), { recursive: true })
  if (existsSync(LOCK_FILE)) {
    let info = null
    try { info = JSON.parse(readFileSync(LOCK_FILE, 'utf8')) } catch { /* 坏锁视同残留 */ }
    const age = info?.startedAt ? Date.now() - info.startedAt : Infinity
    if (age < LOCK_STALE_MS) {
      console.error(`[l1] 已有 L1 run 在跑（pid=${info?.pid ?? '?'}，${Math.round(age / 60000)} 分钟前启动）——防双跑拒启；确信无人跑可删 ${LOCK_FILE}`)
      process.exit(3)
    }
    console.warn(`[l1] 锁为陈旧残留（${Math.round(age / 60000)} 分钟），接管`)
  }
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
  // exit 钩子覆盖所有退出路径（正常 finally 后/抛错/早退 process.exit）；SIGKILL 不及释放时靠陈旧接管
  process.on('exit', () => {
    try {
      const current = JSON.parse(readFileSync(LOCK_FILE, 'utf8'))
      if (current?.pid === process.pid) rmSync(LOCK_FILE, { force: true })
    } catch { /* 已被接管或不存在：不动 */ }
  })
}

// ------------------------------------------------------------ 主流程 ----

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const seed = loadSeed(args.seed)
  const channelsSrc = process.env.BENCH_CHANNELS || join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.proma', 'bloma-channels.json')
  if (!existsSync(channelsSrc)) {
    console.error(`渠道配置缺失：${channelsSrc}（L1 走真实 LLM，无渠道则 fail-fast；可用 BENCH_CHANNELS 指定副本）`)
    process.exit(2)
  }
  acquireL1Lock()

  const gitCommit = (() => {
    try { return execSync('git rev-parse HEAD', { cwd: repoRoot }).toString().trim() } catch { return 'unknown' }
  })()
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}${args.label ? `-${args.label}` : ''}`
  const promaHome = mkdtempSync(join(tmpdir(), 'bloma-bench-l1-'))
  const runDir = join(runsRoot, seed.id, runId)
  const audit = []
  const log = (event) => { audit.push({ t: new Date().toISOString(), ...event }); console.log(`[l1] ${event.event}${event.detail ? `｜${event.detail}` : ''}`) }

  log({ event: 'boot', detail: `seed=${seed.id} mode=${args.mode} home=${promaHome}` })
  copyFileSync(channelsSrc, join(promaHome, 'bloma-channels.json'))
  // M5 职责分工路由随渠道同步（生产有则拷，保证 B0 与生产路由一致；平台对缺失回退 getFirstEnabledChannel）
  const routingSrc = join(dirname(channelsSrc), 'category-routing.json')
  if (existsSync(routingSrc)) { copyFileSync(routingSrc, join(promaHome, 'category-routing.json')); log({ event: 'routing-copied' }) }
  // A/B 支持：--prompts-dir 指定外置覆盖目录（如 BLOMA/phase1-overrides/），拷入临时
  // home 的 prompts/（全量替换语义，文件存在即生效）——不指定时不拷（=内置默认）
  if (args.promptsDir) {
    if (!existsSync(args.promptsDir)) { console.error(`--prompts-dir 不存在：${args.promptsDir}`); process.exit(2) }
    const dest = join(promaHome, 'prompts')
    mkdirSync(dest, { recursive: true })
    for (const f of readdirSync(args.promptsDir)) {
      if (f.endsWith('.md')) copyFileSync(join(args.promptsDir, f), join(dest, f))
    }
    log({ event: 'prompts-copied', detail: `${args.promptsDir}` })
  }
  // 渠道 key 预解（生产 userData 上下文）：启动 Electron 前完成，失败早暴露
  const keysByShortId = decryptProdChannelKeys(channelsSrc)
  log({ event: 'keys-decrypted', detail: `${keysByShortId.size} 渠道` })

  if (args.dry) {
    console.log('--dry：仅校验环境（seed/渠道/构建产物），不启动 Electron')
    console.log(`seed=${seed.id} script=${JSON.stringify(seed.script)} channels=${channelsSrc}`)
    process.exit(0)
  }

  const app = await _electron.launch({
    args: [`.`, `--user-data-dir=${join(promaHome, 'electron-user-data')}`],
    cwd: repoRoot,
    env: { ...process.env, PROMA_HOME: promaHome },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // 主进程 stdout/stderr 收集（渠道解析失败等原因只进主进程日志，real-channel 同款）
  const mainLogs = []
  const child = app.process()
  const collect = (chunk) => { mainLogs.push(String(chunk)); if (mainLogs.length > 600) mainLogs.shift() }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  const dumpMainLogs = (tag) => { mkdirSync(runDir, { recursive: true }); writeFileSync(join(runDir, 'main.log'), `[${tag}]
${mainLogs.join('')}`); console.error(`[l1] 主进程日志已落 ${join(runDir, 'main.log')}`) }
  log({ event: 'electron-up' })

  // 渠道 key 注入：L1 实例重存明文（当前实例 safeStorage 加密，后续可解）
  const injectedCount = await injectChannelKeys(page, keysByShortId)
  log({ event: 'keys-injected', detail: `${injectedCount} 渠道` })

  if (args.probe) {
    const report = await page.evaluate(async () => {
      const api = window.electronAPI
      const list = await api.channels.list({ request_id: 'bench-l1-probe' })
      const channels = list.ok && list.data ? list.data : []
      const tests = []
      for (const c of channels.filter((x) => x.enabled)) {
        const outer = await api.channels.test({ request_id: `bench-l1-probe-${c.id}`, channel_id: c.id })
        tests.push({ id: c.id, name: c.name, ok: outer?.data?.ok ?? outer?.ok ?? null, message: String(outer?.data?.message ?? '').slice(0, 200) })
      }
      return { channels: channels.map((c) => ({ id: c.id, name: c.name, enabled: c.enabled })), tests }
    })
    console.log(JSON.stringify(report, null, 2))
    if (report.tests.some((t) => t.ok !== true)) dumpMainLogs('probe')
    await app.close().catch(() => undefined)
    if (!args.keepHome) rmSync(promaHome, { recursive: true, force: true })
    process.exit(report.tests.some((t) => t.ok === true) ? 0 : 3)
  }

  const sessionId = `bench-l1-${Date.now()}`
  let scriptCursor = 0
  const answeredFingerprints = new Set()
  let sketchConfirmed = false
  let terminal = null

  try {
    // ① 建项目 + 注入原始需求（保真：seed.requirement[0] 原文）
    const created = await page.evaluate(async (input) => {
      const api = window.electronAPI
      const result = await api.project.create({ request_id: 'bench-l1-create', mode: input.mode, initial_message: input.initial })
      if (!result.ok || !result.data) throw new Error(`project.create failed: ${JSON.stringify(result).slice(0, 300)}`)
      return { projectId: result.data.project_id }
    }, { mode: args.mode, initial: seed.requirement[0] })
    const projectId = created.projectId
    log({ event: 'project-created', detail: `id=${projectId}` })

    await page.evaluate(async (input) => {
      const api = window.electronAPI
      const result = await api.agent.sendMessage({
        request_id: `bench-l1-send-0`, session_id: input.sessionId, project_id: input.projectId,
        content: input.content, mode: input.mode, current_stage: 'clarifying',
      })
      if (!result.ok) throw new Error(`sendMessage failed: ${JSON.stringify(result).slice(0, 300)}`)
    }, { sessionId, projectId, content: seed.requirement[0], mode: args.mode })
    log({ event: 'requirement-injected', detail: seed.requirement[0].slice(0, 40) })

    // ② 状态机主循环：轮询磁盘 → 按待办决策应答 → 至终态或超时
    const deadline = Date.now() + args.timeoutMin * 60_000
    const stallMs = 5 * 60_000 // 无进展上限：阶段/卡片/应答均无变化判 stalled（防 blocked 无卡挂满超时）
    let lastStage = ''
    let lastProgressAt = Date.now()
    const touchProgress = () => { lastProgressAt = Date.now() }
    while (!terminal && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      const stage = readProject(promaHome, projectId)?.stage ?? ''
      if (stage && stage !== lastStage) { log({ event: 'stage', detail: stage }); lastStage = stage; touchProgress() }

      if (TERMINAL_STAGES.has(stage)) { terminal = { kind: 'converged', stage }; break }

      // 草图就绪 → 确认（sketch_ready 不出决策卡，走 IPC 确认门）
      if (stage === 'sketch_ready' && !sketchConfirmed) {
        const snapshotId = (() => {
          const file = join(promaHome, 'projects.json')
          const raw = JSON.parse(readFileSync(file, 'utf8'))
          return String((Array.isArray(raw) ? raw : raw.projects || []).find((p) => p.project_id === projectId)?.current_snapshot_id ?? '')
        })()
        await page.evaluate(async (input) => {
          const api = window.electronAPI
          const result = await api.project.confirmSketch({
            request_id: 'bench-l1-confirm-sketch', project_id: input.projectId, session_id: input.sessionId,
            snapshot_id: input.snapshotId, decision: 'accepted',
          })
          if (!result.ok) throw new Error(`confirmSketch failed: ${JSON.stringify(result).slice(0, 300)}`)
        }, { projectId, sessionId, snapshotId })
        sketchConfirmed = true
        log({ event: 'sketch-confirmed', detail: `snapshot=${snapshotId.slice(0, 8)}` })
        continue
      }

      // 决策卡只在与用户交互阶段应答；生成中阶段（generating_mvp/testing/judge_review/
      // repairing/upgrading/iterating）的卡可能是管线副产物/历史重放，磁碰会 AGENT_PROJECT_BUSY
      const GENERATING_STAGES = new Set(['generating_mvp', 'testing', 'judge_review', 'repairing', 'upgrading', 'iterating', 'generating_sketch'])
      if (GENERATING_STAGES.has(stage)) continue

      // 决策卡待办（取最后一张未答的）
      const sessionFile = join(promaHome, 'agent-sessions', `${sessionId}.jsonl`)
      const pending = readPendingDecisions(sessionFile).filter((c) => !answeredFingerprints.has(c.fingerprint))
      if (pending.length === 0) {
        if (Date.now() - lastProgressAt > stallMs) terminal = { kind: 'stalled', stage: lastStage }
        continue
      }
      touchProgress()
      const card = pending[pending.length - 1]
      answeredFingerprints.add(card.fingerprint)

      const sendGuarded = async (fn, tag) => {
        try {
          await fn()
        } catch (error) {
          const message = String(error?.message ?? error)
          if (message.includes('AGENT_PROJECT_BUSY')) {
            // 项目忙（上一链路收尾中）：不致命，等下一轮再试——把该卡从已答集合退回
            answeredFingerprints.delete(card.fingerprint)
            log({ event: 'busy-retry', detail: `${tag}：项目忙，待重试` })
            await new Promise((r) => setTimeout(r, 10_000))
          } else {
            throw error
          }
        }
      }

      if (card.kind === 'clarification') {
        const pick = pickClarificationOption(card, seed.script, scriptCursor)
        if (pick.mode.startsWith('script')) scriptCursor += 1
        await sendGuarded(() => page.evaluate(async (input) => {
          const api = window.electronAPI
          const result = await api.agent.sendMessage({
            request_id: `bench-l1-answer-${input.seq}`, session_id: input.sessionId, project_id: input.projectId,
            content: input.content, mode: input.mode, current_stage: 'blocked_for_user_decision',
            metadata: { source: 'card_option', selected_option_id: `bench-answer-${input.seq}` },
          })
          if (!result.ok) throw new Error(`sendMessage(card) failed: ${JSON.stringify(result).slice(0, 300)}`)
        }, { seq: answeredFingerprints.size, sessionId, projectId, content: pick.label, mode: args.mode }), 'clarification')
        log({ event: 'clarification-answered', detail: `${pick.mode}：「${pick.label.slice(0, 30)}」` })
      } else if (card.kind === 'enrichment_clarification') {
        // 加厚追问：普通 sendMessage + 专用 option id（ClarificationCard 同协议）；
        // 脚本用户行为=选首个候选；无候选时让渡（按常见做法整理）
        const answer = card.options.find((o) => !o.includes('帮我') && !o.includes('你来')) ?? card.options[0] ?? '你来定，按常见做法整理'
        if (!answer || answer === '[object Object]') throw new Error('enrichment 追问选项解析异常（[object Object]）')
        await sendGuarded(() => page.evaluate(async (input) => {
          const api = window.electronAPI
          const result = await api.agent.sendMessage({
            request_id: `bench-l1-enrich-${input.seq}`, session_id: input.sessionId, project_id: input.projectId,
            content: input.content, mode: input.mode, current_stage: 'blocked_for_user_decision',
            metadata: { source: 'card_option', selected_option_id: 'enrichment_clarification_answer' },
          })
          if (!result.ok) throw new Error(`sendMessage(enrichment) failed: ${JSON.stringify(result).slice(0, 300)}`)
        }, { seq: answeredFingerprints.size, sessionId, projectId, content: answer, mode: args.mode }), 'enrichment_clarification')
        log({ event: 'enrichment-answered', detail: `「${answer.slice(0, 30)}」` })
      } else if (card.kind === 'requirement_confirm') {
        // 需求确认弹窗：独立 IPC（decision=confirm 全量勾选，脚本用户合理行为）；确认后进 PRD 管线
        await sendGuarded(() => page.evaluate(async (input) => {
          const api = window.electronAPI
          const result = await api.agent.confirmRequirements({
            request_id: 'bench-l1-req-confirm', session_id: input.sessionId, project_id: input.projectId,
            decision: 'confirm',
          })
          if (!result.ok) throw new Error(`confirmRequirements failed: ${JSON.stringify(result).slice(0, 300)}`)
        }, { sessionId, projectId }), 'requirement_confirm')
        log({ event: 'requirement-confirmed', detail: card.fingerprint.slice(0, 60) })
      } else if (card.kind === 'prd_review') {
        await sendGuarded(() => page.evaluate(async (input) => {
          const api = window.electronAPI
          const result = await api.agent.sendMessage({
            request_id: 'bench-l1-review-override', session_id: input.sessionId, project_id: input.projectId,
            content: '忽略问题，继续生成', mode: input.mode, current_stage: 'blocked_for_user_decision',
            metadata: { source: 'card_option', selected_option_id: 'prd_review_override' },
          })
          if (!result.ok) throw new Error(`sendMessage(override) failed: ${JSON.stringify(result).slice(0, 300)}`)
        }, { sessionId, projectId, mode: args.mode }), 'prd_review')
        log({ event: 'prd-review-overridden', detail: card.fingerprint.slice(0, 60) })
      } else if (card.kind === 'prd_confirm') {
        await sendGuarded(() => page.evaluate(async (input) => {
          const api = window.electronAPI
          const result = await api.agent.sendMessage({
            request_id: 'bench-l1-prd-confirm', session_id: input.sessionId, project_id: input.projectId,
            content: '确认这份 PRD，开始画草图。', mode: input.mode, current_stage: 'blocked_for_user_decision',
            metadata: { source: 'card_option', selected_option_id: 'prd_confirm_confirm' },
          })
          if (!result.ok) throw new Error(`sendMessage(confirm) failed: ${JSON.stringify(result).slice(0, 300)}`)
        }, { sessionId, projectId, mode: args.mode }), 'prd_confirm')
        log({ event: 'prd-confirmed', detail: card.fingerprint.slice(0, 60) })
      }
    }

    if (!terminal) terminal = { kind: 'timeout', stage: lastStage }

    // ③ 停沙箱 + 采集（终态后尽快定格证据，再关应用）
    try {
      await page.evaluate(async (pid) => {
        await window.electronAPI?.sandbox?.stop?.({ request_id: `bench-l1-stop-${pid}`, project_id: pid })
      }, projectId)
    } catch { /* 沙箱未起时无副作用 */ }

    const evidence = buildEvidence(promaHome, projectId, sessionId)
    evidence.terminal = terminal
    const projectRootDir = findProjectRoot(promaHome, projectId)
    const artifacts = projectRootDir && existsSync(projectRootDir) ? hashArtifacts(projectRootDir) : []
    const channelsFingerprint = (() => {
      const raw = JSON.parse(readFileSync(join(promaHome, 'bloma-channels.json'), 'utf8'))
      return (raw.channels || []).map((c) => `${c.id}:${(c.models || []).map((m) => m.id).join('+')}`).join(';').slice(0, 200)
    })()

    writeRunArchive(runDir, {
      'manifest.json': {
        seed: seed.id, mode: args.mode, label: args.label, terminal, gitCommit,
        promaHome: args.keepHome ? promaHome : '(cleaned)', sessionId, projectId,
        startedAt: audit[0]?.t, finishedAt: new Date().toISOString(),
        timeoutMin: args.timeoutMin,
        env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('BLOMA_'))),
        channels: channelsFingerprint,
      },
      'run.log': audit.map((e) => `${e.t} ${e.event}${e.detail ? `｜${e.detail}` : ''}`).join('\n'),
      'evidence.json': evidence,
      'metrics.json': { flags: computeFlags(evidence), metrics: computeProjectMetrics(evidence), extended: computeExtendedMetrics(evidence) },
      'events.jsonl': (evidence.analyticsEvents || []).map((e) => JSON.stringify(e)).join('\n'),
      'session-raw.jsonl': existsSync(join(promaHome, 'agent-sessions', `${sessionId}.jsonl`))
        ? readFileSync(join(promaHome, 'agent-sessions', `${sessionId}.jsonl`), 'utf8') : '(missing)',
      'artifacts.sha': { root: projectRootDir, files: artifacts },
    })

    const s = evidence.analytics
    const ext = computeExtendedMetrics(evidence)
    console.log('\n===== L1 run 摘要 =====')
    console.log(`seed=${seed.id} terminal=${terminal.kind}@${terminal.stage}`)
    console.log(`turns=${s.lastLoopTurns ?? '-'} tools=${s.totalToolCalls ?? '-'} repairs=${s.repairRounds} mvpDelivered=${s.mvpDelivered}`)
    console.log(`testCompleted=${s.testCompleted ? `${s.testCompleted.round}:${s.testCompleted.total ?? '?'}total/${s.testCompleted.failed}failed` : 'none'}`)
    console.log(`capRetention=${ext.coreCapabilityRetention} leak=${ext.protocolLeakRate.toFixed(3)} empty=${ext.emptyBodyRate.toFixed(3)} violation=${ext.firstConstraintViolation.violated ? 'YES' : 'no'} tokens=${ext.effectiveDeliveryTokens ?? '-'}`)
    console.log(`archive=${runDir}`)
  } finally {
    await app.close().catch(() => undefined)
    if (mainLogs.length > 0) { mkdirSync(runDir, { recursive: true }); writeFileSync(join(runDir, 'main.log'), mainLogs.join('')) }
    if (!args.keepHome) rmSync(promaHome, { recursive: true, force: true })
    else console.log(`[l1] --keep-home：${promaHome}`)
  }
}

main().catch((error) => { console.error('[l1] FATAL', error); process.exit(1) })
