#!/usr/bin/env node
/**
 * scheduled-grayscale.mjs — Bloma 经验库夜间健康探针（灰度定时入口）
 *
 * 全闭环无人值守：
 *   1. electron channel-key-reader 解出渠道明文 key → 临时 key 文件（finally 必删）
 *   2. spawn vitest 跑 tests/experiments/grayscale-live.test.ts（真链真 LLM；
 *      临时 PROMA_HOME，绝不影响生产配置；样本经 GS_SAMPLE_JSON 注入）
 *   3. 解析 stdout 拿到本次 temp home 与逐样本结果
 *   4. 账本合并：temp home bloma-experience.jsonl → 真实 ~/.proma/bloma-experience.jsonl
 *      （同指纹折叠：occurrences 相加、seen_projects 并集、recurrence=参与项目数——
 *      与服务层 experience-service 口径一致）
 *   5. 历史行追加 ~/.proma/bloma-grayscale-history.jsonl（趋势/审计用）
 *
 * 用法：node scripts/scheduled-grayscale.mjs [--samples S1,S3] [--budget-min 50]
 * 依赖路径默认本机（--channels/--userdata 可覆盖）。退出码 0=成功（含熔断样例——
 * 熔断是真实终态不是探针失败），1=链路故障（key/账本/解析失败）。
 */
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const argVal = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const SAMPLES_SEL = argVal('samples', 'S1').split(',').map((s) => s.trim().toUpperCase())
const BUDGET_MS = Number(argVal('budget-min', '50')) * 60_000
const CHANNELS = argVal('channels', join(homedir(), '.proma', 'bloma-channels.json'))
const USERDATA = argVal('userdata', join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'bloma'))
const REAL_LEDGER = join(homedir(), '.proma', 'bloma-experience.jsonl')
const HISTORY = join(homedir(), '.proma', 'bloma-grayscale-history.jsonl')
const KEY_FILE = join(REPO, '.gs-key-live.tmp.json')

/** 灰度样本库（断言粒度=行为断言，源自 workbench plan/grayscale-samples.md） */
const SAMPLES = {
  S1: { name: 'S1-记账小工具', requirements: [
    { id: 'F-001', description: '记录收入与支出', behavior_assertions: ['点击添加后，新记录立即出现在列表中'], priority: 'P0' },
    { id: 'F-002', description: '按关键字搜索历史记录', behavior_assertions: ['在搜索框输入关键字时，列表只显示包含该关键字的记录'], priority: 'P0' }] },
  S2: { name: 'S2-番茄钟', requirements: [
    { id: 'F-001', description: '开始按钮启动 25 分钟倒计时', behavior_assertions: ['点击开始后倒计时秒数开始逐秒减少'], priority: 'P0' },
    { id: 'F-002', description: '可随时暂停与继续', behavior_assertions: ['点击暂停后秒数不再变化，点击继续后恢复减少'], priority: 'P0' },
    { id: 'F-003', description: '到点提醒', behavior_assertions: ['倒计时归零时页面出现明显的完成提示'], priority: 'P0' }] },
  S3: { name: 'S3-打字落字母游戏', requirements: [
    { id: 'F-001', description: '字母从顶部下落', behavior_assertions: ['游戏开始后画面出现下落的字母元素'], priority: 'P0' },
    { id: 'F-002', description: '按对应键得分', behavior_assertions: ['按下屏幕上存在的字母键后得分增加且该字母消失'], priority: 'P0' },
    { id: 'F-003', description: '字母落到底部判输', behavior_assertions: ['字母到达底部后出现失败提示'], priority: 'P0' }] },
  S4: { name: 'S4-摄影作品展示页', requirements: [
    { id: 'F-001', description: '图片网格展示作品', behavior_assertions: ['页面加载后可见多个作品缩略图排成网格'], priority: 'P0' },
    { id: 'F-002', description: '点开看大图', behavior_assertions: ['点击缩略图后出现放大的图片视图'], priority: 'P0' }] },
}

const log = (...a) => console.log(`[gs-script ${new Date().toISOString().slice(11, 19)}]`, ...a)

function readLedger(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
}

/** 同指纹折叠（occurrences 相加、seen_projects 并集、recurrence=参与项目数）。 */
function mergeCards(base, incoming) {
  const byFp = new Map()
  for (const c of [...base, ...incoming]) {
    const prev = byFp.get(c.fingerprint)
    if (!prev) {
      byFp.set(c.fingerprint, { ...c, seen_projects: [...new Set(c.seen_projects || [])] })
    } else {
      prev.occurrences = (prev.occurrences || 1) + (c.occurrences || 1)
      prev.seen_projects = [...new Set([...(prev.seen_projects || []), ...(c.seen_projects || [])])]
      prev.recurrence = Math.max(prev.recurrence || 0, prev.seen_projects.length)
      if ((c.last_seen_at || 0) > (prev.last_seen_at || 0)) prev.last_seen_at = c.last_seen_at
    }
  }
  return [...byFp.values()]
}

async function main() {
  // 1. key（electron 一次性 reader，DPAPI 解密）
  if (!existsSync(CHANNELS)) throw new Error(`渠道文件不存在：${CHANNELS}`)
  rmSync(KEY_FILE, { force: true })
  execFileSync(process.execPath,
    [join(REPO, 'node_modules', 'electron', 'cli.js'), join(REPO, 'scripts', 'channel-key-reader.cjs'),
      CHANNELS, KEY_FILE, USERDATA],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 })
  if (!existsSync(KEY_FILE)) throw new Error('key reader 未产出文件（safeStorage 不可用？渠道未配置？）')
  const keyJson = JSON.parse(readFileSync(KEY_FILE, 'utf8'))
  const entry = Object.entries(keyJson).find(([, v]) => v && v.apiKey)
  if (!entry) throw new Error('key reader 产物无可用 apiKey')
  log('key 就绪（渠道:', entry[0], '——明文从不落日志）')

  // 2. vitest harness（样本注入）
  const selected = SAMPLES_SEL.map((s) => SAMPLES[s]).filter(Boolean)
  if (selected.length === 0) throw new Error(`--samples 无有效样本（可选 ${Object.keys(SAMPLES).join('/')}）`)
  log(`跑样本: ${selected.map((s) => s.name).join(', ')}`)
  const outLines = []
  const code = await new Promise((res) => {
    const child = spawn(process.execPath, [join(REPO, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'tests/experiments/grayscale-live.test.ts'], {
      cwd: REPO,
      env: { ...process.env, GS_KEY_FILE: KEY_FILE, GS_SAMPLE_JSON: JSON.stringify(selected), BLOMA_EXPERIENCE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const grab = (buf) => { const t = String(buf); outLines.push(t); process.stdout.write(t.replace(/^/gm, '  | ')) }
    child.stdout.on('data', grab)
    child.stderr.on('data', grab)
    const timer = setTimeout(() => { log('预算耗尽，杀 vitest 树'); child.kill('SIGKILL') }, BUDGET_MS)
    child.on('exit', (c2) => { clearTimeout(timer); res(c2 ?? 1) })
  })
  log('harness 退出码', code)

  // 3. 解析 temp home + 样本收束行
  const blob = outLines.join('')
  const homeM = blob.match(/headless 环境就绪 home=\s*(\S+)/)
  const doneLines = [...blob.matchAll(/样本收束 name=(\S+) verdict=(\S+) cards=(\d+)/g)].map((m) => ({ name: m[1], verdict: m[2], cards: Number(m[3]) }))
  if (!homeM) throw new Error('未解析到 temp home（harness 可能在 beforeAll 前崩）')
  const tempLedger = join(homeM[1], 'bloma-experience.jsonl')

  // 4. 并入真实账本（key 文件先删——合并失败也不能留密钥）
  rmSync(KEY_FILE, { force: true })
  const incoming = existsSync(tempLedger) ? readLedger(tempLedger) : []
  const base = readLedger(REAL_LEDGER)
  const baseFps = new Set(base.map((c) => c.fingerprint))
  const merged = mergeCards(base, incoming)
  const newFps = incoming.filter((c) => !baseFps.has(c.fingerprint)).length
  writeFileSync(REAL_LEDGER, merged.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8')
  log(`账本合并：新增指纹 ${newFps}，总行数 ${merged.length}`)

  // 5. 历史行
  appendFileSync(HISTORY, JSON.stringify({
    ts: Date.now(), iso: new Date().toISOString(), samples: doneLines,
    cards_incoming: incoming.length, cards_new: newFps, ledger_total: merged.length,
    harness_exit: code, temp_home: homeM[1],
  }) + '\n', 'utf8')
  log('完成。历史已写', HISTORY)
  if (!doneLines.length) throw new Error('harness 无任何样本收束（跑挂/超时）')
}

main().catch((e) => {
  rmSync(KEY_FILE, { force: true })
  console.error('[gs-script] FAIL:', e.message)
  process.exit(1)
})
