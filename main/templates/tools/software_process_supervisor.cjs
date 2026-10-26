// Lifecycle ownership only, not an OS execution sandbox. EOF means the host died.
const { spawn, execFile } = require('node:child_process')
let child, input = '', received = false, stopping = false
function stop() {
  if (stopping) return
  stopping = true
  if (!child?.pid || child.exitCode !== null) { process.exitCode = 1; process.stdin.destroy(); return }
  if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => { try { child.kill() } catch {} })
  else { try { process.kill(-process.pid, 'SIGTERM') } catch { child.kill() } }
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  if (received) return
  input += chunk
  if (input.length > 1024 * 1024) { process.stderr.write('SUPERVISOR_INPUT_LIMIT'); process.exit(1) }
  const end = input.indexOf('\n')
  if (end < 0) return
  received = true
  try {
    const config = JSON.parse(input.slice(0, end)); input = ''
    child = spawn(config.command[0], config.command.slice(1), { cwd: config.cwd, env: config.env, windowsHide: config.windowsHide!==false, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr)
    child.once('error', error => { process.stderr.write(error.message); process.exit(1) })
    child.once('exit', code => { process.exitCode = code ?? 1; process.stdin.destroy() })
    if (stopping) { stopping = false; stop() }
  } catch (error) { process.stderr.write(error.message); process.exit(1) }
})
process.stdin.on('end', stop)
process.stdin.on('error', stop)
process.stdout.on('error', stop); process.stderr.on('error', stop)
process.on('SIGTERM', stop); process.on('SIGINT', stop)
