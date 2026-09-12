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
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const argVal = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const SAMPLES_SEL = argVal('samples', 'S1').split(',').map((s) => s.trim().toUpperCase())
// AUTO=轮换模式：按历史计数在样本库内循环选取 1 个（夜间探针长期不重样）
function resolveSelection(samples) {
  if (!SAMPLES_SEL.includes('AUTO')) return SAMPLES_SEL
  let n = 0
  try { n = Number(readFileSync(ROTATE_IDX, 'utf8').trim()) || 0 } catch {}
  const ids = Object.keys(samples)
  if (!ids.length) return []
  const pick = ids[n % ids.length]
  try { writeFileSync(ROTATE_IDX, String(n + 1), 'utf8') } catch {}
  log(`AUTO 轮换：计数 ${n} → 选中 ${pick}`)
  return [pick]
}
const BUDGET_MS = Number(argVal('budget-min', '50')) * 60_000
const CHANNELS = argVal('channels', join(homedir(), '.proma', 'bloma-channels.json'))
const USERDATA = argVal('userdata', join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'bloma'))
const REAL_LEDGER = join(homedir(), '.proma', 'bloma-experience.jsonl')
const HISTORY = join(homedir(), '.proma', 'bloma-grayscale-history.jsonl')
const KEY_FILE = join(REPO, '.gs-key-live.tmp.json')
const CONFIG_FILE = join(REPO, 'scripts', 'grayscale-config.json')
const HOME_MARK = join(REPO, '.gs-home.mark')
const RESULT_MARK = join(REPO, '.gs-result.mark')
const SAMPLES_FILE = join(REPO, 'scripts', 'grayscale-samples.json')
const ROTATE_IDX = join(homedir(), '.proma', 'bloma-grayscale-rotate.idx')

/** 内置兜底样本（外部 JSON 样本库读不到时用；主源永远是 scripts/grayscale-samples.json，
 *  定时轮换任务只追加 JSON 不改代码） */
const BUILTIN_SAMPLES = {
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

/** 样本库加载：外置 JSON 为准（合并覆盖内置），读失败退回内置。 */
function loadSamples() {
  const merged = { ...BUILTIN_SAMPLES }
  try {
    const j = JSON.parse(readFileSync(SAMPLES_FILE, 'utf8'))
    for (const [id, s] of Object.entries(j.samples || {})) {
      if (s && s.name && Array.isArray(s.requirements) && s.requirements.length > 0) merged[id] = s
    }
  } catch (e) {
    log('样本库 JSON 不可读（退回内置）:', String(e).slice(0, 60))
  }
  return merged
}
const SAMPLES = loadSamples()

const log = (...a) => writeSync(1, `[gs-script ${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}
`)

if (args.includes('--list')) {
  for (const [id, s] of Object.entries(SAMPLES)) console.log(id, s.name, `(${s.requirements.length} 项)`, s.source || '')
  process.exit(0)
}

function readLedger(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
}

/** 同指纹折叠（occurrences 相加、seen_projects 并集、recurrence=参与项目数）。
 * 先按 id 归并取最新快照行（服务层状态变更=追加行非原地改，同卡多行是常态），
 * 避免把同轮次的 candidate/verified 快照重复计入 occurrences（灰度 S56 实弹发现的口径 bug）。 */
function mergeCards(base, incoming) {
  const latestById = (cards) => {
    const byId = new Map()
    for (const c of cards) {
      const prev = byId.get(c.id)
      if (!prev || (c.updated_at || 0) >= (prev.updated_at || 0)) byId.set(c.id, c)
    }
    return [...byId.values()]
  }
  const byFp = new Map()
  for (const c of [...latestById(base), ...latestById(incoming)]) {
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
  let fileCfg = {}
  try { fileCfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) } catch {}
  const wantChannel = argVal('channel', fileCfg.channel || '')
  const wantModel = argVal('model', fileCfg.model || '')
  let entry = wantChannel ? Object.entries(keyJson).find(([k, v]) => k === wantChannel && v && v.apiKey) : null
  if (!entry) entry = Object.entries(keyJson).find(([k, v]) => !k.startsWith('id:') && v && v.apiKey)
  if (!entry) throw new Error('key reader 产物无可用 apiKey')
  log(`key 就绪（渠道: ${entry[0]}${wantModel ? ' | 模型: ' + wantModel : ''}——明文从不落日志）`)

  // 2. vitest harness（样本注入）
  const selected = resolveSelection(SAMPLES).map((s) => SAMPLES[s]).filter(Boolean)
  if (selected.length === 0) throw new Error(`--samples 无有效样本（可选 ${Object.keys(SAMPLES).join('/')}）`)
  log(`跑样本: ${selected.map((s) => s.name).join(', ')}`)
  rmSync(HOME_MARK, { force: true }); rmSync(RESULT_MARK, { force: true })
  const code = await new Promise((res) => {
    const child = spawn(process.execPath, [join(REPO, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'tests/experiments/grayscale-live.test.ts'], {
      cwd: REPO,
      env: { ...process.env, GS_KEY_FILE: KEY_FILE, GS_SAMPLE_JSON: JSON.stringify(selected), BLOMA_EXPERIENCE: '1', GS_HOME_MARK: HOME_MARK, GS_RESULT_MARK: RESULT_MARK, GS_CHANNEL: entry[0], ...(wantModel ? { GS_MODEL: wantModel } : {}) },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    // 心跳：每 60s 报已完成样本数（mark 文件行数），卡死与否一眼可判
    const beat = setInterval(() => {
      let done = 0
      try { done = readFileSync(RESULT_MARK, 'utf8').split(/\r?\n/).filter(Boolean).length } catch {}
      log(`心跳：样本完成 ${done}/${selected.length}`)
    }, 60_000)
    const timer = setTimeout(() => { log('预算耗尽，杀 vitest 树'); child.kill('SIGKILL') }, BUDGET_MS)
    child.on('exit', (c2) => { clearInterval(beat); clearTimeout(timer); res(c2 ?? 1) })
  })
  log('harness 退出码', code)

  // 3. 读标记文件（不走 stdout：管道缓冲不可靠）
  let tempHome = ''
  try { tempHome = readFileSync(HOME_MARK, 'utf8').trim() } catch {}
  const doneLines = existsSync(RESULT_MARK)
    ? readFileSync(RESULT_MARK, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    : []
  if (!tempHome) throw new Error('未读到 temp home 标记（harness 可能在 beforeAll 前崩）')
  const tempLedger = join(tempHome, 'bloma-experience.jsonl')

  // 4. 并入真实账本（key 文件先删——合并失败也不能留密钥）
  rmSync(KEY_FILE, { force: true })
  const incoming = existsSync(tempLedger) ? readLedger(tempLedger) : []
  const base = readLedger(REAL_LEDGER)
  const baseFps = new Set(base.map((c) => c.fingerprint))
  const merged = mergeCards(base, incoming)
  const newFps = incoming.filter((c) => !baseFps.has(c.fingerprint)).length
  writeFileSync(REAL_LEDGER, merged.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8')
  log(`账本合并：新增指纹 ${newFps}，总行数 ${merged.length}`)

  // 4.5 产物独立可用性检验（第三方视角交叉验证 verdict：熔断≠产物不可用，
  //     GWT 断言关键词字面化会误伤真实可用的实现——2026-09-07 S9–S11 实弹实证）
  const artifactVerdicts = []
  for (const d of doneLines) {
    if (!d.projectId) continue
    const adir = join(tempHome, 'agent-workspaces', 'default-software-builder', 'generated-projects', d.projectId)
    if (!existsSync(join(adir, 'index.html'))) { artifactVerdicts.push({ name: d.name, artifact: 'NO_ARTIFACT' }); continue }
    try {
      const out = execFileSync(process.execPath, [join(REPO, 'scripts', 'verify-artifact.mjs'), adir, join(REPO, `.gs-verify-${d.projectId.slice(0, 8)}`)], { cwd: REPO, timeout: 90_000, encoding: 'utf8' })
      const v = JSON.parse(out.slice(out.indexOf('{'))).verdict
      artifactVerdicts.push({ name: d.name, artifact: v })
      log(`产物检验 ${d.name}: ${v}（流水线 verdict=${d.verdict}）`)
    } catch (e) {
      // verify 退出码 2=有错误信号（stdout 仍含 verdict），其余按 BROKEN
      const out = String(e.stdout || '')
      const m = /"verdict":\s*"([A-Z_]+)"/.exec(out)
      artifactVerdicts.push({ name: d.name, artifact: m ? m[1] : 'VERIFY_FAILED' })
    }
  }

  // 5. 历史行
  appendFileSync(HISTORY, JSON.stringify({
    ts: Date.now(), iso: new Date().toISOString(), samples: doneLines, artifacts: artifactVerdicts,
    cards_incoming: incoming.length, cards_new: newFps, ledger_total: merged.length,
    harness_exit: code, temp_home: tempHome,
  }) + '\n', 'utf8')
  log('完成。历史已写', HISTORY)
  if (!doneLines.length) throw new Error('harness 无任何样本收束（跑挂/超时）')
}

main().catch((e) => {
  rmSync(KEY_FILE, { force: true })
  console.error('[gs-script] FAIL:', e.message)
  process.exit(1)
})
