/**
 * J7 案例台账扫描（P7-0，2026-09-11，只读）。
 * 只扫 bloma-agent-sessions.json 索引登记的 Bloma 会话（与 Proma 主应用同目录混存，
 * 须按索引区分），找用户指正信号：输出 会话/时间/项目/原文（截断）——供逐例复盘。
 * 用法：node bench/harness/j7-scan.mjs [--out bench/reports/j7-hits.json]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const home = join(homedir(), '.proma')
const index = JSON.parse(readFileSync(join(home, 'bloma-agent-sessions.json'), 'utf8'))
const projectsJson = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8'))
const projectNameOf = new Map((projectsJson.projects ?? []).map((p) => [p.project_id, p.name ?? p.project_id.slice(0, 8)]))

// 指正信号词（用户指出货不对板/不能用/没做到——主观不满的直接表达）
const PATTERNS = [
  /用不了/, /不能用/, /没法用/, /不可用/,
  /不对啊?/, /不是这[个种]/, /不是我要/, /错了/, /搞错/, /货不对板/,
  /还是不行/, /还是没/, /又不行/, /怎么还不/, /怎么又不/, /怎么还/,
  /没解决/, /没修好/, /没做好/, /没有做/, /没实现/, /没加上/, /没有加/, /没生成/, /没出来/,
  /没效果/, /没变化/, /没反应/, /一片空白/, /打不开/, /点不动/, /点不/,
  /怎么回事/, /白做了/, /浪费/,
  /刷新后.*(没|不|丢)/, /(数据|记录|内容).*(丢|没了|不见)/,
  /你(说|刚说|前面说).{0,20}(但|可是|结果|实际)/, /说好.{0,12}(没|不)/,
  /假装/, /假的/, /根本没.{0,6}(调|连|查)/,
]

// 排除：内部行/机器行（决策卡/系统前缀/steer 包裹——只看真人输入文本）
const NOISE = /^\[|<local-command|<command|^协作子任务/

const out = []
for (const session of index.sessions ?? []) {
  const file = session.jsonl_path
  let lines
  try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean) } catch { continue }
  const hits = []
  let firstUserText = ''
  for (const line of lines) {
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.role !== 'user') continue
    if ((e.content ?? []).some((b) => b && b.type === 'tool_result')) continue
    const text = (e.content ?? []).filter((b) => b && b.type === 'text').map((b) => b.text ?? '').join(' ')
    if (!text) continue
    if (!firstUserText && !NOISE.test(text)) firstUserText = text.slice(0, 60)
    if (NOISE.test(text)) continue
    for (const re of PATTERNS) {
      if (re.test(text)) { hits.push({ ts: e.timestamp, text: text.slice(0, 240), matched: String(re) }); break }
    }
  }
  if (hits.length > 0) {
    out.push({
      file: file.split('\\').pop().split('/').pop(),
      project: projectNameOf.get(session.project_id) ?? session.project_id?.slice(0, 8),
      firstUserText,
      hits,
    })
  }
}

const outIdx = process.argv.indexOf('--out')
if (outIdx >= 0) writeFileSync(process.argv[outIdx + 1], JSON.stringify(out, null, 1), 'utf8')
console.log(`Bloma 会话 ${index.sessions?.length ?? 0}，命中 ${out.length} 个会话、共 ${out.reduce((n, s) => n + s.hits.length, 0)} 条指正信号`)
for (const s of out) {
  console.log(`\n### ${s.file.slice(0, 8)} [${s.project}] 首条:「${s.firstUserText}」`)
  for (const h of s.hits.slice(0, 8)) console.log(`  [${new Date(h.ts).toISOString().slice(0, 16)}] ${h.text.slice(0, 160).replace(/\n/g, ' ')}`)
}
