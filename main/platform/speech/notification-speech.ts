import { spawn, type ChildProcess } from 'node:child_process'

// Text is JSON on stdin, never interpolated into executable PowerShell source.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$notificationInput = [Console]::In.ReadToEnd() | ConvertFrom-Json
$notificationSpeaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $notificationVoice = $notificationSpeaker.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh-*' } | Select-Object -First 1
  if ($null -eq $notificationVoice) { throw '未安装 Windows 中文嗓音' }
  $notificationSpeaker.SelectVoice($notificationVoice.VoiceInfo.Name)
  $notificationSpeaker.Volume = [int]$notificationInput.volume
  $notificationSpeaker.Speak([string]$notificationInput.text)
} finally { $notificationSpeaker.Dispose() }
`
const ENCODED_SCRIPT = Buffer.from(SCRIPT, 'utf16le').toString('base64')
let active: ChildProcess | undefined

export function speakNotification(text: unknown, volume: unknown): Promise<{ spoken: boolean }> {
  if (typeof text !== 'string' || !text.trim() || text.length > 300) throw new Error('VALIDATION_ERROR: 播报文字需为 1–300 字文本')
  if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error('VALIDATION_ERROR: 播报音量需在 0–1 之间')
  if (process.platform !== 'win32') throw new Error('当前平台没有 Windows 本地播报引擎')
  active?.kill()
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_SCRIPT], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
    active = child
    let error = '', settled = false
    const finish = (failure?: Error) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (active === child) active = undefined
      if (failure) { child.kill(); reject(failure) } else resolve({ spoken: true })
    }
    const timer = setTimeout(() => { child.kill(); finish(new Error('本地语音播报超时，请重试')) }, 30_000)
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', chunk => { error = (error + chunk).slice(-1000) })
    child.once('error', () => finish(new Error('本地语音引擎无法启动')))
    child.once('close', (code) => finish(code === 0 ? undefined : new Error(error.includes('中文嗓音') ? '未安装 Windows 中文嗓音' : '本地语音播报未完成，请重试')))
    child.stdin?.on('error', () => finish(new Error('本地语音引擎无法接收文字')))
    child.stdin?.end(JSON.stringify({ text: text.trim(), volume: Math.round(volume * 100) }))
  })
}
