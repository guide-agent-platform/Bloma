// Close only a test browser explicitly identified by its isolated-driver log.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, relative, join } from 'node:path'
const [logPath, notePath] = process.argv.slice(2)
const artifacts = resolve('run-artifacts')
for (const file of [logPath, notePath]) {
  if (!file || relative(artifacts, resolve(file)).startsWith('..')) throw new Error('Test artifact paths required')
}
const log = readFileSync(logPath, 'utf8')
const match = /启动 Bloma（CDP port=(\d+)，隔离 home）/.exec(log)
if (!match) throw new Error('No explicitly isolated test browser in the log')
const port = Number(match[1])
if (port < 9600 || port > 9789) throw new Error('Not a dogfood test port')
const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) })
const info = await response.json()
const url = new URL(info.webSocketDebuggerUrl)
if (url.hostname !== '127.0.0.1' || Number(url.port) !== port) throw new Error('Unexpected debugger endpoint')
await new Promise((resolveClose, reject) => {
  const ws = new WebSocket(url)
  const timer = setTimeout(() => { ws.close(); reject(new Error('Test close timed out')) }, 5000)
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
  ws.onclose = () => { clearTimeout(timer); resolveClose() }
  ws.onerror = () => { clearTimeout(timer); reject(new Error('Test close failed')) }
})
writeFileSync(notePath, JSON.stringify({ at: new Date().toISOString(), isolated_browser_closed: true,
  reason: 'Pilot reached initial time limit; generation had already stopped with unverified core evidence.',
  protocol_deviation: 'Legacy driver injected sketch feedback and extended its timer; fixed-case mode removes both.',
}, null, 2))
console.log('Closed the explicitly isolated pilot browser; primary instance untouched')
