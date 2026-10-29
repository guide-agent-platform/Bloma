// Product-side bridge to the project's prepared Python provider. No platform
// IPC/key access and no microphone; import files into APP_DATA_DIR first.
const { spawn, execFile } = require('node:child_process')
const { isAbsolute, join } = require('node:path')
let active = 0
exports.transcribeWav = function transcribeWav(file, options = {}) {
  const python = process.env.BLOMA_SPEECH_PYTHON, timeout = options.timeoutMs ?? 90000
  const dataDir = options.dataDir ?? process.env.APP_DATA_DIR
  if (!python || !isAbsolute(python) || typeof file !== 'string' || !Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120000)
    return Promise.reject(Error('ASR_PREPARED_PYTHON_AND_WAV_REQUIRED'))
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir)) return Promise.reject(Error('ASR_DATA_DIR_REQUIRED'))
  if (options.signal?.aborted) return Promise.reject(Error('ASR_CANCELLED'))
  if (active >= 2) return Promise.reject(Error('ASR_BUSY'))
  return new Promise((resolve, reject) => {
    active++
    const child = spawn(python, ['-I', '-B', '-X', 'utf8', join(__dirname, 'speech_worker.py'), file], {
      cwd: __dirname, env: { ...process.env, APP_DATA_DIR: dataDir }, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = '', stderr = '', failure, stopping = false
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8')
    const stop = reason => {
      failure ||= reason
      if (stopping || child.exitCode !== null || child.signalCode || !child.pid) return
      stopping = true
      if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => { if (child.exitCode === null && !child.signalCode) child.kill() })
      else { try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill() } }
    }
    const abort = () => stop(Error('ASR_CANCELLED'))
    const timer = setTimeout(() => stop(Error('ASR_WORKER_TIMEOUT')), timeout)
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    child.stdout?.on('data', bytes => { stdout += bytes.toString(); if (Buffer.byteLength(stdout) > 32768) { stdout = stdout.slice(-32768); stop(Error('ASR_OUTPUT_LIMIT')) } })
    child.stderr?.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-1600) })
    child.once('error', error => { failure ||= error })
    child.once('close', code => {
      active--; clearTimeout(timer); options.signal?.removeEventListener('abort', abort)
      if (failure) { reject(failure); return }
      try {
        const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) || '{}')
        if (code !== 0 || result.ok !== true || typeof result.text !== 'string') throw Error(result.error || stderr || 'ASR_WORKER_INVALID_RESULT')
        resolve(result.text)
      } catch (failure) { reject(failure) }
    })
  })
}
