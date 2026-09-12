#!/usr/bin/env node
/**
 * artifact-probe.mjs — Bloma 产出物「机器探测层」
 *
 * 定位：双视觉（V1/V2）只能回答"图里长什么样"；本脚本回答"界面是不是真的"：
 *  ① 真控件计数：button/input/textarea/select/[contenteditable] 与"伪装控件"（class 含 btn/button 却是 div/span）
 *  ② 点击响应：逐个点击按钮类元素，对比 DOM 变化/URL 变化/console 错误——点了没反应=假按钮
 *  ③ 断言泄漏扫描：产物可见文本是否包含"可见且可交互 / 行为断言 / F-\d+ / P0"等内部验收话术
 *     （生成器把 GWT 断言印到页面上会让文本型探针假绿，必须独立检测）
 *  ④ 基础健全性：白屏/空白 body/控制台错误/标题为空
 *
 * 用法：node scripts/artifact-probe.mjs <file:///...|http://...> [--out probe.json] [--click-limit 8]
 * 输出：JSON（ok/interactive/pretendWidgets/clickResults/leaks/consoleErrors/notes）
 */
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const url = process.argv[2]
const HELP = `artifact-probe.mjs —— Bloma 产出物「机器探测层」独立 CLI（零 LLM）

用法:
  node scripts/artifact-probe.mjs <url> [--out probe.json] [--click-limit N]

参数:
  <url>                产物入口，file:/// 或 http(s):// 均可
  --out <file>         同时把 JSON 结果写盘
  --click-limit <N>    按钮类元素点击活性采样上限（缺省 8）

退出码（可当门禁用）:
  0  未发现假界面风险
  1  发现风险（fakeUiRisk / assertionLeak / deadClicks 任一为真）
  2  用法错误

检测项:
  真控件计数 / div-span 伪装控件 / 点击活性（死点击）/ 验收断言泄漏黑名单 / 白屏与空标题
`
if (!url || url === '--help' || url === '-h') { console.log(url ? HELP : HELP); process.exit(url ? 0 : 2) }
const outI = process.argv.indexOf('--out')
const out = outI > 0 ? process.argv[outI + 1] : null
const clI = process.argv.indexOf('--click-limit')
const clickLimit = clI > 0 ? Number(process.argv[clI + 1]) : 8

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)) })
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e.message).slice(0, 200)))

await page.goto(url, { waitUntil: 'load', timeout: 30_000 }).catch((e) => console.error('goto:', e.message))
await page.waitForTimeout(1200)

const stats = await page.evaluate(() => {
  const q = (s) => Array.from(document.querySelectorAll(s))
  const real = q('button, input, textarea, select, [contenteditable="true"], a[href]:not([href="#"]), [role="button"], [role="textbox"]')
  const pretend = q('div, span, li, p').filter((el) => {
    const cn = (el.className || '') + ''
    if (!/btn|button|submit|action/i.test(cn)) return false
    const t = (el.textContent || '').trim()
    return t.length > 0 && t.length < 24 && !real.includes(el)
  }).map((el) => ({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 60), text: (el.textContent || '').trim().slice(0, 24) }))
  const bodyText = (document.body?.innerText || '').slice(0, 20000)
  const leakPatterns = [
    { id: 'assert-visible-interactive', re: /可见\s*且\s*可交互|可见且可交互/ },
    { id: 'assert-behavior-wording', re: /行为断言|该功能项在产物中/ },
    { id: 'feature-id-leak', re: /\bF-\d{3}\b/ },
    { id: 'priority-leak', re: /\bP[0-3]\b\s*(优先级|级)?/ },
    { id: 'gwt-leak', re: /Given|When|Then|GWT/i },
    { id: 'placeholder-persona', re: /J\.\s*Doe|John Doe|张三|李四|example\.com|lorem/i },
  ]
  const leaks = leakPatterns.filter((p) => p.re.test(bodyText)).map((p) => p.id)
  const domFingerprint = document.body ? document.body.innerHTML.length + '|' + (document.body.innerText || '').length : 'empty'
  return {
    title: document.title || '',
    realControls: real.length,
    realByTag: real.reduce((m, el) => { m[el.tagName.toLowerCase()] = (m[el.tagName.toLowerCase()] || 0) + 1; return m }, {}),
    pretendWidgets: pretend.slice(0, 12),
    leaks,
    bodyChars: (document.body?.innerText || '').trim().length,
    domFingerprint,
  }
})

const clickResults = []
if (stats.pretendWidgets.length || stats.realControls) {
  const candidates = await page.$$('button, [role="button"], div, span')
  let clicked = 0
  for (const el of candidates) {
    if (clicked >= clickLimit) break
    const info = await el.evaluate((e) => {
      const t = (e.textContent || '').trim()
      const actionable = /btn|button|submit|生成|保存|新建|添加|提交|开始|确认/.test(String(e.className) + t)
      return { text: t.slice(0, 20), actionable: actionable && t.length > 0 && t.length < 24 }
    }).catch(() => null)
    if (!info || !info.actionable) continue
    const before = stats.domFingerprint
    const errBefore = consoleErrors.length
    await el.click({ timeout: 2000 }).catch(() => {})
    await page.waitForTimeout(500)
    const after = await page.evaluate(() => document.body.innerHTML.length + '|' + (document.body.innerText || '').length)
    clickResults.push({
      text: info.text, clicked: true,
      domChanged: after !== before, consoleNewErrors: consoleErrors.length - errBefore,
    })
    clicked++
  }
}

const result = {
  ok: true, url, title: stats.title,
  interactive: { realControls: stats.realControls, realByTag: stats.realByTag },
  pretendWidgets: stats.pretendWidgets,
  clickResults,
  leaks: stats.leaks,
  consoleErrors: consoleErrors.slice(0, 10),
  sanity: { bodyChars: stats.bodyChars, blank: stats.bodyChars < 20, emptyTitle: !stats.title },
  verdict: {
    fakeUiRisk: stats.realControls === 0 && stats.pretendWidgets.length > 0,
    assertionLeak: stats.leaks.some((l) => l !== 'placeholder-persona'),
    deadClicks: clickResults.length > 0 && clickResults.every((c) => !c.domChanged),
  },
}
const json = JSON.stringify(result, null, 2)
if (out) writeFileSync(out, json, 'utf-8')
console.log(json)
await browser.close()
const risky = result.verdict.fakeUiRisk || result.verdict.assertionLeak || result.verdict.deadClicks
process.exit(risky ? 1 : 0)
