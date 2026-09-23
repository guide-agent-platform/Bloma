#!/usr/bin/env node
/**
 * probe-audio.cjs — Bloma 音频能力边界探针（路线 B，2026-09-06）
 *
 * 在真实 Electron 环境里实测：
 *   1) window.SpeechRecognition 存在性 + start() 真实行为（onstart / onerror / 挂起）
 *   2) 加权限 handler 后 getUserMedia({audio:true}) 能否拿到真实麦克风流
 *   3) 系统麦克风设备枚举（audioinput 数量）
 *
 * 复现 Bloma 主进程 configureMediaPermissions 的授权逻辑（仅 localhost 来源的 media 权限）。
 * 探针页面跑在 http://127.0.0.1:<随机端口>。getUserMedia 与 SpeechRecognition 均加 2s 超时防挂起。
 * 用法：npx electron scripts/probe-audio.cjs
 */
const { app, BrowserWindow, session } = require('electron')
const http = require('node:http')

const PROBE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Bloma 音频能力探针</title></head>
<body style="font-family:monospace;padding:24px">
<h3>Bloma 音频能力探针（Electron 环境）</h3>
<pre id="out">检测中…</pre>
<script>
;(function () {
  var r = {
    userAgent: navigator.userAgent,
    isSecureContext: window.isSecureContext,
    hasSpeechRecognition: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
    hasSpeechSynthesis: ('speechSynthesis' in window),
    hasMediaDevices: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    getUserMedia: 'pending',
    speechRecognitionStart: 'pending',
    audioInputDevices: 'pending'
  }
  window.__PROBE__ = r
  var render = function () { document.getElementById('out').textContent = JSON.stringify(r, null, 2) }
  render()

  // 1) 枚举麦克风设备
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    navigator.mediaDevices.enumerateDevices().then(function (devs) {
      r.audioInputDevices = devs.filter(function (d) { return d.kind === 'audioinput' }).length
      window.__PROBE__ = r; render()
    }).catch(function (e) {
      r.audioInputDevices = 'ERROR: ' + e.message
      window.__PROBE__ = r; render()
    })
  } else {
    r.audioInputDevices = 'n/a'
  }

  // 2) getUserMedia 真实拿流（2s 超时防挂起）
  if (r.hasMediaDevices) {
    var timeout = new Promise(function (_res, rej) { setTimeout(function () { rej(new Error('timeout after 2s')) }, 2000) })
    Promise.race([navigator.mediaDevices.getUserMedia({ audio: true }), timeout])
      .then(function (stream) {
        r.getUserMedia = 'OK: audioTracks=' + stream.getAudioTracks().length
        stream.getTracks().forEach(function (t) { t.stop() })
      })
      .catch(function (e) {
        r.getUserMedia = 'ERROR: ' + (e && e.name ? e.name + ' - ' : '') + (e && e.message ? e.message : String(e))
      })
      .finally(function () { window.__PROBE__ = r; render() })
  } else {
    r.getUserMedia = 'n/a'
  }

  // 3) SpeechRecognition.start() 真实行为（存在性之外，验证能否真开始识别）
  try {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (SR) {
      var rec = new SR()
      rec.lang = 'zh-CN'
      rec.continuous = false
      rec.interimResults = false
      rec.onstart = function () { r.speechRecognitionStart = 'onstart（开始监听）'; window.__PROBE__ = r; render() }
      rec.onerror = function (e) { r.speechRecognitionStart = 'onerror: ' + e.error; window.__PROBE__ = r; render() }
      rec.onend = function () {
        if (r.speechRecognitionStart === 'pending') { r.speechRecognitionStart = 'onend（无 onstart/onerror 即结束）'; window.__PROBE__ = r; render() }
      }
      rec.start()
      setTimeout(function () {
        if (r.speechRecognitionStart === 'pending') { r.speechRecognitionStart = 'timeout(2s)（start 后无任何回调）'; window.__PROBE__ = r; render() }
      }, 2000)
    } else {
      r.speechRecognitionStart = 'n/a（无 SpeechRecognition）'
    }
  } catch (e) {
    r.speechRecognitionStart = 'throw: ' + e.message
    window.__PROBE__ = r; render()
  }
})()
</script>
</body></html>`

const isLocalUrl = (url) => {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
  } catch {
    return false
  }
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(PROBE_HTML)
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

app.whenReady().then(async () => {
  // 复现主进程 configureMediaPermissions 的授权逻辑
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const requestingUrl = (details && details.requestingUrl) || ''
    const allow = permission === 'media' && isLocalUrl(requestingUrl)
    console.log('[permission-request]', permission, 'requestingUrl=' + requestingUrl, '=>', allow)
    callback(allow)
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    const allow = permission === 'media' && isLocalUrl(requestingOrigin)
    console.log('[permission-check]', permission, 'origin=' + requestingOrigin, '=>', allow)
    return allow
  })

  const server = await startServer()
  const url = 'http://127.0.0.1:' + server.address().port

  const win = new BrowserWindow({
    width: 680,
    height: 540,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })

  win.webContents.on('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 4500))
    const result = await win.webContents.executeJavaScript('window.__PROBE__').catch((e) => ({ fatal: String(e) }))
    console.log('\n===== PROBE RESULT =====')
    console.log(JSON.stringify(result, null, 2))
    console.log('========================')
    server.close()
    app.exit(0)
  })

  await win.loadURL(url)
})
