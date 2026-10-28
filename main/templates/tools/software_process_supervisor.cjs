// Lifecycle ownership only, not an OS execution sandbox. EOF means the host died.
const { spawn, execFile } = require('node:child_process')
let child, input = '', received = false, stopping = false, interactive = false
function stop() {
  if (stopping) return
  stopping = true
  if (!child?.pid || child.exitCode !== null) { process.exitCode = 1; process.stdin.destroy(); return }
  if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => { try { child.kill() } catch {} })
  else { try { process.kill(-process.pid, 'SIGTERM') } catch { child.kill() } }
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  input += chunk
  if (input.length > 1024 * 1024) { process.stderr.write('SUPERVISOR_INPUT_LIMIT'); stop(); return }
  let end
  while ((end = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, end); input = input.slice(end + 1)
  try {
    const config = JSON.parse(line)
    if (received) {
      if (!interactive || config.type !== 'stdin' || typeof config.data !== 'string' || config.data.length > 90000 || typeof config.close !== 'boolean') throw Error('SUPERVISOR_INPUT_INVALID')
      const data = Buffer.from(config.data, 'base64')
      if (data.length > 65536) throw Error('SUPERVISOR_INPUT_LIMIT')
      if (!child?.stdin || child.stdin.destroyed || child.stdin.writableEnded) continue
      if (data.length) child.stdin.write(data)
      if (config.close) child.stdin.end()
      continue
    }
    received = true; interactive = config.interactive === true
    child = spawn(config.command[0], config.command.slice(1), { cwd: config.cwd, env: config.env, windowsHide: config.windowsHide!==false, stdio: [interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    child.stdin?.on('error', () => {})
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr)
    child.once('error', error => { process.stderr.write(error.message); process.exit(1) })
    child.once('exit', code => { process.exitCode = code ?? 1; process.stdin.destroy() })
    if (stopping) { stopping = false; stop() }
  } catch (error) { process.stderr.write(error.message); stop() }
  }
})
process.stdin.on('end', stop)
process.stdin.on('error', stop)
process.stdout.on('error', stop); process.stderr.on('error', stop)
process.on('SIGTERM', stop); process.on('SIGINT', stop)
